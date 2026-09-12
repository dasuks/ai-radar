import type { ChannelId } from "../artifacts/artifact.js";
import type { MetricKey } from "../metrics/metric-observation.js";

export const RUN_STATUSES = [
  "RUNNING",
  "SUCCESS",
  "PARTIAL_SUCCESS",
  "NO_NEW_INFORMATION",
  "SOURCE_FAILURE",
  "ANALYSIS_FAILURE",
  "OUTPUT_FAILURE",
  "ABORTED",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export type RunKind = "DAILY" | "WEEKLY" | "REANALYZE" | "PUBLISH_ONLY" | "LIBRARIAN_ONLY";

export interface RunStage {
  name: string;
  status: "PENDING" | "RUNNING" | "DONE" | "FAILED" | "SKIPPED";
  startedAt: string | null;
  finishedAt: string | null;
  checkpoint: unknown | null;
}

export interface RunError {
  stage: string;
  sourceId?: string;
  message: string;
  retryable: boolean;
}

export interface RunCounters {
  sourcesAttempted: string[];
  sourcesSucceeded: string[];
  sourcesFailed: string[];
  observationsCollected: number;
  observationsNew: number;
  documentsUpserted: number;
  linksCreated: number;
  entitiesResolved: number;
  metricsRecorded: number;
  signalsComputed: number;
  claimsCreated: number;
  claimsRejected: number;
  artifactsCreated: string[];
  publications: string[];
}

/** CONTRACTS_AND_DATA.md §6.1 */
export interface Run {
  schemaVersion: 1;
  id: string;
  kind: RunKind;
  startedAt: string;
  finishedAt: string | null;
  targetWindow: { start: string; end: string };
  timezone: string;
  status: RunStatus;
  counters: RunCounters;
  llmUsage: { provider: string; model: string; inputTokens: number; outputTokens: number; costUsd: number | null }[];
  errors: RunError[];
  stages: RunStage[];
}

export function emptyCounters(): RunCounters {
  return {
    sourcesAttempted: [],
    sourcesSucceeded: [],
    sourcesFailed: [],
    observationsCollected: 0,
    observationsNew: 0,
    documentsUpserted: 0,
    linksCreated: 0,
    entitiesResolved: 0,
    metricsRecorded: 0,
    signalsComputed: 0,
    claimsCreated: 0,
    claimsRejected: 0,
    artifactsCreated: [],
    publications: [],
  };
}

export interface RunOutcomeInput {
  collect: "ALL_OK" | "PARTIAL" | "ALL_FAILED" | "NO_NEW_ITEMS" | "SKIPPED";
  analysisFailed: boolean;
  /** LLM 예산 소진·배치 실패로 분석이 일부만 끝남 (PIPELINES §5.4) */
  analysisPartial?: boolean;
  artifactCreated: boolean;
  channelsAttempted: number;
  channelsFailed: number;
  librarianFailed: boolean;
}

/** PIPELINES_AND_POLICIES.md §4 판정식 */
export function decideRunStatus(input: RunOutcomeInput): RunStatus {
  if (input.collect === "ALL_FAILED") return "SOURCE_FAILURE";
  if (input.analysisFailed) return "ANALYSIS_FAILURE";
  if (input.channelsAttempted > 0 && input.channelsFailed === input.channelsAttempted) return "OUTPUT_FAILURE";
  if (input.collect === "NO_NEW_ITEMS" && !input.artifactCreated) return "NO_NEW_INFORMATION";
  if (input.collect === "PARTIAL" || input.analysisPartial || input.channelsFailed > 0 || input.librarianFailed) return "PARTIAL_SUCCESS";
  return "SUCCESS";
}

export type DomainEvent =
  | { type: "ITEM_COLLECTED"; observationId: string; sourceId: string }
  | { type: "ITEM_NORMALIZED"; documentId: string }
  | { type: "ENTITY_RESOLVED"; entityId: string; documentId: string }
  | { type: "METRIC_RECORDED"; subjectId: string; key: MetricKey }
  | { type: "ANALYSIS_CREATED"; analysisId: string }
  | { type: "ARTIFACT_CREATED"; artifactId: string; revision: number }
  | { type: "KNOWLEDGE_PROPOSED"; proposalId: string }
  | { type: "PUBLICATION_REQUESTED"; artifactId: string; channel: ChannelId }
  | { type: "PUBLICATION_COMPLETED"; artifactId: string; channel: ChannelId; externalId: string | null };
