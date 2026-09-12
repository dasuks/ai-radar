/**
 * Ranking Policy Port (PIPELINES_AND_POLICIES.md §6.1). 순수 함수만 둔다.
 * 가중치는 정책 파일의 상수 객체이며 버전 문자열을 가진다. Artifact 는 (id, version) 을 기록한다.
 */
import type { NormalizedDocument } from "../domain/documents/normalized-document.js";
import type { BriefSectionKind } from "../domain/artifacts/daily-brief.js";
import type { Classification } from "../domain/evidence/analysis.js";
import type { Claim } from "../domain/evidence/claim.js";
import type { Entity } from "../domain/entities/entity.js";
import type { DerivedSignal } from "../domain/metrics/derived-signal.js";
import type { MetricKey } from "../domain/metrics/metric-observation.js";

export const RANKING_POLICY_IDS = ["ranking.culture", "ranking.practical", "ranking.trend"] as const;
export type RankingPolicyId = (typeof RANKING_POLICY_IDS)[number];

export interface RankingInput {
  /** cluster 대표 문서 */
  document: NormalizedDocument;
  /** 대표를 포함한 cluster 전체 (source diversity 계산용) */
  cluster: NormalizedDocument[];
  classification: Classification | null;
  claims: Claim[];
  signals: DerivedSignal[];
  entities: Entity[];
}

export interface RankingOutput {
  /** 0..1 로 정규화된 점수 */
  score: number;
  /** 왜 올라왔는지 사람이 읽는 근거. 항상 최소 1개. */
  reasons: string[];
  category: BriefSectionKind | null;
}

export interface RankingPolicy {
  readonly id: RankingPolicyId;
  readonly version: string;
  /** §6.3 3 — 정규화 점수가 이 값 미만이면 섹션에 넣지 않는다. */
  readonly threshold: number;
  rank(input: RankingInput): RankingOutput;
}

/** §6.3 3 v1.0.0 초기 가설 */
export const RANKING_THRESHOLDS: Record<RankingPolicyId, number> = {
  "ranking.culture": 0.3,
  "ranking.practical": 0.3,
  "ranking.trend": 0.6,
};

// --- 공용 순수 헬퍼 --------------------------------------------------------

export function metricValue(document: NormalizedDocument, key: MetricKey): number {
  let best = 0;
  for (const metric of document.metrics) {
    if (metric.key === key && metric.value > best) best = metric.value;
  }
  return best;
}

/** 0..1 로 누르는 로그 스케일. value 가 full 이면 1 에 가깝다. */
export function logScale(value: number, full: number): number {
  if (value <= 0) return 0;
  const scaled = Math.log10(1 + value) / Math.log10(1 + Math.max(full, 1));
  return scaled > 1 ? 1 : scaled;
}

export function uniqueSourceCount(cluster: readonly NormalizedDocument[]): number {
  return new Set(cluster.map((document) => document.sourceId)).size;
}

export function countClaims(claims: readonly Claim[], predicate: (claim: Claim) => boolean): number {
  let count = 0;
  for (const claim of claims) if (predicate(claim)) count += 1;
  return count;
}

export function clampScore(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1 ? 1 : value;
}

export interface ScoreComponent {
  weight: number;
  applied: number;
  reason: string;
}

/**
 * 가산/감산 요소를 모아 0..1 로 정규화한다.
 * 분모는 가산 요소 가중치의 합이므로 정책 가중치를 바꿔도 0..1 이 유지된다.
 */
export function normalizeComponents(components: readonly ScoreComponent[]): { score: number; reasons: string[] } {
  let positiveWeight = 0;
  let raw = 0;
  const reasons: string[] = [];
  for (const component of components) {
    if (component.weight > 0) positiveWeight += component.weight;
    if (component.applied <= 0) continue;
    raw += component.weight * component.applied;
    reasons.push(component.reason);
  }
  const score = positiveWeight > 0 ? clampScore(raw / positiveWeight) : 0;
  if (reasons.length === 0) reasons.push("no positive ranking signal");
  return { score, reasons };
}
