import type { DerivedSignalRef } from "../metrics/derived-signal.js";

import { Issues, isRecord, requireString, stringArray } from "../shared/validation.js";
import { isValidCalendarDate } from "../shared/time.js";

export const DAILY_BRIEF_TITLE = "AI Intelligence Daily";
export const DAILY_BRIEF_BODY_SCHEMA_VERSION = 2 as const;

export const BRIEF_SECTION_KINDS = [
  "CULTURE",
  "AI_CODING",
  "LLM",
  "AGENT_ENGINEERING",
  "EVALS_RELIABILITY",
  "AI_ECONOMICS",
  "TREND_WATCH",
] as const;
export type BriefSectionKind = (typeof BRIEF_SECTION_KINDS)[number];

export const SECTION_TITLES_KO: Record<BriefSectionKind, string> = {
  CULTURE: "AI 교양",
  AI_CODING: "AI Coding",
  LLM: "LLM",
  AGENT_ENGINEERING: "Agent Engineering",
  EVALS_RELIABILITY: "Evals & Reliability",
  AI_ECONOMICS: "AI Economics",
  TREND_WATCH: "Trend Watch",
};

export const KNOWLEDGE_TYPES = ["concept", "pattern", "workflow", "tool", "architecture", "research"] as const;
export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number];

export interface SourceRef {
  documentId: string;
  title: string;
  url: string;
  sourceId: string;
  publishedAt: string | null;
}

export interface BriefItem {
  id: string;
  title: string;
  importance: 1 | 2 | 3 | 4 | 5;
  whatChanged: string;
  whyItMatters: string;
  howDevelopersUseIt: string | null;
  howToApply: string | null;
  claimIds: string[];
  entityIds: string[];
  trend: { signalRef: DerivedSignalRef; label: string } | null;
  sourceRefs: SourceRef[];
  rankingTrace: { policyId: string; policyVersion: string; score: number; reasons: string[] };
  knowledgeType: KnowledgeType | null;
  related: string[];
}

/** 다른 Artifact(섹션 리포트, 전체 목록)로의 참조. externalUrl 은 발행 후 채워진다 */
export interface ArtifactLink {
  artifactId: string;
  externalUrl: string | null;
}

export interface BriefSection {
  kind: BriefSectionKind;
  items: BriefItem[];
  /** 이 섹션의 상세 리포트 (없으면 null) */
  report: ArtifactLink | null;
}

export interface ApplyCandidate {
  itemId: string;
  action: string;
  effort: "S" | "M" | "L";
  prerequisites: string[];
}

export interface RunCoverageSummary {
  sourcesAttempted: string[];
  sourcesFailed: string[];
  partial: boolean;
  note: string | null;
}

/** CONTRACTS_AND_DATA.md §5.2 */
export interface DailyBriefBody {
  bodySchemaVersion: 2;
  date: string;
  title: string;
  oneMinuteSummary: string[];
  sections: BriefSection[];
  learnOneThing: BriefItem | null;
  applyCandidates: ApplyCandidate[];
  sources: SourceRef[];
  coverage: RunCoverageSummary;
  /** 오늘 들어온 이야기 전체 목록 (없으면 null) */
  digest: ArtifactLink | null;
}

export function allItems(body: DailyBriefBody): BriefItem[] {
  return body.sections.flatMap((section) => section.items);
}

/** 자동 생성 brief 불변 조건: manual policy 외에는 모든 item이 claim을 가져야 한다. */
export function dailyBriefViolations(body: DailyBriefBody, knownClaimIds?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  if (!isValidCalendarDate(body.date)) out.push("date must be YYYY-MM-DD");
  if (!body.title.trim()) out.push("title is empty");
  const seen = new Set<string>();
  for (const section of body.sections) {
    if (section.items.length === 0) out.push(`section ${section.kind} is empty; omit empty sections`);
    for (const item of section.items) {
      if (seen.has(item.id)) out.push(`duplicate item id ${item.id}`);
      seen.add(item.id);
      const manual = item.rankingTrace.policyId === "manual";
      if (!manual && item.claimIds.length === 0) out.push(`item ${item.id} has no claims`);
      if (knownClaimIds) {
        for (const c of item.claimIds) if (!knownClaimIds.has(c)) out.push(`item ${item.id} references unknown claim ${c}`);
      }
      if (item.sourceRefs.length === 0) out.push(`item ${item.id} has no sourceRefs`);
    }
  }
  return out;
}

/** 느슨한 구조 검증 (저장/로드 시). 상세 불변 조건은 dailyBriefViolations. */
export function parseDailyBriefBody(value: unknown): DailyBriefBody {
  const issues = new Issues("DailyBriefBody");
  if (!isRecord(value)) {
    issues.push("root must be an object");
    issues.throwIfAny();
  }
  const obj = value as Record<string, unknown>;
  if (obj.bodySchemaVersion !== 2) issues.push("bodySchemaVersion must be 2");
  const date = requireString(obj, "date", "body", issues);
  const title = requireString(obj, "title", "body", issues);
  const oneMinuteSummary = stringArray(obj.oneMinuteSummary, "body.oneMinuteSummary", issues);
  if (!Array.isArray(obj.sections)) issues.push("body.sections must be an array");
  if (!Array.isArray(obj.sources)) issues.push("body.sources must be an array");
  if (!isRecord(obj.coverage)) issues.push("body.coverage must be an object");
  issues.throwIfAny();
  const learn = isRecord(obj.learnOneThing) ? (obj.learnOneThing as unknown as BriefItem) : null;
  return {
    bodySchemaVersion: 2,
    date,
    title,
    oneMinuteSummary,
    sections: obj.sections as BriefSection[],
    learnOneThing: learn,
    applyCandidates: Array.isArray(obj.applyCandidates) ? (obj.applyCandidates as ApplyCandidate[]) : [],
    sources: obj.sources as SourceRef[],
    coverage: obj.coverage as RunCoverageSummary,
    digest: isRecord(obj.digest) ? (obj.digest as unknown as ArtifactLink) : null,
  };
}
