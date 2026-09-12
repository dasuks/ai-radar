/**
 * BuildDailyDigest (PIPELINES_AND_POLICIES.md §11, ADR-0009).
 *
 * 오늘 window 의 cluster 대표 문서를 **전부** 한 줄 제목 + 1~3문장 요약으로 싣는다.
 * LLM 이 한 story 를 빠뜨려도 결정적 fallback(원문 제목 + 첫 claim, 또는 "제목만 수집됨")으로 채운다.
 * 버려지는 이야기는 0개다.
 */
import {
  BRIEF_SECTION_KINDS,
  type BriefSectionKind,
  type RunCoverageSummary,
} from "../../domain/artifacts/daily-brief.js";
import {
  DAILY_DIGEST_BODY_SCHEMA_VERSION,
  type DailyDigestBody,
  type DigestStory,
} from "../../domain/artifacts/section-report.js";
import type { NormalizedDocument } from "../../domain/documents/normalized-document.js";
import type { Classification } from "../../domain/evidence/analysis.js";
import type { Claim } from "../../domain/evidence/claim.js";
import type { MetricKey } from "../../domain/metrics/metric-observation.js";
import type { LlmProvider, LlmRequest } from "../../ports/llm/llm-provider.js";
import type { Clock, Logger } from "../../ports/system/index.js";
import { practicalSectionOf } from "../../policies/practical/v1.js";
import { DIGEST_BATCH_SIZE, DIGEST_TITLE_ONLY_SUMMARY, WRITE_DIGEST_PROMPT } from "../analyze/prompts/write-digest.js";
import { asArray, chunk, errorSummary, isRecordValue, truncate, usageEntry } from "../analyze/support.js";
import type { AnalyzeUsageEntry } from "../analyze/analyze-summary.js";
import { collectClaims, type BriefCluster } from "../briefing/build-daily-brief.js";
import {
  clusterDocuments,
  discussionUrlOf,
  documentUrlOf,
  type ReportEntryIndex,
} from "./build-section-reports.js";

const MAX_STORY_TEXT_CHARS = 900;
const MAX_CLAIMS_PER_STORY = 3;
export const DAILY_DIGEST_TITLE_PREFIX = "오늘 들어온 이야기 전체";

export interface BuildDailyDigestDeps {
  llm: LlmProvider;
  model: string;
  clock: Clock;
  logger?: Logger;
}

export interface BuildDailyDigestInput {
  date: string;
  runId: string;
  clusters: BriefCluster[];
  classifications: Classification[];
  /** documentId → 그 문서의 ACTIVE claim */
  claimsByDocument: Record<string, Claim[]>;
  /** BuildSectionReports 의 결과. 상세 리포트에 실린 이야기에 링크를 건다 */
  entryIndex: ReportEntryIndex;
  coverage: RunCoverageSummary;
  maxCallsPerRun?: number;
  signal?: AbortSignal;
}

export interface BuildDailyDigestResult {
  body: DailyDigestBody;
  usage: AnalyzeUsageEntry[];
  notes: string[];
}

export interface DigestCandidate {
  document: NormalizedDocument;
  claims: Claim[];
  section: BriefSectionKind | null;
  reportEntryId: string | null;
}

export class BuildDailyDigest {
  constructor(private readonly deps: BuildDailyDigestDeps) {}

  async execute(input: BuildDailyDigestInput): Promise<BuildDailyDigestResult> {
    const notes: string[] = [];
    const usage: AnalyzeUsageEntry[] = [];
    const signal = input.signal ?? new AbortController().signal;
    const budget = input.maxCallsPerRun ?? Number.MAX_SAFE_INTEGER;

    const classificationByDocument = new Map(input.classifications.map((item) => [item.documentId, item] as const));
    const entryByDocument = documentToEntry(input.entryIndex);

    const candidates: DigestCandidate[] = input.clusters.map((cluster) => {
      const documents = clusterDocuments(cluster);
      const claims = collectClaims(documents, input.claimsByDocument);
      const link = entryByDocument.get(cluster.representative.id) ?? null;
      return {
        document: cluster.representative,
        claims,
        section: link?.section ?? sectionOf(classificationByDocument.get(cluster.representative.id) ?? null),
        reportEntryId: link?.entryId ?? null,
      };
    });

    const written = new Map<string, { titleKo: string; summary: string; importance: number }>();
    let calls = 0;
    for (const batch of chunk(candidates, DIGEST_BATCH_SIZE)) {
      if (calls >= budget) {
        notes.push(`LLM call budget reached; ${batch.length} story(ies) fall back to a deterministic summary`);
        break;
      }
      const request: LlmRequest = {
        task: "WRITE_DIGEST",
        promptId: WRITE_DIGEST_PROMPT.promptId,
        promptVersion: WRITE_DIGEST_PROMPT.promptVersion,
        system: WRITE_DIGEST_PROMPT.system,
        untrusted: batch.map((candidate) => ({ id: candidate.document.id, text: storyBlock(candidate) })),
        outputSchema: WRITE_DIGEST_PROMPT.outputSchema,
        maxOutputTokens: WRITE_DIGEST_PROMPT.maxOutputTokens,
        temperature: WRITE_DIGEST_PROMPT.temperature,
      };
      calls += 1;
      try {
        const response = await this.deps.llm.complete(request, this.deps.model, signal);
        usage.push(usageEntry(response));
        const parsed = parseDigestOutput(response.json, batch.map((candidate) => candidate.document.id));
        notes.push(...parsed.notes);
        for (const [documentId, story] of parsed.stories) written.set(documentId, story);
      } catch (error) {
        // 목록은 절대 비면 안 된다. 배치가 실패하면 그 배치만 fallback 으로 채운다.
        notes.push(`digest batch failed: ${errorSummary(error)}`);
      }
    }

    const stories: DigestStory[] = candidates.map((candidate) => {
      const model = written.get(candidate.document.id);
      if (!model) notes.push(`story ${candidate.document.id} used the deterministic fallback summary`);
      return digestStoryOf(candidate, model ?? null);
    });

    const body: DailyDigestBody = {
      bodySchemaVersion: DAILY_DIGEST_BODY_SCHEMA_VERSION,
      date: input.date,
      title: `${DAILY_DIGEST_TITLE_PREFIX} — ${input.date}`,
      stories: sortStories(stories),
      coverage: input.coverage,
    };
    this.deps.logger?.info("daily digest built", { stories: body.stories.length, calls, fallbacks: candidates.length - written.size });
    return { body, usage, notes };
  }
}

// --- 순수 헬퍼 -------------------------------------------------------------

/** documentId → 그 문서가 실린 리포트 항목 (primary 섹션 기준). */
export function documentToEntry(
  entryIndex: ReportEntryIndex,
): Map<string, { entryId: string; section: BriefSectionKind }> {
  const out = new Map<string, { entryId: string; section: BriefSectionKind }>();
  for (const [entryId, value] of entryIndex) {
    const section = value.sections[0];
    if (!section) continue;
    for (const source of value.entry.sourceRefs) {
      if (!out.has(source.documentId)) out.set(source.documentId, { entryId, section });
    }
  }
  return out;
}

/** classification 이 정하는 섹션. 실무 섹션이 없으면 CULTURE 후보, 그것도 없으면 null. */
export function sectionOf(classification: Classification | null): BriefSectionKind | null {
  const practical = practicalSectionOf(classification);
  if (practical) return practical;
  const culture = classification?.categories.find((entry) => entry.category === "CULTURE");
  return culture ? "CULTURE" : null;
}

function metricOf(document: NormalizedDocument, key: MetricKey): number | null {
  let best: number | null = null;
  for (const metric of document.metrics) {
    if (metric.key === key && (best === null || metric.value > best)) best = metric.value;
  }
  return best;
}

/** LLM 에 보여줄 story 블록 (비신뢰 텍스트). */
export function storyBlock(candidate: DigestCandidate): string {
  const document = candidate.document;
  const lines = [
    `title: ${document.title}`,
    `source: ${document.sourceId}`,
    `url: ${documentUrlOf(document)}`,
    `completeness: ${document.contentCompleteness}`,
  ];
  for (const claim of candidate.claims.slice(0, MAX_CLAIMS_PER_STORY)) {
    lines.push(`<claim id="${claim.id}">${claim.statement}</claim>`);
  }
  if (document.content && document.content.trim()) {
    lines.push("", truncate(document.content, MAX_STORY_TEXT_CHARS));
  }
  return lines.join("\n");
}

/** LLM 이 빠뜨렸을 때의 결정적 요약: 첫 claim statement, 없으면 "제목만 수집됨". */
export function fallbackSummary(candidate: DigestCandidate): string {
  const first = candidate.claims[0];
  if (first && first.statement.trim()) return first.statement.trim();
  const content = candidate.document.content;
  if (content && content.trim()) return truncate(content, 200);
  return DIGEST_TITLE_ONLY_SUMMARY;
}

export function digestStoryOf(
  candidate: DigestCandidate,
  written: { titleKo: string; summary: string; importance: number } | null,
): DigestStory {
  const document = candidate.document;
  return {
    documentId: document.id,
    titleKo: written?.titleKo ?? document.title,
    originalTitle: document.title,
    summary: written?.summary ?? fallbackSummary(candidate),
    section: candidate.section,
    evidenceLevel: document.contentCompleteness,
    url: documentUrlOf(document),
    discussionUrl: discussionUrlOf(document),
    sourceId: document.sourceId,
    metrics: { points: metricOf(document, "hn.points"), comments: metricOf(document, "hn.comments") },
    importance: written?.importance ?? (candidate.reportEntryId ? 3 : 2),
    reportEntryId: candidate.reportEntryId,
    publishedAt: document.publishedAt,
  };
}

/** 섹션 순서 → importance 내림차순 → documentId. 섹션 없는 이야기는 마지막. */
export function sortStories(stories: readonly DigestStory[]): DigestStory[] {
  const order = new Map<BriefSectionKind, number>(BRIEF_SECTION_KINDS.map((kind, index) => [kind, index] as const));
  return [...stories].sort((a, b) => {
    const left = a.section ? (order.get(a.section) ?? 99) : 99;
    const right = b.section ? (order.get(b.section) ?? 99) : 99;
    if (left !== right) return left - right;
    if (b.importance !== a.importance) return b.importance - a.importance;
    return a.documentId.localeCompare(b.documentId);
  });
}

export interface DigestOutput {
  stories: Map<string, { titleKo: string; summary: string; importance: number }>;
  notes: string[];
}

/** WRITE_DIGEST 출력 검증. 모르는 documentId 는 버린다 (빠진 story 는 호출자가 fallback 으로 채운다). */
export function parseDigestOutput(json: unknown, allowedDocumentIds: readonly string[]): DigestOutput {
  const notes: string[] = [];
  const stories = new Map<string, { titleKo: string; summary: string; importance: number }>();
  if (!isRecordValue(json)) return { stories, notes: ["output is not an object"] };
  const allowed = new Set(allowedDocumentIds);
  for (const raw of asArray(json.stories)) {
    if (!isRecordValue(raw)) continue;
    const documentId = typeof raw.documentId === "string" ? raw.documentId : "";
    if (!allowed.has(documentId)) {
      notes.push("digest story with unknown documentId rejected");
      continue;
    }
    if (stories.has(documentId)) {
      notes.push(`duplicate digest story ${documentId} rejected`);
      continue;
    }
    const titleKo = typeof raw.titleKo === "string" ? raw.titleKo.trim() : "";
    const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
    if (!titleKo || !summary) {
      notes.push(`digest story ${documentId} rejected: missing Korean text`);
      continue;
    }
    const importance =
      typeof raw.importance === "number" && Number.isFinite(raw.importance)
        ? Math.min(5, Math.max(1, Math.round(raw.importance)))
        : 3;
    stories.set(documentId, { titleKo, summary, importance });
  }
  return { stories, notes };
}
