/**
 * BuildSectionReports (PIPELINES_AND_POLICIES.md §11, ADR-0009).
 *
 * 섹션(BriefSectionKind)마다 긴 상세 리포트를 1개 만든다.
 * - 자격: `qualifiesForDetailedReport` (본문 FULL/EXCERPT 이거나 claim 3개 이상) **그리고** 그 섹션의 ranking 점수 ≥ 임계값.
 * - 한 cluster 는 임계값을 넘는 모든 섹션에 실릴 수 있다 (섹션당 상한 없음).
 * - narrative 는 제공된 claim·evidence 에서만 나온다. `sectionReportViolations` 로 검증하고 위반 항목은 버린다.
 * - 자격 밖 이야기는 `excluded[]` 에 사유와 함께 남는다 (버려지는 이야기 0개는 DAILY_DIGEST 가 보장한다).
 */
import {
  BRIEF_SECTION_KINDS,
  SECTION_TITLES_KO,
  type BriefSectionKind,
  type RunCoverageSummary,
  type SourceRef,
} from "../../domain/artifacts/daily-brief.js";
import {
  SECTION_REPORT_BODY_SCHEMA_VERSION,
  qualifiesForDetailedReport,
  sectionReportViolations,
  type ClaimRow,
  type EvidenceQuote,
  type ExcludedStory,
  type ReportEntity,
  type ReportEntry,
  type SectionReportBody,
} from "../../domain/artifacts/section-report.js";
import type { NormalizedDocument } from "../../domain/documents/normalized-document.js";
import type { Classification } from "../../domain/evidence/analysis.js";
import type { Claim } from "../../domain/evidence/claim.js";
import { evidenceText, type Evidence } from "../../domain/evidence/evidence.js";
import type { Entity } from "../../domain/entities/entity.js";
import type { DerivedSignal } from "../../domain/metrics/derived-signal.js";
import { artifactId, briefItemId } from "../../domain/shared/ids.js";
import type { TimeWindow } from "../../domain/shared/time.js";
import type { LlmProvider, LlmRequest } from "../../ports/llm/llm-provider.js";
import type { Clock, Logger } from "../../ports/system/index.js";
import type { RankingInput, RankingPolicy } from "../../policies/ranking.js";
import {
  SECTION_REPORT_BATCH_SIZE,
  WRITE_SECTION_REPORT_PROMPT,
  sectionReportSystem,
} from "../analyze/prompts/write-section-report.js";
import { asArray, chunk, isRecordValue, truncate, usageEntry } from "../analyze/support.js";
import type { AnalyzeUsageEntry } from "../analyze/analyze-summary.js";
import { collectClaims, sourceRefOf, type BriefCluster } from "../briefing/build-daily-brief.js";

const MAX_EVIDENCE_PER_ENTRY = 14;
const MAX_EVIDENCE_CHARS = 1200;

export const EXCLUDED_REASONS = {
  titleOnly: "제목만 수집됨",
  noClaims: "검증된 claim 없음",
  belowThreshold: "섹션 임계 점수 미만",
  merged: "같은 이야기로 묶임",
  invalidOutput: "근거 검증 실패",
  notWritten: "리포트 작성 대상에서 제외됨",
} as const;

export interface BuildSectionReportsDeps {
  llm: LlmProvider;
  model: string;
  clock: Clock;
  logger?: Logger;
  /** composition root 가 등록한 ranking 정책 (culture, practical) */
  policies: RankingPolicy[];
}

export interface BuildSectionReportsInput {
  date: string;
  window: TimeWindow;
  timezone: string;
  runId: string;
  clusters: BriefCluster[];
  classifications: Classification[];
  /** documentId → 그 문서의 ACTIVE claim */
  claimsByDocument: Record<string, Claim[]>;
  evidence: Evidence[];
  entities: Entity[];
  /** window 안의 문서 전체 (excluded 목록 계산용) */
  documents: NormalizedDocument[];
  coverage: RunCoverageSummary;
  signals?: DerivedSignal[];
  /** 이 Use Case 가 쓸 수 있는 LLM 호출 수 상한 */
  maxCallsPerRun?: number;
  signal?: AbortSignal;
}

/** entryId → 어느 섹션들에 실렸는지 + 확정된 항목. sections[0] 이 primary (점수 최고) 섹션이다. */
export interface ReportEntryIndexValue {
  sections: BriefSectionKind[];
  entry: ReportEntry;
}
export type ReportEntryIndex = Map<string, ReportEntryIndexValue>;

export interface BuildSectionReportsResult {
  reports: SectionReportBody[];
  entryIndex: ReportEntryIndex;
  usage: AnalyzeUsageEntry[];
  notes: string[];
}

export interface SectionAssignment {
  section: BriefSectionKind;
  score: number;
  reasons: string[];
  policyId: string;
  policyVersion: string;
}

interface ReportCandidate {
  entryId: string;
  cluster: BriefCluster;
  documents: NormalizedDocument[];
  claims: Claim[];
  sections: SectionAssignment[];
  qualifies: boolean;
}

export class BuildSectionReports {
  constructor(private readonly deps: BuildSectionReportsDeps) {}

  async execute(input: BuildSectionReportsInput): Promise<BuildSectionReportsResult> {
    const notes: string[] = [];
    const usage: AnalyzeUsageEntry[] = [];
    const signal = input.signal ?? new AbortController().signal;
    const artifact = artifactId("DAILY_BRIEF", input.date);
    const budget = input.maxCallsPerRun ?? Number.MAX_SAFE_INTEGER;

    const classificationByDocument = new Map(input.classifications.map((item) => [item.documentId, item] as const));
    const entityById = new Map(input.entities.map((entity) => [entity.id, entity] as const));
    const evidenceById = new Map(input.evidence.map((item) => [item.id, item] as const));
    const documentById = new Map(input.documents.map((document) => [document.id, document] as const));
    for (const cluster of input.clusters) {
      for (const document of clusterDocuments(cluster)) documentById.set(document.id, document);
    }
    const culture = this.deps.policies.find((policy) => policy.id === "ranking.culture") ?? null;
    const practical = this.deps.policies.find((policy) => policy.id === "ranking.practical") ?? null;

    // 1) 후보 만들기 — 자격 판정 + 섹션 배정 (중복 허용)
    const candidates: ReportCandidate[] = [];
    for (const cluster of input.clusters) {
      const documents = clusterDocuments(cluster);
      const claims = collectClaims(documents, input.claimsByDocument);
      const rankingInput: RankingInput = {
        document: cluster.representative,
        cluster: documents,
        classification: classificationByDocument.get(cluster.representative.id) ?? null,
        claims,
        signals: input.signals ?? [],
        entities: entitiesOfClaims(claims, entityById),
      };
      candidates.push({
        entryId: briefItemId(artifact, claims.map((claim) => claim.id).sort().join(",")),
        cluster,
        documents,
        claims,
        sections: assignSections({ culture, practical, input: rankingInput }),
        qualifies: qualifiesForDetailedReport({
          completeness: cluster.representative.contentCompleteness,
          claimCount: claims.length,
        }),
      });
    }

    // 2) 섹션별 LLM 호출 (항목 8개씩)
    const bySection = new Map<BriefSectionKind, ReportCandidate[]>();
    for (const candidate of candidates) {
      if (!candidate.qualifies) continue;
      for (const assignment of candidate.sections) {
        const list = bySection.get(assignment.section) ?? [];
        list.push(candidate);
        bySection.set(assignment.section, list);
      }
    }

    const knownClaimIds = new Set<string>();
    for (const claims of Object.values(input.claimsByDocument)) for (const claim of claims) knownClaimIds.add(claim.id);
    const knownEvidenceIds = new Set(evidenceById.keys());

    const reports: SectionReportBody[] = [];
    const writtenEntryIds = new Set<string>();
    const entryBySection = new Map<BriefSectionKind, ReportEntry[]>();
    let calls = 0;

    for (const section of BRIEF_SECTION_KINDS) {
      const list = (bySection.get(section) ?? []).sort((a, b) => scoreIn(b, section) - scoreIn(a, section));
      if (list.length === 0) continue;
      const overview: string[] = [];
      const entries: ReportEntry[] = [];
      for (const batch of chunk(list, SECTION_REPORT_BATCH_SIZE)) {
        if (calls >= budget) {
          notes.push(`section ${section}: LLM call budget reached, ${batch.length} entrie(s) not written`);
          break;
        }
        const request: LlmRequest = {
          task: "WRITE_SECTION_REPORT",
          promptId: WRITE_SECTION_REPORT_PROMPT.promptId,
          promptVersion: WRITE_SECTION_REPORT_PROMPT.promptVersion,
          system: sectionReportSystem(SECTION_TITLES_KO[section]),
          untrusted: batch.map((candidate) => ({
            id: candidate.entryId,
            text: entryBlock(candidate, evidenceById, documentById),
          })),
          outputSchema: WRITE_SECTION_REPORT_PROMPT.outputSchema,
          maxOutputTokens: WRITE_SECTION_REPORT_PROMPT.maxOutputTokens,
          temperature: WRITE_SECTION_REPORT_PROMPT.temperature,
        };
        calls += 1;
        const response = await this.deps.llm.complete(request, this.deps.model, signal);
        usage.push(usageEntry(response));
        const parsed = parseSectionReportOutput(response.json, batch);
        notes.push(...parsed.notes.map((note) => `${section}: ${note}`));
        overview.push(...parsed.overview);
        for (const candidate of batch) {
          const written = parsed.entries.get(candidate.entryId);
          if (!written) {
            notes.push(`${section}: entry ${candidate.entryId} dropped (no written body)`);
            continue;
          }
          const entry = buildEntry({
            candidate,
            written,
            evidenceById,
            documentById,
            entityById,
            knownEvidenceIds,
            notes,
          });
          if (!entry) continue;
          entries.push(entry);
        }
      }
      if (entries.length === 0) {
        notes.push(`section ${section} omitted: no valid entries`);
        continue;
      }
      const body: SectionReportBody = {
        bodySchemaVersion: SECTION_REPORT_BODY_SCHEMA_VERSION,
        date: input.date,
        section,
        title: `${SECTION_TITLES_KO[section]} — ${input.date}`,
        overview: overview.slice(0, 5),
        entries,
        sources: unionSourceRefs(entries),
        excluded: [],
        coverage: input.coverage,
      };
      const violations = sectionReportViolations(body, { evidenceIds: knownEvidenceIds, claimIds: knownClaimIds });
      if (violations.length > 0) {
        // 방어선: 개별 항목 검증을 통과했는데도 남은 위반이 있으면 그 항목을 버린다.
        const bad = new Set(entries.filter((entry) => violations.some((v) => v.includes(entry.id))).map((e) => e.id));
        body.entries = entries.filter((entry) => !bad.has(entry.id));
        body.sources = unionSourceRefs(body.entries);
        for (const id of bad) notes.push(`${section}: entry ${id} dropped by sectionReportViolations`);
        if (body.entries.length === 0) continue;
      }
      for (const entry of body.entries) writtenEntryIds.add(entry.id);
      entryBySection.set(section, body.entries);
      reports.push(body);
    }

    // 3) excluded — window 안에서 어떤 리포트에도 실리지 못한 이야기
    const excluded = buildExcluded({ candidates, documents: input.documents, writtenEntryIds, documentById });
    for (const report of reports) report.excluded = excluded;

    // 4) entryIndex — sections 는 점수 내림차순 (sections[0] 이 Daily 의 primary 섹션)
    const entryIndex: ReportEntryIndex = new Map();
    for (const candidate of candidates) {
      const sections = candidate.sections
        .filter((assignment) => (entryBySection.get(assignment.section) ?? []).some((e) => e.id === candidate.entryId))
        .sort((a, b) => b.score - a.score)
        .map((assignment) => assignment.section);
      if (sections.length === 0) continue;
      const entry = (entryBySection.get(sections[0]!) ?? []).find((e) => e.id === candidate.entryId);
      if (!entry) continue;
      entryIndex.set(candidate.entryId, { sections, entry });
    }

    this.deps.logger?.info("section reports built", {
      reports: reports.length,
      entries: entryIndex.size,
      excluded: excluded.length,
      calls,
    });
    return { reports, entryIndex, usage, notes };
  }
}

// --- 순수 헬퍼 -------------------------------------------------------------

export function clusterDocuments(cluster: BriefCluster): NormalizedDocument[] {
  const members = cluster.members.filter((document) => document.id !== cluster.representative.id);
  return [cluster.representative, ...members];
}

function scoreIn(candidate: ReportCandidate, section: BriefSectionKind): number {
  return candidate.sections.find((assignment) => assignment.section === section)?.score ?? 0;
}

function entitiesOfClaims(claims: readonly Claim[], entityById: ReadonlyMap<string, Entity>): Entity[] {
  const out: Entity[] = [];
  const seen = new Set<string>();
  for (const claim of claims) {
    for (const id of claim.subjectEntityIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const entity = entityById.get(id);
      if (entity) out.push(entity);
    }
  }
  return out;
}

/**
 * §11 — CULTURE 점수 ≥ 임계면 CULTURE, PRACTICAL 점수 ≥ 임계면 classification 이 정한 실무 섹션.
 * 둘 다 넘으면 두 섹션 모두에 배정한다 (Daily 와 달리 한 곳을 고르지 않는다).
 */
export function assignSections(args: {
  culture: RankingPolicy | null;
  practical: RankingPolicy | null;
  input: RankingInput;
}): SectionAssignment[] {
  const out: SectionAssignment[] = [];
  if (args.culture) {
    const output = args.culture.rank(args.input);
    if (output.score >= args.culture.threshold) {
      out.push({
        section: "CULTURE",
        score: output.score,
        reasons: output.reasons,
        policyId: args.culture.id,
        policyVersion: args.culture.version,
      });
    }
  }
  if (args.practical) {
    const output = args.practical.rank(args.input);
    if (output.category !== null && output.score >= args.practical.threshold) {
      out.push({
        section: output.category,
        score: output.score,
        reasons: output.reasons,
        policyId: args.practical.id,
        policyVersion: args.practical.version,
      });
    }
  }
  return out;
}

/** HN 토론 URL 을 알 수 있으면 돌려준다. */
export function discussionUrlOf(document: NormalizedDocument): string | null {
  if (document.sourceId === "hackernews" && /^\d+$/.test(document.externalId)) {
    return `https://news.ycombinator.com/item?id=${document.externalId}`;
  }
  const fromUrls = [document.canonicalUrl, ...document.urls].find(
    (url) => typeof url === "string" && url.includes("news.ycombinator.com/item"),
  );
  return fromUrls ?? null;
}

export function documentUrlOf(document: NormalizedDocument): string {
  return document.canonicalUrl ?? document.urls[0] ?? "";
}

/** 한 entry 의 비신뢰 블록: 그 entry 의 claim, 인용 가능한 evidence, 댓글. */
export function entryBlock(
  candidate: ReportCandidate,
  evidenceById: ReadonlyMap<string, Evidence>,
  documentById: ReadonlyMap<string, NormalizedDocument>,
): string {
  const representative = candidate.cluster.representative;
  const lines: string[] = [
    `title: ${representative.title}`,
    `source: ${representative.sourceId}`,
    `completeness: ${representative.contentCompleteness}`,
    `url: ${documentUrlOf(representative)}`,
  ];
  for (const claim of candidate.claims) {
    lines.push(`<claim id="${claim.id}" type="${claim.type}">${claim.statement}</claim>`);
  }
  const used = new Set<string>();
  const push = (evidence: Evidence): void => {
    if (used.size >= MAX_EVIDENCE_PER_ENTRY || used.has(evidence.id)) return;
    const document = documentById.get(evidence.documentId) ?? null;
    const text = evidenceText(evidence, document?.content ?? null);
    if (!text.trim()) return;
    used.add(evidence.id);
    const author = commentAuthorOf(evidence, document);
    const attribution = author ? ` author="${author}"` : "";
    lines.push(
      `<evidence id="${evidence.id}" kind="${evidence.locator.kind}"${attribution}>${truncate(text, MAX_EVIDENCE_CHARS)}</evidence>`,
    );
  };
  for (const claim of candidate.claims) {
    for (const evidenceId of claim.evidenceIds) {
      const evidence = evidenceById.get(evidenceId);
      if (evidence) push(evidence);
    }
  }
  for (const document of candidate.documents) {
    for (const evidence of evidenceById.values()) {
      if (evidence.documentId === document.id) push(evidence);
    }
  }
  return lines.join("\n");
}

function commentAuthorOf(evidence: Evidence, document: NormalizedDocument | null): string | null {
  if (evidence.locator.kind !== "comment" || !document) return null;
  const externalId = evidence.locator.commentExternalId;
  return document.comments.find((comment) => comment.externalId === externalId)?.author ?? null;
}

export function evidenceQuoteOf(
  evidence: Evidence,
  documentById: ReadonlyMap<string, NormalizedDocument>,
): EvidenceQuote | null {
  const document = documentById.get(evidence.documentId) ?? null;
  const text = evidenceText(evidence, document?.content ?? null).trim();
  if (!text) return null;
  const isComment = evidence.locator.kind === "comment";
  const url = document ? (isComment ? (discussionUrlOf(document) ?? documentUrlOf(document)) : documentUrlOf(document)) : null;
  return {
    evidenceId: evidence.id,
    documentId: evidence.documentId,
    text: truncate(text, MAX_EVIDENCE_CHARS),
    kind: evidence.locator.kind,
    url: url && url.length > 0 ? url : null,
    author: commentAuthorOf(evidence, document),
  };
}

export function claimRowsOf(claims: readonly Claim[]): ClaimRow[] {
  return claims.map((claim) => ({
    claimId: claim.id,
    type: claim.type,
    statement: claim.statement,
    sentiment: claim.sentiment,
    confidence: claim.confidence,
  }));
}

export function reportEntitiesOf(claims: readonly Claim[], entityById: ReadonlyMap<string, Entity>): ReportEntity[] {
  const out: ReportEntity[] = [];
  const seen = new Set<string>();
  for (const claim of claims) {
    for (const id of claim.subjectEntityIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const entity = entityById.get(id);
      out.push({ entityId: entity?.id ?? id, name: entity?.canonicalName ?? id, type: entity?.type ?? null });
    }
  }
  return out;
}

function unionSourceRefs(entries: readonly ReportEntry[]): SourceRef[] {
  const map = new Map<string, SourceRef>();
  for (const entry of entries) for (const source of entry.sourceRefs) map.set(source.documentId, source);
  return [...map.values()];
}

interface BuildEntryArgs {
  candidate: ReportCandidate;
  written: WrittenReportEntry;
  evidenceById: ReadonlyMap<string, Evidence>;
  documentById: ReadonlyMap<string, NormalizedDocument>;
  entityById: ReadonlyMap<string, Entity>;
  knownEvidenceIds: ReadonlySet<string>;
  notes: string[];
}

function buildEntry(args: BuildEntryArgs): ReportEntry | null {
  const { candidate, written } = args;
  const quotes: EvidenceQuote[] = [];
  const seen = new Set<string>();
  for (const evidenceId of written.evidenceIds) {
    if (seen.has(evidenceId)) continue;
    seen.add(evidenceId);
    if (!args.knownEvidenceIds.has(evidenceId)) {
      args.notes.push(`entry ${candidate.entryId}: unknown evidenceId ${evidenceId} dropped`);
      continue;
    }
    const evidence = args.evidenceById.get(evidenceId);
    if (!evidence) continue;
    const quote = evidenceQuoteOf(evidence, args.documentById);
    if (quote) quotes.push(quote);
  }
  if (quotes.length === 0) {
    args.notes.push(`entry ${candidate.entryId} dropped: no usable evidence quotes`);
    return null;
  }
  if (written.narrative.length === 0) {
    args.notes.push(`entry ${candidate.entryId} dropped: empty narrative`);
    return null;
  }
  const sourceRefs = candidate.documents.map(sourceRefOf);
  if (sourceRefs.length === 0) {
    args.notes.push(`entry ${candidate.entryId} dropped: no sourceRefs`);
    return null;
  }
  return {
    id: candidate.entryId,
    title: written.title,
    importance: written.importance,
    narrative: written.narrative,
    evidenceQuotes: quotes,
    claims: claimRowsOf(candidate.claims),
    communityReaction: written.communityReaction,
    entities: reportEntitiesOf(candidate.claims, args.entityById),
    whyItMatters: written.whyItMatters,
    howToApply: written.howToApply,
    counterpoints: written.counterpoints,
    openQuestions: written.openQuestions,
    sourceRefs,
    evidenceLevel: candidate.cluster.representative.contentCompleteness,
  };
}

function buildExcluded(args: {
  candidates: readonly ReportCandidate[];
  documents: readonly NormalizedDocument[];
  writtenEntryIds: ReadonlySet<string>;
  documentById: ReadonlyMap<string, NormalizedDocument>;
}): ExcludedStory[] {
  const covered = new Set<string>();
  const reasonByDocument = new Map<string, string>();
  for (const candidate of args.candidates) {
    if (args.writtenEntryIds.has(candidate.entryId)) {
      for (const document of candidate.documents) covered.add(document.id);
      continue;
    }
    const representative = candidate.cluster.representative;
    const reason = !candidate.qualifies
      ? representative.contentCompleteness === "TITLE_ONLY" || representative.contentCompleteness === "MISSING"
        ? EXCLUDED_REASONS.titleOnly
        : EXCLUDED_REASONS.noClaims
      : candidate.sections.length === 0
        ? EXCLUDED_REASONS.belowThreshold
        : EXCLUDED_REASONS.notWritten;
    reasonByDocument.set(representative.id, reason);
    for (const document of candidate.documents) {
      if (document.id !== representative.id) reasonByDocument.set(document.id, EXCLUDED_REASONS.merged);
    }
  }
  const out: ExcludedStory[] = [];
  const seen = new Set<string>();
  for (const document of args.documents) {
    if (covered.has(document.id) || seen.has(document.id)) continue;
    seen.add(document.id);
    out.push({
      documentId: document.id,
      title: document.title,
      url: documentUrlOf(document),
      reason: reasonByDocument.get(document.id) ?? EXCLUDED_REASONS.merged,
    });
  }
  for (const [documentId, reason] of reasonByDocument) {
    if (covered.has(documentId) || seen.has(documentId)) continue;
    const document = args.documentById.get(documentId);
    if (!document) continue;
    seen.add(documentId);
    out.push({ documentId, title: document.title, url: documentUrlOf(document), reason });
  }
  return out;
}

export interface WrittenReportEntry {
  title: string;
  importance: 1 | 2 | 3 | 4 | 5;
  narrative: string[];
  evidenceIds: string[];
  communityReaction: string | null;
  whyItMatters: string;
  howToApply: string | null;
  counterpoints: string[];
  openQuestions: string[];
}

export interface SectionReportOutput {
  overview: string[];
  entries: Map<string, WrittenReportEntry>;
  notes: string[];
}

/** WRITE_SECTION_REPORT 출력 검증. 모르는 entryId 는 버린다 (evidenceId 검증은 buildEntry 가 한다). */
export function parseSectionReportOutput(
  json: unknown,
  batch: readonly { entryId: string }[],
): SectionReportOutput {
  const notes: string[] = [];
  const entries = new Map<string, WrittenReportEntry>();
  if (!isRecordValue(json)) return { overview: [], entries, notes: ["output is not an object"] };
  const allowed = new Set(batch.map((candidate) => candidate.entryId));
  for (const raw of asArray(json.entries)) {
    if (!isRecordValue(raw)) {
      notes.push("entry is not an object");
      continue;
    }
    const entryId = typeof raw.entryId === "string" ? raw.entryId : "";
    if (!allowed.has(entryId)) {
      notes.push("entry with unknown entryId rejected");
      continue;
    }
    if (entries.has(entryId)) {
      notes.push(`duplicate entry ${entryId} rejected`);
      continue;
    }
    const title = text(raw.title);
    const whyItMatters = text(raw.whyItMatters);
    const narrative = stringList(raw.narrative);
    if (!title || !whyItMatters || narrative.length === 0) {
      notes.push(`entry ${entryId} rejected: missing required Korean text`);
      continue;
    }
    entries.set(entryId, {
      title,
      importance: importanceOf(raw.importance),
      narrative,
      evidenceIds: stringList(raw.evidenceIds),
      communityReaction: text(raw.communityReaction) || null,
      whyItMatters,
      howToApply: text(raw.howToApply) || null,
      counterpoints: stringList(raw.counterpoints),
      openQuestions: stringList(raw.openQuestions),
    });
  }
  return { overview: stringList(json.overview), entries, notes };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown): string[] {
  return asArray(value)
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function importanceOf(value: unknown): 1 | 2 | 3 | 4 | 5 {
  if (typeof value !== "number" || !Number.isFinite(value)) return 3;
  const rounded = Math.round(value);
  return (rounded < 1 ? 1 : rounded > 5 ? 5 : rounded) as 1 | 2 | 3 | 4 | 5;
}
