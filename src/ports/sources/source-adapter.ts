import type { ContentCompleteness, RawObservation, SourceKind } from "../../domain/documents/raw-observation.js";
import type { NormalizedDocument } from "../../domain/documents/normalized-document.js";
import type { MetricKey } from "../../domain/metrics/metric-observation.js";
import type { TimeWindow } from "../../domain/shared/time.js";
import type { Clock, HttpClient, Logger } from "../system/index.js";

/** PIPELINES_AND_POLICIES.md §2.1 */
export interface SourceDescriptor {
  id: string;
  kind: SourceKind;
  capabilities: {
    timeWindow: boolean;
    cursor: boolean;
    checkpoint: boolean;
    comments: boolean;
    metrics: MetricKey[];
    expectedCompleteness: ContentCompleteness;
  };
  limits: { requestsPerMinute: number | null; maxItemsPerRun: number; defaultTimeoutMs: number };
  license: { name: string; url: string | null; attributionRequired: boolean };
}

export type SourceCheckpoint = { schemaVersion: number; data: unknown };

export interface CollectRequest {
  window: TimeWindow;
  checkpoint: SourceCheckpoint | null;
  maxItems: number;
  deadlineAt: string;
  runId: string;
}

export interface CollectContext {
  signal: AbortSignal;
  clock: Clock;
  logger: Logger;
  http: HttpClient;
}

export type CollectErrorKind = "ACCESS" | "RATE_LIMIT" | "TIMEOUT" | "PARSE" | "NETWORK" | "UNKNOWN";

export interface CollectResult {
  status: "COMPLETE" | "PARTIAL" | "FAILED";
  observations: RawObservation[];
  nextCheckpoint: SourceCheckpoint | null;
  coverage: {
    windowRequested: TimeWindow;
    windowCovered: TimeWindow | null;
    truncated: boolean;
    truncationReason: "MAX_ITEMS" | "DEADLINE" | "RATE_LIMIT" | "PAGINATION_LIMIT" | null;
    itemsSeen: number;
  };
  errors: { kind: CollectErrorKind; message: string; retryable: boolean }[];
}

export interface NormalizeInput {
  observation: RawObservation;
  /** 같은 (sourceId, externalId)의 기존 문서. 있으면 firstObservationId 를 유지한다 */
  existing: NormalizedDocument | null;
  runId: string;
  normalizedAt: string;
}

export interface SourceAdapter {
  readonly descriptor: SourceDescriptor;
  collect(request: CollectRequest, ctx: CollectContext): Promise<CollectResult>;
  /** 소스 고유 payload → NormalizedDocument. 순수 함수여야 한다 (I/O 없음). */
  normalize(input: NormalizeInput): NormalizedDocument;
}
