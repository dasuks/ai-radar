/**
 * 검증된 항목이 하나도 없을 때의 Daily Brief 본문.
 * 빈 brief 대신 "왜 비었는지"를 남긴다 (PIPELINES_AND_POLICIES.md §4, R-A1).
 */
import type { DailyBriefBody, RunCoverageSummary } from "../../domain/artifacts/daily-brief.js";

export interface UnverifiedBriefInput {
  date: string;
  title: string;
  /** 이 Run 에서 본 관측 수 */
  observed: number;
  /** window 안에 들어온 문서 수 */
  documentsInWindow: number;
  /** 분석 단계가 남긴 사유 (사용자에게 보여줄 짧은 문장) */
  reason: string;
  coverage: RunCoverageSummary;
}

export function buildUnverifiedBrief(input: UnverifiedBriefInput): DailyBriefBody {
  return {
    bodySchemaVersion: 2,
    date: input.date,
    title: input.title,
    oneMinuteSummary: [
      input.coverage.sourcesFailed.length > 0 && input.coverage.sourcesFailed.length === input.coverage.sourcesAttempted.length
        ? `수집에 실패해 오늘 브리핑을 만들지 못했습니다 (실패 소스: ${input.coverage.sourcesFailed.join(", ")}).`
        : `오늘 검증을 통과한 항목이 없습니다. 수집 ${input.observed}건, window 내 문서 ${input.documentsInWindow}건.`,
      `분석 상태: ${input.reason}`,
    ],
    sections: [],
    learnOneThing: null,
    applyCandidates: [],
    sources: [],
    coverage: input.coverage,
    digest: null,
  };
}
