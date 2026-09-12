import type { MetricStore } from "../../ports/storage/index.js";
import type { EventSink, Logger } from "../../ports/system/index.js";
import type { NormalizedDocument } from "../../domain/documents/normalized-document.js";
import type { CoverageNote, MetricKey, MetricObservation } from "../../domain/metrics/metric-observation.js";
import { metricScopeViolations } from "../../domain/metrics/metric-observation.js";
import type { CollectSummary } from "../collect/collect-sources.js";

export interface RecordMetricsDeps {
  metrics: MetricStore;
  logger: Logger;
  events: EventSink;
}

export interface RecordMetricsInput {
  documents: readonly NormalizedDocument[];
  runId: string;
  /** 이번 Run 의 수집 범위. CoverageNote 로 바뀐다 (CONTRACTS §3.1). */
  summary: CollectSummary;
}

export interface RecordMetricsResult {
  recorded: number;
  skipped: number;
  observations: MetricObservation[];
}

/** 점수형 metric 은 unit=score, 나머지는 count. */
const SCORE_KEYS: ReadonlySet<string> = new Set<MetricKey>(["hn.points", "reddit.score"]);

function unitOf(key: MetricKey): MetricObservation["unit"] {
  return SCORE_KEYS.has(key) ? "score" : "count";
}

/** CollectSummary → CoverageNote. sourceId 는 우리 코드가 만든 값이므로 note 에 넣어도 안전하다. */
export function coverageFromSummary(summary: CollectSummary): CoverageNote {
  const failed = summary.perSource.filter((s) => s.status === "FAILED").map((s) => s.sourceId);
  return {
    sourcesAttempted: summary.perSource.length,
    sourcesSucceeded: summary.perSource.length - failed.length,
    truncated: summary.perSource.some((s) => s.coverage?.truncated === true),
    note: failed.length > 0 ? `failed sources: ${failed.join(", ")}` : null,
  };
}

/**
 * RecordMetrics Use Case (PIPELINES_AND_POLICIES.md §3.4, 문서 metric 부분).
 *
 * normalizer 가 채운 `document.metrics` 를 subjectType=DOCUMENT, scope=ITEM 관측으로 기록한다.
 * scope validator 를 어긴 값은 저장하지 않고 오류로 남긴다 (CONTRACTS §3.1).
 */
export class RecordMetrics {
  private readonly deps: RecordMetricsDeps;
  private readonly log: Logger;

  constructor(deps: RecordMetricsDeps) {
    this.deps = deps;
    this.log = deps.logger.child("metrics");
  }

  async record(input: RecordMetricsInput): Promise<RecordMetricsResult> {
    const coverage = coverageFromSummary(input.summary);
    const observations: MetricObservation[] = [];
    let skipped = 0;

    for (const document of input.documents) {
      for (const snapshot of document.metrics) {
        const candidate: MetricObservation = {
          schemaVersion: 1,
          subjectType: "DOCUMENT",
          subjectId: document.id,
          key: snapshot.key,
          value: snapshot.value,
          unit: unitOf(snapshot.key),
          scope: "ITEM",
          observedAt: snapshot.observedAt,
          window: null,
          sourceId: document.sourceId,
          observationId: document.latestObservationId,
          coverage,
        };
        const violations = metricScopeViolations({
          key: candidate.key,
          scope: candidate.scope,
          subjectType: candidate.subjectType,
          window: candidate.window,
        });
        if (violations.length > 0) {
          skipped += 1;
          this.log.error("metric rejected by scope validator", {
            documentId: document.id,
            key: candidate.key,
            violations: violations.join("; "),
          });
          continue;
        }
        observations.push(candidate);
      }
    }

    if (observations.length === 0) {
      this.log.info("metrics finished", { recorded: 0, skipped });
      return { recorded: 0, skipped, observations };
    }

    let recorded = 0;
    try {
      recorded = await this.deps.metrics.record(observations);
    } catch (error) {
      this.log.error("metric store failed", {
        count: observations.length,
        error: error instanceof Error ? error.name : "UnknownError",
      });
      return { recorded: 0, skipped: skipped + observations.length, observations };
    }

    for (const observation of observations) {
      this.deps.events.emit(
        { type: "METRIC_RECORDED", subjectId: observation.subjectId, key: observation.key },
        input.runId,
      );
    }

    this.log.info("metrics finished", { recorded, skipped });
    return { recorded, skipped, observations };
  }
}
