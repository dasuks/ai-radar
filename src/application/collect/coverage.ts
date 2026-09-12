/** 수집 결과 → Artifact 에 실리는 coverage 요약 (CONTRACTS_AND_DATA.md §5.2). 순수 함수. */
import type { RunCoverageSummary } from "../../domain/artifacts/daily-brief.js";
import type { CollectSummary } from "./collect-sources.js";

/**
 * collect 단계 요약을 Daily Brief 의 coverage 로 옮긴다.
 * summary 가 없으면(=collect 단계 미실행) 시도한 source 목록만 남긴다.
 */
export function runCoverageSummary(
  summary: CollectSummary | null,
  sourceIds: readonly string[],
): RunCoverageSummary {
  if (!summary) {
    return { sourcesAttempted: [...sourceIds], sourcesFailed: [], partial: false, note: "collect stage did not run" };
  }
  const failed = summary.perSource.filter((s) => s.status === "FAILED").map((s) => s.sourceId);
  const partial = summary.perSource.some((s) => s.status === "PARTIAL" || s.status === "FAILED");
  return {
    sourcesAttempted: summary.perSource.map((s) => s.sourceId),
    sourcesFailed: failed,
    partial,
    note: failed.length > 0 ? `수집 실패: ${failed.join(", ")}` : null,
  };
}
