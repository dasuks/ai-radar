/**
 * CULTURE ranking policy v1.0.0 (PIPELINES_AND_POLICIES.md §6.2).
 * changelog:
 *  - 1.0.0 초기 가설. 공식 발표 / 커뮤니티 반응 / cross-source / 논쟁 신호 가산, TITLE_ONLY 와 단일 소스 RUMOR 감산.
 */
import type { BriefSectionKind } from "../../domain/artifacts/daily-brief.js";
import {
  countClaims,
  logScale,
  metricValue,
  normalizeComponents,
  uniqueSourceCount,
  RANKING_THRESHOLDS,
  type RankingInput,
  type RankingOutput,
  type RankingPolicy,
  type ScoreComponent,
} from "../ranking.js";

export const CULTURE_WEIGHTS_V1 = {
  officialClaim: 0.25,
  editorialCategory: 0.2,
  engagement: 0.25,
  sourceDiversity: 0.15,
  debate: 0.1,
  notableEntity: 0.05,
  titleOnlyPenalty: -0.3,
  singleSourceRumorPenalty: -0.3,
} as const;

const ENGAGEMENT_FULL_POINTS = 500;
const ENGAGEMENT_FULL_COMMENTS = 200;
const NOTABLE_ENTITY_TYPES = new Set(["COMPANY", "PERSON", "MODEL"]);

export function rankCulture(input: RankingInput): RankingOutput {
  const claims = input.claims;
  const sources = uniqueSourceCount(input.cluster);
  const points = metricValue(input.document, "hn.points");
  const comments = metricValue(input.document, "hn.comments");
  const engagement = Math.max(logScale(points, ENGAGEMENT_FULL_POINTS), logScale(comments, ENGAGEMENT_FULL_COMMENTS));
  const cultureConfidence =
    input.classification?.categories.find((entry) => entry.category === "CULTURE")?.confidence ?? 0;
  const officialClaims = countClaims(claims, (claim) => claim.type === "OFFICIAL_CLAIM");
  const mixedClaims = countClaims(claims, (claim) => claim.sentiment === "MIXED");
  const notableEntities = input.entities.filter((entity) => NOTABLE_ENTITY_TYPES.has(entity.type)).length;
  const rumorOnly = claims.length > 0 && claims.every((claim) => claim.type === "RUMOR");

  const components: ScoreComponent[] = [
    {
      weight: CULTURE_WEIGHTS_V1.officialClaim,
      applied: officialClaims > 0 ? 1 : 0,
      reason: `공식 발표 성격의 claim ${officialClaims}건`,
    },
    {
      weight: CULTURE_WEIGHTS_V1.editorialCategory,
      applied: cultureConfidence,
      reason: `CULTURE 분류 confidence ${cultureConfidence.toFixed(2)}`,
    },
    {
      weight: CULTURE_WEIGHTS_V1.engagement,
      applied: engagement,
      reason: `커뮤니티 반응 points ${points} / comments ${comments}`,
    },
    {
      weight: CULTURE_WEIGHTS_V1.sourceDiversity,
      applied: sources >= 2 ? Math.min(1, (sources - 1) / 2) : 0,
      reason: `서로 다른 소스 ${sources}곳에서 언급`,
    },
    {
      weight: CULTURE_WEIGHTS_V1.debate,
      applied: mixedClaims >= 2 ? 1 : mixedClaims === 1 ? 0.5 : 0,
      reason: `엇갈린 반응 claim ${mixedClaims}건`,
    },
    {
      weight: CULTURE_WEIGHTS_V1.notableEntity,
      applied: notableEntities > 0 ? 1 : 0,
      reason: `주요 회사/인물/모델 entity ${notableEntities}건`,
    },
    {
      weight: CULTURE_WEIGHTS_V1.titleOnlyPenalty,
      applied: input.document.contentCompleteness === "TITLE_ONLY" ? 1 : 0,
      reason: "본문 없이 제목만 수집됨 (감점)",
    },
    {
      weight: CULTURE_WEIGHTS_V1.singleSourceRumorPenalty,
      applied: rumorOnly && sources < 2 ? 1 : 0,
      reason: "단일 소스 RUMOR (감점)",
    },
  ];

  const { score, reasons } = normalizeComponents(components);
  const category: BriefSectionKind = "CULTURE";
  return { score, reasons, category };
}

export const cultureRankingPolicyV1: RankingPolicy = {
  id: "ranking.culture",
  version: "1.0.1",
  threshold: RANKING_THRESHOLDS["ranking.culture"],
  rank: rankCulture,
};
