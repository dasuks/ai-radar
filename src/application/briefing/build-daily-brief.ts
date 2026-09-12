/**
 * BuildDailyBrief (PIPELINES_AND_POLICIES.md §6.3).
 *
 * 랭킹 → 섹션 배정 → BriefItem 뼈대 → 한국어 본문 1회 LLM 호출 → 검증 순서다.
 * LLM 이 쓰지 않은 item 은 brief 에서 빠진다. 없는 claim 을 지어내지 않는다.
 * LLM 을 쓸 수 없으면 이 Use Case 는 예외를 던지고, 호출자가 Run 을 ANALYSIS_FAILURE 로 마감한다.
 */
import {
  BRIEF_SECTION_KINDS,
  DAILY_BRIEF_TITLE,
  dailyBriefViolations,
  type ApplyCandidate,
  type BriefItem,
  type BriefSection,
  type BriefSectionKind,
  type DailyBriefBody,
  type KnowledgeType,
  type RunCoverageSummary,
  type SourceRef,
} from "../../domain/artifacts/daily-brief.js";
import type { NormalizedDocument } from "../../domain/documents/normalized-document.js";
import type { Classification } from "../../domain/evidence/analysis.js";
import type { Claim } from "../../domain/evidence/claim.js";
import { evidenceText, type Evidence } from "../../domain/evidence/evidence.js";
import type { Entity } from "../../domain/entities/entity.js";
import type { DerivedSignal } from "../../domain/metrics/derived-signal.js";
import { artifactId, briefItemId } from "../../domain/shared/ids.js";
import type { TimeWindow } from "../../domain/shared/time.js";
import { ContractValidationError } from "../../domain/shared/validation.js";
import type { LlmProvider, LlmRequest } from "../../ports/llm/llm-provider.js";
import type { Clock, Logger } from "../../ports/system/index.js";
import type { RankingInput, RankingOutput, RankingPolicy } from "../../policies/ranking.js";
import { WRITE_BRIEF_KO_PROMPT } from "../analyze/prompts/write-brief-ko.js";
import { asArray, isRecordValue, truncate, usageEntry } from "../analyze/support.js";
import type { AnalyzeUsageEntry } from "../analyze/analyze-summary.js";

export const DEFAULT_MAX_ITEMS_PER_SECTION = 5;
const MAX_EVIDENCE_PER_ITEM = 6;
const MAX_EVIDENCE_CHARS = 300;
const MIN_SUMMARY_SENTENCES = 3;
const MAX_SUMMARY_SENTENCES = 5;

export interface BriefCluster {
  /** cluster 대표 문서 */
  representative: NormalizedDocument;
  /** 대표를 포함한 cluster 전체 */
  members: NormalizedDocument[];
}

export interface BuildDailyBriefDeps {
  llm: LlmProvider;
  model: string;
  /** composition root 가 등록한 정책 (Phase 3: culture, practical) */
  policies: RankingPolicy[];
  clock: Clock;
  logger?: Logger;
}

export interface BuildDailyBriefInput {
  date: string;
  window: TimeWindow;
  timezone: string;
  runId: string;
  clusters: BriefCluster[];
  classifications: Classification[];
  /** documentId → 그 문서의 ACTIVE claim */
  claimsByDocument: Record<string, Claim[]>;
  entities: Entity[];
  /** claim 이 인용한 Evidence (본문 작성 입력). 없으면 statement 만 쓴다. */
  evidence?: Evidence[];
  signals?: DerivedSignal[];
  coverage: RunCoverageSummary;
  maxItemsPerSection?: number;
  signal?: AbortSignal;
}

export interface BuildDailyBriefResult {
  body: DailyBriefBody;
  inputs: {
    claimIds: string[];
    documentIds: string[];
    rankingPolicies: { id: string; version: string }[];
    runId: string;
  };
  usage: AnalyzeUsageEntry[];
  /** 검증에서 버린 LLM 항목 수 */
  rejectedItems: number;
  notes: string[];
}

export interface Candidate {
  cluster: BriefCluster;
  section: BriefSectionKind;
  ranking: RankingOutput;
  policy: RankingPolicy;
  claims: Claim[];
  documents: NormalizedDocument[];
}

export class BuildDailyBrief {
  constructor(private readonly deps: BuildDailyBriefDeps) {}

  async execute(input: BuildDailyBriefInput): Promise<BuildDailyBriefResult> {
    const notes: string[] = [];
    const maxItems = input.maxItemsPerSection ?? DEFAULT_MAX_ITEMS_PER_SECTION;
    const signal = input.signal ?? new AbortController().signal;
    const artifact = artifactId("DAILY_BRIEF", input.date);
    const classificationByDocument = new Map(input.classifications.map((item) => [item.documentId, item] as const));
    const entityById = new Map(input.entities.map((entity) => [entity.id, entity] as const));
    const culture = this.deps.policies.find((policy) => policy.id === "ranking.culture") ?? null;
    const practical = this.deps.policies.find((policy) => policy.id === "ranking.practical") ?? null;

    // 1) 등록된 정책을 모두 실행하고 섹션을 정한다 (§6.3 1-2).
    const candidates: Candidate[] = [];
    for (const cluster of input.clusters) {
      const documents = cluster.members.length > 0 ? cluster.members : [cluster.representative];
      const claims = collectClaims(documents, input.claimsByDocument);
      const rankingInput: RankingInput = {
        document: cluster.representative,
        cluster: documents,
        classification: classificationByDocument.get(cluster.representative.id) ?? null,
        claims,
        signals: input.signals ?? [],
        entities: entitiesOfClaims(claims, entityById),
      };
      const cultureOutput = culture ? culture.rank(rankingInput) : null;
      const practicalOutput = practical ? practical.rank(rankingInput) : null;
      const chosen = chooseSection({ culture, practical, cultureOutput, practicalOutput });
      if (!chosen) continue;
      candidates.push({ cluster, documents, claims, ...chosen });
    }

    // 2) 섹션별 상한과 순서 (§6.3 3)
    const bySection = new Map<BriefSectionKind, Candidate[]>();
    for (const candidate of candidates) {
      const list = bySection.get(candidate.section) ?? [];
      list.push(candidate);
      bySection.set(candidate.section, list);
    }
    const skeletons: BriefItem[] = [];
    const sectionOfItem = new Map<string, BriefSectionKind>();
    const candidateOfItem = new Map<string, Candidate>();
    for (const kind of BRIEF_SECTION_KINDS) {
      const list = (bySection.get(kind) ?? []).sort((a, b) => b.ranking.score - a.ranking.score).slice(0, maxItems);
      for (const candidate of list) {
        const item = buildSkeleton(artifact, candidate, entityById);
        if (sectionOfItem.has(item.id)) continue;
        skeletons.push(item);
        sectionOfItem.set(item.id, kind);
        candidateOfItem.set(item.id, candidate);
      }
    }

    // 3) 한국어 본문 1회 호출 (§6.3 6-7)
    const usage: AnalyzeUsageEntry[] = [];
    let written: WrittenOutput = { items: new Map(), oneMinuteSummary: [], rejected: 0, notes: [] };
    if (skeletons.length > 0) {
      const evidenceById = new Map((input.evidence ?? []).map((item) => [item.id, item] as const));
      const contentByDocument = new Map<string, string | null>();
      for (const cluster of input.clusters) {
        for (const document of cluster.members.length > 0 ? cluster.members : [cluster.representative]) {
          contentByDocument.set(document.id, document.content);
        }
      }
      const request: LlmRequest = {
        task: "WRITE_BRIEF_KO",
        promptId: WRITE_BRIEF_KO_PROMPT.promptId,
        promptVersion: WRITE_BRIEF_KO_PROMPT.promptVersion,
        system: WRITE_BRIEF_KO_PROMPT.system,
        untrusted: skeletons.map((item) => ({
          id: item.id,
          text: itemBlock(candidateOfItem.get(item.id)!, evidenceById, contentByDocument),
        })),
        outputSchema: WRITE_BRIEF_KO_PROMPT.outputSchema,
        maxOutputTokens: WRITE_BRIEF_KO_PROMPT.maxOutputTokens,
        temperature: WRITE_BRIEF_KO_PROMPT.temperature,
      };
      const response = await this.deps.llm.complete(request, this.deps.model, signal);
      usage.push(usageEntry(response));
      written = parseWriteBriefOutput(response.json, skeletons);
      notes.push(...written.notes);
      this.deps.logger?.info("daily brief written", {
        provider: response.provider,
        model: response.model,
        items: written.items.size,
        skeletons: skeletons.length,
      });
    }

    // 4) LLM 이 쓰지 않은 item 은 빼고 섹션을 만든다.
    const sections: BriefSection[] = [];
    const finalItems: BriefItem[] = [];
    for (const kind of BRIEF_SECTION_KINDS) {
      const items: BriefItem[] = [];
      for (const skeleton of skeletons) {
        if (sectionOfItem.get(skeleton.id) !== kind) continue;
        const body = written.items.get(skeleton.id);
        if (!body) {
          notes.push(`item ${skeleton.id} dropped: no written body`);
          continue;
        }
        items.push({ ...skeleton, ...body });
      }
      if (items.length > 0) {
        sections.push({ kind, items });
        finalItems.push(...items);
      }
    }

    // 5) learnOneThing / applyCandidates / sources (§6.3 5, 8)
    const practicalItems = finalItems
      .filter((item) => item.rankingTrace.policyId === "ranking.practical")
      .sort((a, b) => b.rankingTrace.score - a.rankingTrace.score);
    const learnOneThing = practicalItems[0] ?? null;
    const applyCandidates: ApplyCandidate[] = finalItems
      .filter((item) => item.howToApply !== null && item.howToApply.trim() !== "")
      .map((item) => ({ itemId: item.id, action: item.howToApply!, effort: "M", prerequisites: [] }));
    const sources = unionSources(finalItems);

    const body: DailyBriefBody = {
      bodySchemaVersion: 2,
      date: input.date,
      title: DAILY_BRIEF_TITLE,
      oneMinuteSummary: written.oneMinuteSummary,
      sections,
      learnOneThing,
      applyCandidates,
      sources,
      coverage: input.coverage,
    };

    const knownClaimIds = new Set<string>();
    for (const claims of Object.values(input.claimsByDocument)) {
      for (const claim of claims) knownClaimIds.add(claim.id);
    }
    const violations = dailyBriefViolations(body, knownClaimIds);
    if (violations.length > 0) throw new ContractValidationError("DailyBriefBody", violations);

    return {
      body,
      inputs: {
        claimIds: [...new Set(finalItems.flatMap((item) => item.claimIds))].sort(),
        documentIds: [...new Set(finalItems.flatMap((item) => item.sourceRefs.map((source) => source.documentId)))].sort(),
        rankingPolicies: this.deps.policies.map((policy) => ({ id: policy.id, version: policy.version })),
        runId: input.runId,
      },
      usage,
      rejectedItems: written.rejected,
      notes,
    };
  }
}

// --- 순수 헬퍼 -------------------------------------------------------------

export function collectClaims(
  documents: readonly NormalizedDocument[],
  claimsByDocument: Record<string, Claim[]>,
): Claim[] {
  const out: Claim[] = [];
  const seen = new Set<string>();
  for (const document of documents) {
    for (const claim of claimsByDocument[document.id] ?? []) {
      if (claim.status !== "ACTIVE" || seen.has(claim.id)) continue;
      seen.add(claim.id);
      out.push(claim);
    }
  }
  return out;
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

interface ChooseSectionInput {
  culture: RankingPolicy | null;
  practical: RankingPolicy | null;
  cultureOutput: RankingOutput | null;
  practicalOutput: RankingOutput | null;
}

/** §6.3 2 — PRACTICAL 상위는 classification 이 정한 섹션, CULTURE 상위는 CULTURE. 임계 미만은 생략. */
export function chooseSection(
  input: ChooseSectionInput,
): { section: BriefSectionKind; ranking: RankingOutput; policy: RankingPolicy } | null {
  const practicalOk =
    input.practical !== null &&
    input.practicalOutput !== null &&
    input.practicalOutput.category !== null &&
    input.practicalOutput.score >= input.practical.threshold;
  const cultureOk =
    input.culture !== null && input.cultureOutput !== null && input.cultureOutput.score >= input.culture.threshold;
  if (practicalOk && (!cultureOk || input.practicalOutput!.score >= input.cultureOutput!.score)) {
    return {
      section: input.practicalOutput!.category!,
      ranking: input.practicalOutput!,
      policy: input.practical!,
    };
  }
  if (cultureOk) {
    return { section: "CULTURE", ranking: input.cultureOutput!, policy: input.culture! };
  }
  return null;
}

function buildSkeleton(artifact: string, candidate: Candidate, entityById: ReadonlyMap<string, Entity>): BriefItem {
  const claimIds = candidate.claims.map((claim) => claim.id).sort();
  const entityIds = [...new Set(candidate.claims.flatMap((claim) => claim.subjectEntityIds))].sort();
  return {
    id: briefItemId(artifact, claimIds.join(",")),
    title: candidate.cluster.representative.title,
    importance: 3,
    whatChanged: "",
    whyItMatters: "",
    howDevelopersUseIt: null,
    howToApply: null,
    claimIds,
    entityIds,
    trend: null,
    sourceRefs: candidate.documents.map(sourceRefOf),
    rankingTrace: {
      policyId: candidate.policy.id,
      policyVersion: candidate.policy.version,
      score: candidate.ranking.score,
      reasons: candidate.ranking.reasons,
    },
    knowledgeType: knowledgeTypeOf(candidate, entityById),
    related: [],
  };
}

export function sourceRefOf(document: NormalizedDocument): SourceRef {
  return {
    documentId: document.id,
    title: document.title,
    url: document.canonicalUrl ?? document.urls[0] ?? "",
    sourceId: document.sourceId,
    publishedAt: document.publishedAt,
  };
}

const WORKFLOW_HINT = /(워크플로|파이프라인|자동화|workflow|pipeline)/i;
const PATTERN_HINT = /(패턴|사례|방식|pattern|practice)/i;

function knowledgeTypeOf(candidate: Candidate, entityById: ReadonlyMap<string, Entity>): KnowledgeType | null {
  const entities = candidate.claims
    .flatMap((claim) => claim.subjectEntityIds)
    .map((id) => entityById.get(id))
    .filter((entity): entity is Entity => entity !== undefined);
  if (entities.some((entity) => entity.type === "REPOSITORY" || entity.type === "TOOL" || entity.type === "MCP_SERVER")) {
    return "tool";
  }
  const statements = candidate.claims.map((claim) => claim.statement).join(" ");
  if (candidate.section === "AGENT_ENGINEERING" || WORKFLOW_HINT.test(statements)) return "workflow";
  if (PATTERN_HINT.test(statements)) return "pattern";
  if (candidate.section === "CULTURE" || candidate.section === "LLM" || candidate.section === "AI_ECONOMICS") {
    return "concept";
  }
  return null;
}

/** §6.3 8 — 전체 item 의 sourceRefs 합집합, publishedAt 내림차순. */
export function unionSources(items: readonly BriefItem[]): SourceRef[] {
  const map = new Map<string, SourceRef>();
  for (const item of items) for (const source of item.sourceRefs) map.set(source.documentId, source);
  return [...map.values()].sort((a, b) => {
    const left = a.publishedAt ? Date.parse(a.publishedAt) : Number.NEGATIVE_INFINITY;
    const right = b.publishedAt ? Date.parse(b.publishedAt) : Number.NEGATIVE_INFINITY;
    if (right !== left) return right - left;
    return a.documentId.localeCompare(b.documentId);
  });
}

/** item 하나의 비신뢰 블록: 그 item 의 claim 과 인용 evidence 만 담는다. */
export function itemBlock(
  candidate: Candidate,
  evidenceById: ReadonlyMap<string, Evidence>,
  contentByDocument: ReadonlyMap<string, string | null>,
): string {
  const lines: string[] = [];
  const used = new Set<string>();
  for (const claim of candidate.claims) {
    lines.push(`<claim id="${claim.id}" type="${claim.type}">${claim.statement}</claim>`);
    for (const evidenceId of claim.evidenceIds) {
      if (used.size >= MAX_EVIDENCE_PER_ITEM || used.has(evidenceId)) continue;
      const evidence = evidenceById.get(evidenceId);
      if (!evidence) continue;
      used.add(evidenceId);
      const text = evidenceText(evidence, contentByDocument.get(evidence.documentId) ?? null);
      if (!text.trim()) continue;
      lines.push(`<evidence id="${evidence.id}">${truncate(text, MAX_EVIDENCE_CHARS)}</evidence>`);
    }
  }
  return lines.join("\n");
}

export interface WrittenItem {
  title: string;
  importance: 1 | 2 | 3 | 4 | 5;
  whatChanged: string;
  whyItMatters: string;
  howDevelopersUseIt: string | null;
  howToApply: string | null;
  claimIds: string[];
}

export interface WrittenOutput {
  items: Map<string, WrittenItem>;
  oneMinuteSummary: string[];
  rejected: number;
  notes: string[];
}

/** WRITE_BRIEF_KO 출력 검증. 모르는 itemId 는 버리고, 모르는 claimId 는 그 item 에서 뺀다. */
export function parseWriteBriefOutput(json: unknown, skeletons: readonly BriefItem[]): WrittenOutput {
  const notes: string[] = [];
  const items = new Map<string, WrittenItem>();
  let rejected = 0;
  if (!isRecordValue(json)) {
    return { items, oneMinuteSummary: [], rejected: 0, notes: ["output is not an object"] };
  }
  const allowed = new Map(skeletons.map((item) => [item.id, new Set(item.claimIds)] as const));
  for (const raw of asArray(json.items)) {
    if (!isRecordValue(raw)) {
      rejected += 1;
      continue;
    }
    const itemId = typeof raw.itemId === "string" ? raw.itemId : "";
    const allowedClaims = allowed.get(itemId);
    if (!allowedClaims) {
      rejected += 1;
      notes.push("written item with unknown itemId rejected");
      continue;
    }
    if (items.has(itemId)) {
      rejected += 1;
      notes.push(`duplicate written item ${itemId} rejected`);
      continue;
    }
    const title = text(raw.title);
    const whatChanged = text(raw.whatChanged);
    const whyItMatters = text(raw.whyItMatters);
    if (!title || !whatChanged || !whyItMatters) {
      rejected += 1;
      notes.push(`written item ${itemId} rejected: missing required Korean text`);
      continue;
    }
    const claimIds: string[] = [];
    for (const value of asArray(raw.claimIds)) {
      if (typeof value !== "string") continue;
      if (!allowedClaims.has(value)) {
        notes.push(`unknown claimId dropped from item ${itemId}`);
        continue;
      }
      if (!claimIds.includes(value)) claimIds.push(value);
    }
    if (claimIds.length === 0) {
      rejected += 1;
      notes.push(`written item ${itemId} rejected: no valid claimIds`);
      continue;
    }
    items.set(itemId, {
      title,
      importance: importanceOf(raw.importance),
      whatChanged,
      whyItMatters,
      howDevelopersUseIt: text(raw.howDevelopersUseIt) || null,
      howToApply: text(raw.howToApply) || null,
      claimIds,
    });
  }
  let summary = asArray(json.oneMinuteSummary)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (summary.length > MAX_SUMMARY_SENTENCES) summary = summary.slice(0, MAX_SUMMARY_SENTENCES);
  if (summary.length > 0 && summary.length < MIN_SUMMARY_SENTENCES) {
    notes.push(`oneMinuteSummary has ${summary.length} sentences (expected ${MIN_SUMMARY_SENTENCES}-${MAX_SUMMARY_SENTENCES})`);
  }
  return { items, oneMinuteSummary: summary, rejected, notes };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function importanceOf(value: unknown): 1 | 2 | 3 | 4 | 5 {
  if (typeof value !== "number" || !Number.isFinite(value)) return 3;
  const rounded = Math.round(value);
  const clamped = rounded < 1 ? 1 : rounded > 5 ? 5 : rounded;
  return clamped as 1 | 2 | 3 | 4 | 5;
}
