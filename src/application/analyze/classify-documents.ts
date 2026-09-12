/**
 * ClassifyDocuments (PIPELINES_AND_POLICIES.md §3, §5).
 * cluster 대표 문서를 편집 카테고리로 분류한다. LLM 출력은 전부 검증 후에만 저장한다.
 */
import type { NormalizedDocument } from "../../domain/documents/normalized-document.js";
import {
  EDITORIAL_CATEGORIES,
  type AnalysisRecord,
  type Classification,
  type EditorialCategory,
} from "../../domain/evidence/analysis.js";
import { analysisId, payloadHashOf } from "../../domain/shared/ids.js";
import type { ClaimStore } from "../../ports/storage/index.js";
import type { LlmProvider, LlmRequest } from "../../ports/llm/llm-provider.js";
import type { Clock, Logger, RandomSource } from "../../ports/system/index.js";
import { CLASSIFY_AUDIENCES, CLASSIFY_POLICY_VERSION, CLASSIFY_PROMPT } from "./prompts/classify.js";
import { emptyAnalyzeSummary, type AnalyzeSummary } from "./analyze-summary.js";
import {
  analysisCacheKey,
  asArray,
  chunk,
  clamp01,
  documentDigest,
  documentInputHash,
  errorSummary,
  isRecordValue,
  llmProvenance,
  usageEntry,
} from "./support.js";

export const CLASSIFY_BATCH_SIZE = 20;
const MAX_CONTENT_CHARS = 2400;
const MAX_CATEGORIES = 3;

export type ClassifyClaimStore = Pick<
  ClaimStore,
  "putAnalysis" | "findAnalysisByCacheKey" | "putClassification" | "classificationsFor"
>;

export interface ClassifyDocumentsDeps {
  claims: ClassifyClaimStore;
  llm: LlmProvider;
  /** 라우팅 결과 model id. "default" 면 provider 기본 모델. */
  model: string;
  clock: Clock;
  logger?: Logger;
  random?: RandomSource;
  batchSize?: number;
}

export interface ClassifyDocumentsInput {
  runId: string;
  documents: NormalizedDocument[];
  /** 이번 Run 에서 허용하는 LLM 호출 수. 소진되면 PARTIAL 로 끝낸다. */
  maxCallsPerRun?: number;
  signal?: AbortSignal;
}

export interface ClassifyDocumentsResult extends AnalyzeSummary {
  classifications: Classification[];
  policyVersion: string;
}

interface ParsedItem {
  documentId: string;
  categories: { category: EditorialCategory; confidence: number }[];
  audience: Classification["audience"];
}

export class ClassifyDocuments {
  constructor(private readonly deps: ClassifyDocumentsDeps) {}

  async execute(input: ClassifyDocumentsInput): Promise<ClassifyDocumentsResult> {
    const summary = emptyAnalyzeSummary();
    const classifications: Classification[] = [];
    const batches = chunk(input.documents, this.deps.batchSize ?? CLASSIFY_BATCH_SIZE);
    const signal = input.signal ?? new AbortController().signal;
    const promptVersion = `${CLASSIFY_PROMPT.promptId}.${CLASSIFY_PROMPT.promptVersion}`;
    let succeeded = 0;
    let failed = 0;
    let exhausted = false;

    for (const batch of batches) {
      const cacheKey = analysisCacheKey("CLASSIFY", promptVersion, this.deps.model, documentInputHash(batch));
      const cached = await this.deps.claims.findAnalysisByCacheKey(cacheKey);
      if (cached && cached.status !== "FAILED") {
        summary.cacheHits += 1;
        summary.analysisIds.push(cached.id);
        const stored = await this.deps.claims.classificationsFor(
          batch.map((document) => document.id),
          CLASSIFY_POLICY_VERSION,
        );
        classifications.push(...stored);
        succeeded += 1;
        continue;
      }

      if (input.maxCallsPerRun !== undefined && summary.llmCalls >= input.maxCallsPerRun) {
        exhausted = true;
        summary.notes.push(`LLM call budget exhausted; ${batches.length - succeeded - failed} classify batch(es) skipped`);
        break;
      }

      const request: LlmRequest = {
        task: "CLASSIFY",
        promptId: CLASSIFY_PROMPT.promptId,
        promptVersion: CLASSIFY_PROMPT.promptVersion,
        system: CLASSIFY_PROMPT.system,
        untrusted: batch.map((document) => ({ id: document.id, text: documentDigest(document, MAX_CONTENT_CHARS) })),
        outputSchema: CLASSIFY_PROMPT.outputSchema,
        maxOutputTokens: CLASSIFY_PROMPT.maxOutputTokens,
        temperature: CLASSIFY_PROMPT.temperature,
      };

      const createdAt = this.deps.clock.nowIso();
      const recordId = analysisId(this.deps.clock.nowMs(), this.random);
      const inputDocumentIds = batch.map((document) => document.id);
      let record: AnalysisRecord;
      try {
        summary.llmCalls += 1;
        const response = await this.deps.llm.complete(request, this.deps.model, signal);
        summary.usage.push(usageEntry(response));
        const parsed = parseClassifyOutput(response.json, new Set(inputDocumentIds));
        const provenance = llmProvenance({
          promptId: CLASSIFY_PROMPT.promptId,
          promptVersion: CLASSIFY_PROMPT.promptVersion,
          model: response.model,
          provider: response.provider,
          runId: input.runId,
          createdAt,
        });
        const batchClassifications: Classification[] = parsed.items.map((item) => ({
          documentId: item.documentId,
          categories: item.categories,
          audience: item.audience,
          provenance,
        }));
        record = {
          schemaVersion: 1,
          id: recordId,
          task: "CLASSIFY",
          inputDocumentIds,
          inputEvidenceIds: [],
          provenance,
          usage: response.usage,
          outputHash: payloadHashOf(parsed.items),
          validation: {
            schemaOk: parsed.schemaOk,
            evidenceOk: true,
            rejectedItems: parsed.rejected,
            notes: parsed.notes,
          },
          status: batchClassifications.length > 0 ? (parsed.rejected > 0 ? "PARTIAL" : "SUCCEEDED") : "FAILED",
          cacheKey,
        };
        await this.deps.claims.putAnalysis(record);
        for (const classification of batchClassifications) {
          await this.deps.claims.putClassification(classification, CLASSIFY_POLICY_VERSION);
        }
        classifications.push(...batchClassifications);
        summary.analysisIds.push(record.id);
        summary.rejectedItems += parsed.rejected;
        summary.notes.push(...parsed.notes);
        if (batchClassifications.length > 0) succeeded += 1;
        else failed += 1;
      } catch (error) {
        failed += 1;
        const note = errorSummary(error);
        summary.notes.push(`classify batch failed: ${note}`);
        this.deps.logger?.warn("classify batch failed", { provider: this.deps.llm.id, model: this.deps.model, note });
        record = {
          schemaVersion: 1,
          id: recordId,
          task: "CLASSIFY",
          inputDocumentIds,
          inputEvidenceIds: [],
          provenance: llmProvenance({
            promptId: CLASSIFY_PROMPT.promptId,
            promptVersion: CLASSIFY_PROMPT.promptVersion,
            model: this.deps.model,
            provider: this.deps.llm.id,
            runId: input.runId,
            createdAt,
          }),
          usage: null,
          outputHash: "",
          validation: { schemaOk: false, evidenceOk: false, rejectedItems: 0, notes: [note] },
          status: "FAILED",
          cacheKey,
        };
        await this.deps.claims.putAnalysis(record);
      }
    }

    summary.status = decideStatus({ total: batches.length, succeeded, failed, exhausted });
    return { ...summary, classifications, policyVersion: CLASSIFY_POLICY_VERSION };
  }

  private get random(): ((bytes: number) => Uint8Array) | undefined {
    const source = this.deps.random;
    return source ? (bytes: number) => source.bytes(bytes) : undefined;
  }
}

export function decideStatus(input: {
  total: number;
  succeeded: number;
  failed: number;
  exhausted: boolean;
}): AnalyzeSummary["status"] {
  if (input.total === 0) return "SUCCEEDED";
  if (input.succeeded === 0) return "FAILED";
  if (input.failed > 0 || input.exhausted || input.succeeded < input.total) return "PARTIAL";
  return "SUCCEEDED";
}

export interface ParsedClassifyOutput {
  items: ParsedItem[];
  rejected: number;
  notes: string[];
  schemaOk: boolean;
}

/** LLM 출력 검증 (PIPELINES §5.2). 알 수 없는 documentId·카테고리는 항목째 거부한다. */
export function parseClassifyOutput(json: unknown, allowedDocumentIds: ReadonlySet<string>): ParsedClassifyOutput {
  const notes: string[] = [];
  let rejected = 0;
  if (!isRecordValue(json) || !Array.isArray(json.items)) {
    return { items: [], rejected: 0, notes: ["output is not an object with items[]"], schemaOk: false };
  }
  const seen = new Set<string>();
  const items: ParsedItem[] = [];
  for (const raw of asArray(json.items)) {
    if (!isRecordValue(raw)) {
      rejected += 1;
      notes.push("item is not an object");
      continue;
    }
    const documentId = typeof raw.documentId === "string" ? raw.documentId : "";
    if (!allowedDocumentIds.has(documentId)) {
      rejected += 1;
      notes.push(`unknown documentId rejected`);
      continue;
    }
    if (seen.has(documentId)) {
      rejected += 1;
      notes.push(`duplicate classification for ${documentId} rejected`);
      continue;
    }
    const audience = raw.audience;
    if (typeof audience !== "string" || !(CLASSIFY_AUDIENCES as readonly string[]).includes(audience)) {
      rejected += 1;
      notes.push(`invalid audience for ${documentId} rejected`);
      continue;
    }
    const categories: { category: EditorialCategory; confidence: number }[] = [];
    for (const rawCategory of asArray(raw.categories)) {
      if (!isRecordValue(rawCategory)) continue;
      const category = rawCategory.category;
      if (typeof category !== "string" || !(EDITORIAL_CATEGORIES as readonly string[]).includes(category)) continue;
      if (categories.some((existing) => existing.category === category)) continue;
      const confidence = typeof rawCategory.confidence === "number" ? clamp01(rawCategory.confidence) : 0;
      categories.push({ category: category as EditorialCategory, confidence });
      if (categories.length >= MAX_CATEGORIES) break;
    }
    if (categories.length === 0) {
      rejected += 1;
      notes.push(`no valid category for ${documentId}; item rejected`);
      continue;
    }
    seen.add(documentId);
    items.push({ documentId, categories, audience: audience as Classification["audience"] });
  }
  return { items, rejected, notes, schemaOk: true };
}

/** classification 의 대표 카테고리 (가장 높은 confidence). */
export function primaryCategory(classification: Classification | null): EditorialCategory | null {
  if (!classification || classification.categories.length === 0) return null;
  let best = classification.categories[0]!;
  for (const candidate of classification.categories) {
    if (candidate.confidence > best.confidence) best = candidate;
  }
  return best.category;
}
