import type { EntityType } from "../entities/entity.js";

export const METRIC_KEYS = [
  "github.stars",
  "github.forks",
  "github.open_issues",
  "github.release_count",
  "reddit.score",
  "reddit.comments",
  "hn.points",
  "hn.comments",
  "youtube.views",
  "arxiv.citations",
  "radar.mentions",
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export type MetricSubjectType = "DOCUMENT" | "ENTITY";
export const METRIC_SCOPES = ["ITEM", "REPOSITORY", "CHANNEL", "ENTITY"] as const;
export type MetricScope = (typeof METRIC_SCOPES)[number];

export interface CoverageNote {
  sourcesAttempted: number;
  sourcesSucceeded: number;
  truncated: boolean;
  note: string | null;
}

/** CONTRACTS_AND_DATA.md §3.1 */
export interface MetricObservation {
  schemaVersion: 1;
  subjectType: MetricSubjectType;
  subjectId: string;
  key: MetricKey;
  value: number;
  unit: "count" | "score" | "ratio";
  scope: MetricScope;
  observedAt: string;
  window: { start: string; end: string } | null;
  sourceId: string;
  observationId: string | null;
  coverage: CoverageNote;
}

/** metric key 별로 허용되는 scope 와 subject 규칙. */
const KEY_RULES: Record<MetricKey, { scope: MetricScope; subjectType: MetricSubjectType; entityType?: EntityType; windowRequired?: boolean }> = {
  "github.stars": { scope: "REPOSITORY", subjectType: "ENTITY", entityType: "REPOSITORY" },
  "github.forks": { scope: "REPOSITORY", subjectType: "ENTITY", entityType: "REPOSITORY" },
  "github.open_issues": { scope: "REPOSITORY", subjectType: "ENTITY", entityType: "REPOSITORY" },
  "github.release_count": { scope: "REPOSITORY", subjectType: "ENTITY", entityType: "REPOSITORY" },
  "reddit.score": { scope: "ITEM", subjectType: "DOCUMENT" },
  "reddit.comments": { scope: "ITEM", subjectType: "DOCUMENT" },
  "hn.points": { scope: "ITEM", subjectType: "DOCUMENT" },
  "hn.comments": { scope: "ITEM", subjectType: "DOCUMENT" },
  "youtube.views": { scope: "ITEM", subjectType: "DOCUMENT" },
  "arxiv.citations": { scope: "ITEM", subjectType: "DOCUMENT" },
  "radar.mentions": { scope: "ENTITY", subjectType: "ENTITY", windowRequired: true },
};

export interface MetricScopeCheckInput {
  key: MetricKey;
  scope: MetricScope;
  subjectType: MetricSubjectType;
  subjectEntityType?: EntityType;
  window: { start: string; end: string } | null;
}

/** scope 위반을 문자열로 돌려준다. 비어 있으면 통과. 저장 전 반드시 호출한다. */
export function metricScopeViolations(input: MetricScopeCheckInput): string[] {
  const rule = KEY_RULES[input.key];
  const out: string[] = [];
  if (!rule) return [`unknown metric key ${input.key}`];
  if (rule.scope !== input.scope) out.push(`${input.key} requires scope ${rule.scope}, got ${input.scope}`);
  if (rule.subjectType !== input.subjectType) out.push(`${input.key} requires subjectType ${rule.subjectType}`);
  if (rule.entityType && input.subjectEntityType && rule.entityType !== input.subjectEntityType) {
    out.push(`${input.key} may only be recorded on ${rule.entityType} entities, got ${input.subjectEntityType}`);
  }
  if (rule.windowRequired && !input.window) out.push(`${input.key} requires a window`);
  return out;
}
