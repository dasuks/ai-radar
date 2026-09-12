/**
 * ExtractClaims (PIPELINES_AND_POLICIES.md §3, §5, CONTRACTS §4.2).
 *
 * 1) LLM 호출 전에 Evidence 후보를 결정적으로 만들고 저장한다.
 * 2) LLM 은 그 evidence id 만 인용할 수 있고, 검증이 이를 강제한다.
 * 3) Entity 는 결정적 부분(github repo URL)만 자동 생성하고 나머지는 UNRESOLVED mention 으로 남긴다 (§3.3).
 */
import type { NormalizedDocument } from "../../domain/documents/normalized-document.js";
import type { AnalysisRecord } from "../../domain/evidence/analysis.js";
import {
  CLAIM_TYPES,
  SENTIMENTS,
  claimViolations,
  statementHasUnbackedNumbers,
  type Claim,
  type ClaimType,
  type Sentiment,
} from "../../domain/evidence/claim.js";
import type { Evidence } from "../../domain/evidence/evidence.js";
import {
  normalizeEntityName,
  normalizeRepositoryUrl,
  type Entity,
  type EntityMention,
} from "../../domain/entities/entity.js";
import { analysisId, claimId, entityId, payloadHashOf } from "../../domain/shared/ids.js";
import type { LlmProvider, LlmRequest } from "../../ports/llm/llm-provider.js";
import type { ClaimStore, EntityStore } from "../../ports/storage/index.js";
import type { Clock, Logger, RandomSource } from "../../ports/system/index.js";
import { decideVisibility } from "../../policies/classification/visibility.js";
import { EXTRACT_CLAIMS_PROMPT, EXTRACTABLE_CLAIM_TYPES } from "./prompts/extract-claims.js";
import { emptyAnalyzeSummary, type AnalyzeSummary } from "./analyze-summary.js";
import { buildEvidenceForDocument, evidencePromptText } from "./evidence-builder.js";
import { decideStatus } from "./classify-documents.js";
import {
  analysisCacheKey,
  asArray,
  chunk,
  clamp01,
  documentInputHash,
  errorSummary,
  isRecordValue,
  llmProvenance,
  truncate,
  usageEntry,
} from "./support.js";

export const EXTRACT_CLAIMS_BATCH_SIZE = 8;
const MAX_STATEMENT_CHARS = 400;

export type ExtractClaimsClaimStore = Pick<
  ClaimStore,
  "putEvidence" | "putAnalysis" | "findAnalysisByCacheKey" | "putClaims" | "claimsByAnalysis"
>;
export type ExtractClaimsEntityStore = Pick<EntityStore, "findByRepositoryUrl" | "upsert" | "upsertMention">;

export interface ExtractClaimsDeps {
  claims: ExtractClaimsClaimStore;
  entities: ExtractClaimsEntityStore;
  llm: LlmProvider;
  model: string;
  clock: Clock;
  logger?: Logger;
  random?: RandomSource;
  batchSize?: number;
}

export interface ExtractClaimsInput {
  runId: string;
  documents: NormalizedDocument[];
  maxCallsPerRun?: number;
  signal?: AbortSignal;
}

export interface ExtractClaimsResult extends AnalyzeSummary {
  claims: Claim[];
  evidence: Evidence[];
  /** documentId → 이 Run 에서 확정된 REPOSITORY entity id 목록 */
  entityIdsByDocument: Record<string, string[]>;
}

interface ParsedClaim {
  documentId: string;
  type: ClaimType;
  statement: string;
  evidenceIds: string[];
  subjectSurfaceForms: string[];
  sentiment: Sentiment;
  confidence: number;
}

export class ExtractClaims {
  constructor(private readonly deps: ExtractClaimsDeps) {}

  async execute(input: ExtractClaimsInput): Promise<ExtractClaimsResult> {
    const summary = emptyAnalyzeSummary();
    const signal = input.signal ?? new AbortController().signal;
    const promptVersion = `${EXTRACT_CLAIMS_PROMPT.promptId}.${EXTRACT_CLAIMS_PROMPT.promptVersion}`;

    const evidenceByDocument = new Map<string, Evidence[]>();
    const allEvidence: Evidence[] = [];
    for (const document of input.documents) {
      const evidence = buildEvidenceForDocument(document);
      evidenceByDocument.set(document.id, evidence);
      allEvidence.push(...evidence);
    }
    if (allEvidence.length > 0) await this.deps.claims.putEvidence(allEvidence);

    const entityIdsByDocument: Record<string, string[]> = {};
    for (const document of input.documents) {
      entityIdsByDocument[document.id] = await this.resolveDocumentRepository(document, input.runId);
    }

    const batches = chunk(input.documents, this.deps.batchSize ?? EXTRACT_CLAIMS_BATCH_SIZE);
    const claims: Claim[] = [];
    let succeeded = 0;
    let failed = 0;
    let exhausted = false;

    for (const batch of batches) {
      const batchEvidence = batch.flatMap((document) => evidenceByDocument.get(document.id) ?? []);
      const cacheKey = analysisCacheKey(
        "EXTRACT_CLAIMS",
        promptVersion,
        this.deps.model,
        documentInputHash(batch, batchEvidence.map((evidence) => evidence.id)),
      );
      const cached = await this.deps.claims.findAnalysisByCacheKey(cacheKey);
      if (cached && cached.status !== "FAILED") {
        summary.cacheHits += 1;
        summary.analysisIds.push(cached.id);
        claims.push(...(await this.deps.claims.claimsByAnalysis(cached.id)));
        succeeded += 1;
        continue;
      }

      if (input.maxCallsPerRun !== undefined && summary.llmCalls >= input.maxCallsPerRun) {
        exhausted = true;
        summary.notes.push(`LLM call budget exhausted; ${batches.length - succeeded - failed} claim batch(es) skipped`);
        break;
      }

      const request: LlmRequest = {
        task: "EXTRACT_CLAIMS",
        promptId: EXTRACT_CLAIMS_PROMPT.promptId,
        promptVersion: EXTRACT_CLAIMS_PROMPT.promptVersion,
        system: EXTRACT_CLAIMS_PROMPT.system,
        untrusted: batch.map((document) => ({
          id: document.id,
          text: documentEvidenceBlock(document, evidenceByDocument.get(document.id) ?? []),
        })),
        outputSchema: EXTRACT_CLAIMS_PROMPT.outputSchema,
        maxOutputTokens: EXTRACT_CLAIMS_PROMPT.maxOutputTokens,
        temperature: EXTRACT_CLAIMS_PROMPT.temperature,
      };

      const createdAt = this.deps.clock.nowIso();
      const recordId = analysisId(this.deps.clock.nowMs(), this.random);
      const inputDocumentIds = batch.map((document) => document.id);
      const inputEvidenceIds = batchEvidence.map((evidence) => evidence.id);
      try {
        summary.llmCalls += 1;
        const response = await this.deps.llm.complete(request, this.deps.model, signal);
        summary.usage.push(usageEntry(response));
        const allowedByDocument = new Map<string, Set<string>>();
        for (const document of batch) {
          allowedByDocument.set(
            document.id,
            new Set((evidenceByDocument.get(document.id) ?? []).map((evidence) => evidence.id)),
          );
        }
        const parsed = parseExtractClaimsOutput(response.json, allowedByDocument);
        const provenance = llmProvenance({
          promptId: EXTRACT_CLAIMS_PROMPT.promptId,
          promptVersion: EXTRACT_CLAIMS_PROMPT.promptVersion,
          model: response.model,
          provider: response.provider,
          runId: input.runId,
          createdAt,
        });
        const knownEvidenceIds = new Set(inputEvidenceIds);
        const documentsById = new Map(batch.map((document) => [document.id, document] as const));

        const accepted: Claim[] = [];
        let rejected = parsed.rejected;
        const notes = [...parsed.notes];
        for (const candidate of parsed.claims) {
          const document = documentsById.get(candidate.documentId);
          if (!document) {
            rejected += 1;
            continue;
          }
          const claim: Claim = {
            schemaVersion: 1,
            id: claimId(this.deps.clock.nowMs(), this.random),
            type: candidate.type,
            statement: candidate.statement,
            statementLanguage: "ko",
            subjectEntityIds: [],
            evidenceIds: candidate.evidenceIds,
            signalRefs: [],
            confidence: candidate.confidence,
            sentiment: candidate.sentiment,
            visibility: decideVisibility({
              documentUrl: document.canonicalUrl ?? document.urls[0] ?? null,
              claimType: candidate.type,
            }),
            status: "ACTIVE",
            supersededById: null,
            analysisId: recordId,
            provenance,
          };
          const violations = claimViolations(claim, knownEvidenceIds);
          // metric evidence 와 DerivedSignal 은 아직 없으므로 숫자가 든 문장은 전부 거부한다.
          if (statementHasUnbackedNumbers(claim.statement, false, false)) {
            violations.push("statement contains numbers without metric evidence");
          }
          if (violations.length > 0) {
            rejected += 1;
            notes.push(`claim rejected: ${violations.join("; ")}`);
            continue;
          }
          claim.subjectEntityIds = await this.resolveSubjects(
            document,
            candidate.subjectSurfaceForms,
            entityIdsByDocument[document.id] ?? [],
            input.runId,
            createdAt,
          );
          accepted.push(claim);
        }

        const record: AnalysisRecord = {
          schemaVersion: 1,
          id: recordId,
          task: "EXTRACT_CLAIMS",
          inputDocumentIds,
          inputEvidenceIds,
          provenance,
          usage: response.usage,
          outputHash: payloadHashOf(accepted.map((claim) => ({ ...claim, id: "" }))),
          validation: {
            schemaOk: parsed.schemaOk,
            evidenceOk: rejected === 0,
            rejectedItems: rejected,
            notes,
          },
          status: accepted.length > 0 ? (rejected > 0 ? "PARTIAL" : "SUCCEEDED") : "FAILED",
          cacheKey,
        };
        await this.deps.claims.putAnalysis(record);
        if (accepted.length > 0) await this.deps.claims.putClaims(accepted);
        claims.push(...accepted);
        summary.analysisIds.push(record.id);
        summary.rejectedItems += rejected;
        summary.notes.push(...notes);
        if (accepted.length > 0) succeeded += 1;
        else failed += 1;
      } catch (error) {
        failed += 1;
        const note = errorSummary(error);
        summary.notes.push(`extract claims batch failed: ${note}`);
        this.deps.logger?.warn("extract claims batch failed", {
          provider: this.deps.llm.id,
          model: this.deps.model,
          note,
        });
        await this.deps.claims.putAnalysis({
          schemaVersion: 1,
          id: recordId,
          task: "EXTRACT_CLAIMS",
          inputDocumentIds,
          inputEvidenceIds,
          provenance: llmProvenance({
            promptId: EXTRACT_CLAIMS_PROMPT.promptId,
            promptVersion: EXTRACT_CLAIMS_PROMPT.promptVersion,
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
        });
      }
    }

    summary.status = decideStatus({ total: batches.length, succeeded, failed, exhausted });
    return { ...summary, claims, evidence: allEvidence, entityIdsByDocument };
  }

  /** 문서 URL 이 github repo 면 REPOSITORY entity 를 결정적으로 만든다. */
  private async resolveDocumentRepository(document: NormalizedDocument, runId: string): Promise<string[]> {
    const repositoryUrl = repositoryUrlOf(document);
    if (!repositoryUrl) return [];
    const entity = await this.upsertRepository(repositoryUrl, runId);
    return [entity.id];
  }

  private async upsertRepository(repositoryUrl: string, _runId: string): Promise<Entity> {
    const existing = await this.deps.entities.findByRepositoryUrl(repositoryUrl);
    if (existing) return existing;
    const now = this.deps.clock.nowIso();
    const entity: Entity = {
      schemaVersion: 1,
      id: entityId(this.deps.clock.nowMs(), this.random),
      type: "REPOSITORY",
      canonicalName: repositoryNameOf(repositoryUrl),
      aliases: [],
      officialUrl: null,
      repositoryUrl,
      ecosystem: null,
      parentEntityId: null,
      versionLabel: null,
      identityConfidence: 1,
      status: "ACTIVE",
      mergedIntoId: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.entities.upsert(entity);
    return entity;
  }

  /**
   * surfaceForm → entity. github repo URL 로 확정되는 것만 entity 를 만들고,
   * 나머지는 UNRESOLVED mention 으로 남긴다 (사람이 확정한다).
   */
  private async resolveSubjects(
    document: NormalizedDocument,
    surfaceForms: string[],
    documentEntityIds: string[],
    runId: string,
    createdAt: string,
  ): Promise<string[]> {
    const ids = new Set<string>(documentEntityIds);
    const documentRepository = repositoryUrlOf(document);
    for (const surfaceForm of surfaceForms) {
      const direct = normalizeRepositoryUrl(surfaceForm);
      if (direct) {
        const entity = await this.upsertRepository(direct, runId);
        ids.add(entity.id);
        continue;
      }
      if (documentRepository && matchesRepositoryName(surfaceForm, documentRepository)) {
        const entity = await this.upsertRepository(documentRepository, runId);
        ids.add(entity.id);
        continue;
      }
      const mention: EntityMention = {
        documentId: document.id,
        entityId: null,
        surfaceForm,
        resolution: "UNRESOLVED",
        candidateEntityIds: [],
        confidence: 0,
        locatorKey: "document",
        provenance: {
          method: "RULE",
          policyId: "entities.deterministic",
          policyVersion: "1.0.0",
          runId,
          createdAt,
        },
      };
      await this.deps.entities.upsertMention(mention);
    }
    return [...ids];
  }

  private get random(): ((bytes: number) => Uint8Array) | undefined {
    const source = this.deps.random;
    return source ? (bytes: number) => source.bytes(bytes) : undefined;
  }
}

/** 문서의 canonicalUrl/urls 중 github repo 정규형. */
export function repositoryUrlOf(document: NormalizedDocument): string | null {
  const candidates = [document.canonicalUrl, ...document.urls];
  for (const candidate of candidates) {
    const normalized = normalizeRepositoryUrl(candidate);
    if (normalized) return normalized;
  }
  return null;
}

export function repositoryNameOf(repositoryUrl: string): string {
  return repositoryUrl.replace(/^https?:\/\/github\.com\//i, "");
}

function matchesRepositoryName(surfaceForm: string, repositoryUrl: string): boolean {
  const name = repositoryNameOf(repositoryUrl);
  const normalizedSurface = normalizeEntityName(surfaceForm);
  const parts = name.split("/");
  return normalizedSurface === normalizeEntityName(name) || normalizedSurface === normalizeEntityName(parts[1] ?? "");
}

/** 한 문서의 비신뢰 블록: 인용 가능한 evidence 단위만 담는다. */
export function documentEvidenceBlock(document: NormalizedDocument, evidence: readonly Evidence[]): string {
  const lines = [`context title (not citable): ${document.title}`];
  for (const item of evidence) {
    lines.push(`<evidence id="${item.id}">${evidencePromptText(item, document)}</evidence>`);
  }
  return lines.join("\n");
}

export interface ParsedExtractClaimsOutput {
  claims: ParsedClaim[];
  rejected: number;
  notes: string[];
  schemaOk: boolean;
}

/**
 * LLM 출력 검증 (PIPELINES §5.2). documentId 와 evidenceId 는 그 문서에 실제로 보여준 것만 허용한다.
 * claim 자체의 불변 조건(§4.2)은 Claim 을 만든 뒤 `claimViolations` 가 다시 검사한다.
 */
export function parseExtractClaimsOutput(
  json: unknown,
  allowedEvidenceByDocument: ReadonlyMap<string, ReadonlySet<string>>,
): ParsedExtractClaimsOutput {
  const notes: string[] = [];
  let rejected = 0;
  if (!isRecordValue(json) || !Array.isArray(json.claims)) {
    return { claims: [], rejected: 0, notes: ["output is not an object with claims[]"], schemaOk: false };
  }
  const claims: ParsedClaim[] = [];
  for (const raw of asArray(json.claims)) {
    if (!isRecordValue(raw)) {
      rejected += 1;
      notes.push("claim is not an object");
      continue;
    }
    const documentId = typeof raw.documentId === "string" ? raw.documentId : "";
    const allowed = allowedEvidenceByDocument.get(documentId);
    if (!allowed) {
      rejected += 1;
      notes.push("claim with unknown documentId rejected");
      continue;
    }
    const type = raw.type;
    if (
      typeof type !== "string" ||
      !(CLAIM_TYPES as readonly string[]).includes(type) ||
      !(EXTRACTABLE_CLAIM_TYPES as readonly string[]).includes(type)
    ) {
      rejected += 1;
      notes.push(`claim with invalid type rejected for ${documentId}`);
      continue;
    }
    const statement = typeof raw.statement === "string" ? raw.statement.trim() : "";
    if (!statement) {
      rejected += 1;
      notes.push(`claim with empty statement rejected for ${documentId}`);
      continue;
    }
    const evidenceIds: string[] = [];
    let unknownEvidence = false;
    for (const value of asArray(raw.evidenceIds)) {
      if (typeof value !== "string") continue;
      if (!allowed.has(value)) {
        unknownEvidence = true;
        break;
      }
      if (!evidenceIds.includes(value)) evidenceIds.push(value);
    }
    if (unknownEvidence) {
      rejected += 1;
      notes.push(`claim citing evidence outside ${documentId} rejected`);
      continue;
    }
    if (evidenceIds.length === 0) {
      rejected += 1;
      notes.push(`claim without evidence rejected for ${documentId}`);
      continue;
    }
    const sentiment = raw.sentiment;
    const subjectSurfaceForms: string[] = [];
    for (const value of asArray(raw.subjectSurfaceForms)) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (trimmed && !subjectSurfaceForms.includes(trimmed)) subjectSurfaceForms.push(trimmed);
    }
    claims.push({
      documentId,
      type: type as ClaimType,
      statement: truncate(statement, MAX_STATEMENT_CHARS),
      evidenceIds,
      subjectSurfaceForms,
      sentiment:
        typeof sentiment === "string" && (SENTIMENTS as readonly string[]).includes(sentiment)
          ? (sentiment as Sentiment)
          : "UNKNOWN",
      confidence: typeof raw.confidence === "number" ? clamp01(raw.confidence) : 0.5,
    });
  }
  return { claims, rejected, notes, schemaOk: true };
}
