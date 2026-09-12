/**
 * 문서 우선순위 정책 — 어떤 문서를 LLM 분석에 태울지 고르는 순수 규칙.
 * PIPELINES_AND_POLICIES.md §5 (분석 대상 상한). 순수 함수만 둔다 (policies 계층).
 */
import type { NormalizedDocument } from "../../domain/documents/normalized-document.js";

export const DOCUMENT_PRIORITY_POLICY_ID = "classification.document-priority";
export const DOCUMENT_PRIORITY_POLICY_VERSION = "1.0.0";

const COMPLETENESS_WEIGHT: Record<NormalizedDocument["contentCompleteness"], number> = {
  FULL: 3,
  EXCERPT: 2,
  TITLE_ONLY: 1,
  MISSING: 0,
};

/** 문서 우선순위: 본문 완전성 + engagement 점수. 분석 대상 상한을 정할 때 쓴다. */
export function documentPriority(document: NormalizedDocument): number {
  const completeness = COMPLETENESS_WEIGHT[document.contentCompleteness];
  const points = document.metrics.find((m) => m.key === "hn.points")?.value ?? 0;
  const comments = document.metrics.find((m) => m.key === "hn.comments")?.value ?? 0;
  return completeness * 10 + Math.log10(1 + points) * 5 + Math.log10(1 + comments) * 3;
}

/** 우선순위 내림차순으로 정렬해 상위 `limit` 건만 남긴다. 입력 배열은 바꾸지 않는다. */
export function selectAnalysisCandidates(
  documents: readonly NormalizedDocument[],
  limit: number,
): NormalizedDocument[] {
  return [...documents].sort((a, b) => documentPriority(b) - documentPriority(a)).slice(0, limit);
}
