/**
 * PRACTICAL ranking policy v1.0.0 (PIPELINES_AND_POLICIES.md §6.2).
 * changelog:
 *  - 1.0.0 초기 가설. 경험+사실 조합, how-to 성격 분류, 코드/설정 인용, TOOL·REPOSITORY entity, repo 링크 가산.
 *    OPINION/FORECAST 위주와 claim 없음은 감산.
 */
import type { BriefSectionKind } from "../../domain/artifacts/daily-brief.js";
import type { Classification, EditorialCategory } from "../../domain/evidence/analysis.js";
import { normalizeRepositoryUrl } from "../../domain/entities/entity.js";
import {
  countClaims,
  normalizeComponents,
  RANKING_THRESHOLDS,
  type RankingInput,
  type RankingOutput,
  type RankingPolicy,
  type ScoreComponent,
} from "../ranking.js";

export const PRACTICAL_WEIGHTS_V1 = {
  experienceAndFact: 0.25,
  howToCategory: 0.25,
  codeEvidence: 0.2,
  toolEntity: 0.15,
  repositoryLink: 0.15,
  opinionOnlyPenalty: -0.3,
  noClaimPenalty: -0.5,
} as const;

const HOW_TO_CATEGORIES: Record<string, number> = {
  AI_CODING: 1,
  AGENT_ENGINEERING: 1,
  EVALS_RELIABILITY: 0.6,
  LLM: 0.6,
  AI_ECONOMICS: 0.3,
};

const PRACTICAL_SECTION_BY_CATEGORY: Partial<Record<EditorialCategory, BriefSectionKind>> = {
  AI_CODING: "AI_CODING",
  LLM: "LLM",
  AGENT_ENGINEERING: "AGENT_ENGINEERING",
  EVALS_RELIABILITY: "EVALS_RELIABILITY",
  AI_ECONOMICS: "AI_ECONOMICS",
};

const TOOL_ENTITY_TYPES = new Set(["TOOL", "SKILL", "MCP_SERVER", "FRAMEWORK", "REPOSITORY"]);
const CODE_TAGS = ["code", "github", "repo", "tutorial", "howto", "show_hn"];
const CODE_HINT = /```|\$ |npm |pip install|docker run|\byaml\b|\bjson\b/i;

/** classification 이 정하는 PRACTICAL 섹션. CULTURE/OTHER 뿐이면 null. */
export function practicalSectionOf(classification: Classification | null): BriefSectionKind | null {
  if (!classification) return null;
  let best: { kind: BriefSectionKind; confidence: number } | null = null;
  for (const entry of classification.categories) {
    const kind = PRACTICAL_SECTION_BY_CATEGORY[entry.category];
    if (!kind) continue;
    if (!best || entry.confidence > best.confidence) best = { kind, confidence: entry.confidence };
  }
  return best?.kind ?? null;
}

export function rankPractical(input: RankingInput): RankingOutput {
  const claims = input.claims;
  const experiences = countClaims(claims, (claim) => claim.type === "USER_EXPERIENCE");
  const facts = countClaims(claims, (claim) => claim.type === "FACT" || claim.type === "OFFICIAL_CLAIM");
  const combo = experiences > 0 && facts > 0 ? 1 : experiences > 0 || facts > 0 ? 0.5 : 0;

  let howTo = 0;
  for (const entry of input.classification?.categories ?? []) {
    const weight = HOW_TO_CATEGORIES[entry.category] ?? 0;
    const applied = weight * entry.confidence;
    if (applied > howTo) howTo = applied;
  }

  const tags = input.document.tags.map((tag) => tag.toLowerCase());
  const hasCodeTag = tags.some((tag) => CODE_TAGS.includes(tag));
  const hasCodeText = input.document.content !== null && CODE_HINT.test(input.document.content);
  const toolEntities = input.entities.filter((entity) => TOOL_ENTITY_TYPES.has(entity.type)).length;
  const repositoryUrl = [input.document.canonicalUrl, ...input.document.urls].some(
    (url) => normalizeRepositoryUrl(url) !== null,
  );
  const opinionOnly =
    claims.length > 0 && claims.every((claim) => claim.type === "OPINION" || claim.type === "FORECAST");

  const components: ScoreComponent[] = [
    {
      weight: PRACTICAL_WEIGHTS_V1.experienceAndFact,
      applied: combo,
      reason: `실사용 경험 ${experiences}건 + 사실 claim ${facts}건`,
    },
    {
      weight: PRACTICAL_WEIGHTS_V1.howToCategory,
      applied: howTo,
      reason: "실무 적용형 분류 (AI_CODING/AGENT_ENGINEERING 계열)",
    },
    {
      weight: PRACTICAL_WEIGHTS_V1.codeEvidence,
      applied: hasCodeTag || hasCodeText ? 1 : 0,
      reason: "코드/설정 인용이 있음",
    },
    {
      weight: PRACTICAL_WEIGHTS_V1.toolEntity,
      applied: toolEntities > 0 ? 1 : 0,
      reason: `도구/레포 entity ${toolEntities}건`,
    },
    {
      weight: PRACTICAL_WEIGHTS_V1.repositoryLink,
      applied: repositoryUrl ? 1 : 0,
      reason: "재현 가능한 repository 링크",
    },
    {
      weight: PRACTICAL_WEIGHTS_V1.opinionOnlyPenalty,
      applied: opinionOnly ? 1 : 0,
      reason: "의견/전망 위주 (감점)",
    },
    {
      weight: PRACTICAL_WEIGHTS_V1.noClaimPenalty,
      applied: claims.length === 0 ? 1 : 0,
      reason: "근거 claim 없음 (감점)",
    },
  ];

  const { score, reasons } = normalizeComponents(components);
  return { score, reasons, category: practicalSectionOf(input.classification) };
}

export const practicalRankingPolicyV1: RankingPolicy = {
  id: "ranking.practical",
  version: "1.0.1",
  threshold: RANKING_THRESHOLDS["ranking.practical"],
  rank: rankPractical,
};
