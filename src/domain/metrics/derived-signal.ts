import type { Provenance } from "../evidence/provenance.js";
import type { MetricKey, MetricSubjectType } from "./metric-observation.js";

export const SIGNAL_KEYS = [
  "mention_velocity",
  "mention_acceleration",
  "source_diversity",
  "star_delta_7d",
  "engagement_delta",
  "trend_score",
] as const;
export type SignalKey = (typeof SIGNAL_KEYS)[number];

export type SignalStatus = "COMPUTED" | "INSUFFICIENT_DATA" | "COLD_START" | "COVERAGE_CHANGED" | "SOURCE_FAILURE";

export interface DerivedSignalRef {
  subjectType: MetricSubjectType;
  subjectId: string;
  key: SignalKey;
  window: { start: string; end: string };
  policyVersion: string;
}

/** CONTRACTS_AND_DATA.md §3.2 (계산은 Phase 4) */
export interface DerivedSignal {
  schemaVersion: 1;
  subjectType: MetricSubjectType;
  subjectId: string;
  key: SignalKey;
  window: { start: string; end: string };
  previousWindow: { start: string; end: string } | null;
  value: number | null;
  status: SignalStatus;
  statusReason: string | null;
  inputs: { metricKey: MetricKey; observationCount: number; sourceIds: string[] }[];
  provenance: Provenance;
}
