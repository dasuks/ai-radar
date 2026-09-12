/**
 * 섹션(주제)별 상세 리포트와 전체 목록(digest) 계약.
 * 사용자 요구(2026-09-13): 섹션마다 긴 리포트 1개, 오늘 들어온 이야기 전부를 담은 목록 1개,
 * Daily 는 그 위의 짧은 요약. 두 계약 모두 Artifact<TBody> 의 body 다.
 */
import type { ClaimType, Sentiment } from "../evidence/claim.js";
import type { EntityType } from "../entities/entity.js";
import type { ContentCompleteness } from "../documents/raw-observation.js";
import type { BriefSectionKind, RunCoverageSummary, SourceRef } from "./daily-brief.js";

export const SECTION_REPORT_BODY_SCHEMA_VERSION = 1 as const;
export const DAILY_DIGEST_BODY_SCHEMA_VERSION = 1 as const;

export interface EvidenceQuote {
  evidenceId: string;
  documentId: string;
  /** 원문 발췌 (그대로, 번역하지 않음) */
  text: string;
  kind: "excerpt" | "comment" | "document" | "metric";
  url: string | null;
  /** 댓글이면 작성자 표시명 */
  author: string | null;
}

export interface ClaimRow {
  claimId: string;
  type: ClaimType;
  statement: string;
  sentiment: Sentiment;
  confidence: number;
}

export interface ReportEntity {
  entityId: string | null;
  name: string;
  type: EntityType | null;
}

/** 리포트 안의 항목 하나. `id` 는 Daily 의 BriefItem.id 와 같다 (여러 섹션에 같은 항목이 실릴 수 있음). */
export interface ReportEntry {
  id: string;
  title: string;
  importance: 1 | 2 | 3 | 4 | 5;
  /** 여러 문단. 합쳐서 20~40문장. 근거에 없는 사실을 넣지 않는다 */
  narrative: string[];
  evidenceQuotes: EvidenceQuote[];
  claims: ClaimRow[];
  /** 댓글·반응 요약 (댓글이 없으면 null) */
  communityReaction: string | null;
  entities: ReportEntity[];
  whyItMatters: string;
  howToApply: string | null;
  counterpoints: string[];
  openQuestions: string[];
  sourceRefs: SourceRef[];
  /** 근거 수준 표시 */
  evidenceLevel: ContentCompleteness;
}

export interface ExcludedStory {
  documentId: string;
  title: string;
  url: string;
  reason: string;
}

/** CONTRACTS_AND_DATA.md 보강: SECTION_REPORT Artifact body. targetKey = `${date}:${section}` */
export interface SectionReportBody {
  bodySchemaVersion: 1;
  date: string;
  section: BriefSectionKind;
  title: string;
  /** 3~5문장: 오늘 이 분야의 흐름 */
  overview: string[];
  entries: ReportEntry[];
  sources: SourceRef[];
  /** 수집됐지만 근거가 약해 상세로 못 간 이야기 (투명성) */
  excluded: ExcludedStory[];
  coverage: RunCoverageSummary;
}

export interface DigestStory {
  documentId: string;
  /** 한국어 한 줄 제목 */
  titleKo: string;
  originalTitle: string;
  /** 1~3줄 사실 요약 */
  summary: string;
  section: BriefSectionKind | null;
  evidenceLevel: ContentCompleteness;
  url: string;
  discussionUrl: string | null;
  sourceId: string;
  metrics: { points: number | null; comments: number | null };
  importance: number;
  /** 상세 리포트에 실렸으면 그 항목 id */
  reportEntryId: string | null;
  publishedAt: string | null;
}

/** DAILY_DIGEST Artifact body. targetKey = date. 오늘 window 의 클러스터 대표 문서 전부. */
export interface DailyDigestBody {
  bodySchemaVersion: 1;
  date: string;
  title: string;
  stories: DigestStory[];
  coverage: RunCoverageSummary;
}

export function sectionReportTargetKey(date: string, section: BriefSectionKind): string {
  return `${date}:${section}`;
}

/** 상세 리포트 자격: 본문이 있거나(FULL/EXCERPT) 검증된 claim 이 3개 이상. */
export function qualifiesForDetailedReport(input: { completeness: ContentCompleteness; claimCount: number }): boolean {
  return input.completeness === "FULL" || input.completeness === "EXCERPT" || input.claimCount >= 3;
}

const SENTENCE_SPLIT = /[.!?。]\s|[.!?。]$|다\.\s|다\.$/g;

export function sentenceCount(paragraphs: readonly string[]): number {
  let count = 0;
  for (const p of paragraphs) count += (p.match(SENTENCE_SPLIT) ?? []).length || (p.trim() ? 1 : 0);
  return count;
}

/** 리포트 불변 조건. 빈 배열이면 통과. */
export function sectionReportViolations(
  body: SectionReportBody,
  known: { evidenceIds: ReadonlySet<string>; claimIds: ReadonlySet<string> },
): string[] {
  const out: string[] = [];
  if (body.entries.length === 0) out.push("report has no entries; omit the section instead");
  const seen = new Set<string>();
  for (const entry of body.entries) {
    if (seen.has(entry.id)) out.push(`duplicate entry ${entry.id}`);
    seen.add(entry.id);
    if (entry.narrative.length === 0) out.push(`entry ${entry.id} has no narrative`);
    if (entry.evidenceQuotes.length === 0) out.push(`entry ${entry.id} has no evidence quotes`);
    for (const q of entry.evidenceQuotes) if (!known.evidenceIds.has(q.evidenceId)) out.push(`entry ${entry.id} quotes unknown evidence ${q.evidenceId}`);
    for (const c of entry.claims) if (!known.claimIds.has(c.claimId)) out.push(`entry ${entry.id} references unknown claim ${c.claimId}`);
    if (entry.sourceRefs.length === 0) out.push(`entry ${entry.id} has no sourceRefs`);
  }
  return out;
}
