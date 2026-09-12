import type { MetricKey } from "../metrics/metric-observation.js";
import { evidenceId } from "../shared/ids.js";

export type EvidenceLocator =
  | { kind: "document" }
  | { kind: "excerpt"; start: number; end: number; text: string }
  | { kind: "comment"; commentExternalId: string; text: string }
  | { kind: "metric"; metricKey: MetricKey; observedAt: string };

/** CONTRACTS_AND_DATA.md §4.1 */
export interface Evidence {
  schemaVersion: 1;
  id: string;
  documentId: string;
  observationId: string;
  locator: EvidenceLocator;
  capturedAt: string;
  publishedAt: string | null;
}

export function locatorKey(locator: EvidenceLocator): string {
  switch (locator.kind) {
    case "document":
      return "document";
    case "excerpt":
      return `excerpt:${locator.start}:${locator.end}`;
    case "comment":
      return `comment:${locator.commentExternalId}`;
    case "metric":
      return `metric:${locator.metricKey}:${locator.observedAt}`;
  }
}

export function makeEvidence(input: {
  documentId: string;
  observationId: string;
  locator: EvidenceLocator;
  capturedAt: string;
  publishedAt: string | null;
}): Evidence {
  return {
    schemaVersion: 1,
    id: evidenceId(input.documentId, locatorKey(input.locator)),
    documentId: input.documentId,
    observationId: input.observationId,
    locator: input.locator,
    capturedAt: input.capturedAt,
    publishedAt: input.publishedAt,
  };
}

/** 인용 가능한 텍스트를 돌려준다 (LLM 입력·렌더용). */
export function evidenceText(evidence: Evidence, documentContent: string | null): string {
  switch (evidence.locator.kind) {
    case "excerpt":
    case "comment":
      return evidence.locator.text;
    case "metric":
      return `${evidence.locator.metricKey} @ ${evidence.locator.observedAt}`;
    case "document":
      return documentContent ?? "";
  }
}
