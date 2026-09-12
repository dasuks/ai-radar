/** 분석 Use Case 가 Run 에 돌려주는 요약. Run.llmUsage 와 같은 모양을 쓴다. */
export interface AnalyzeUsageEntry {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface AnalyzeSummary {
  status: "SUCCEEDED" | "PARTIAL" | "FAILED";
  /** 이번 실행에서 만들었거나 캐시로 재사용한 AnalysisRecord id */
  analysisIds: string[];
  llmCalls: number;
  cacheHits: number;
  /** schema/evidence 검증에서 버린 항목 수 (Run.counters.claimsRejected 에 더한다) */
  rejectedItems: number;
  notes: string[];
  usage: AnalyzeUsageEntry[];
}

export function emptyAnalyzeSummary(): AnalyzeSummary {
  return { status: "SUCCEEDED", analysisIds: [], llmCalls: 0, cacheHits: 0, rejectedItems: 0, notes: [], usage: [] };
}
