import type {
  CollectResult,
  SourceAdapter,
  SourceCheckpoint,
} from "../../ports/sources/source-adapter.js";
import type { CheckpointStore, RawStore } from "../../ports/storage/index.js";
import type { Clock, EventSink, HttpClient, Logger } from "../../ports/system/index.js";
import type { RawObservation } from "../../domain/documents/raw-observation.js";
import { validateRawObservation } from "../../domain/documents/raw-observation.js";
import type { TimeWindow } from "../../domain/shared/time.js";

/** adapter 의 `CollectResult.status` 에 Use Case 가 판정한 NO_NEW_ITEMS 를 더한 것 (PIPELINES §2.2). */
export type SourceRunStatus = "NO_NEW_ITEMS" | "COMPLETE" | "PARTIAL" | "FAILED";

export type CollectOverall = "ALL_OK" | "PARTIAL" | "ALL_FAILED" | "NO_NEW_ITEMS";

export type CollectError = CollectResult["errors"][number];
export type SourceCoverage = CollectResult["coverage"];

export interface PerSourceSummary {
  sourceId: string;
  status: SourceRunStatus;
  /** RawStore 에 새로 들어간 observation 수 */
  newObservations: number;
  /** adapter 가 돌려준 (검증을 통과한) observation 수 */
  observationsSeen: number;
  /** FAILED 면 adapter 가 준 coverage, 실행조차 못 했으면 null */
  coverage: SourceCoverage | null;
  errors: CollectError[];
}

export interface CollectSummary {
  perSource: PerSourceSummary[];
  overall: CollectOverall;
}

export interface CollectSourcesDefaults {
  maxItemsPerSource: number;
  perSourceTimeoutMs: number;
  overallDeadlineMs: number;
}

export interface CollectSourcesDeps {
  sources: readonly SourceAdapter[];
  raw: RawStore;
  checkpoints: CheckpointStore;
  http: HttpClient;
  clock: Clock;
  logger: Logger;
  events: EventSink;
  defaults: CollectSourcesDefaults;
}

export interface CollectInput {
  window: TimeWindow;
  runId: string;
  sourceIds?: readonly string[] | undefined;
}

/** 재시도 백오프 기준값. retryable 오류 1회 재시도 (PIPELINES §2.2 4번). */
const RETRY_BACKOFF_MS = 250;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function decideOverall(perSource: readonly PerSourceSummary[]): CollectOverall {
  if (perSource.length === 0) return "NO_NEW_ITEMS";
  const failed = perSource.filter((s) => s.status === "FAILED").length;
  if (failed === perSource.length) return "ALL_FAILED";
  if (failed > 0 || perSource.some((s) => s.status === "PARTIAL")) return "PARTIAL";
  if (perSource.every((s) => s.status === "NO_NEW_ITEMS")) return "NO_NEW_ITEMS";
  return "ALL_OK";
}

/**
 * CollectSources Use Case (PIPELINES_AND_POLICIES.md §2.2).
 *
 * 소스를 병렬로 돌리고, 결과를 검증해 RawStore 에 idempotent 하게 넣고,
 * COMPLETE/PARTIAL 일 때만 checkpoint 를 갱신한다. 절대 throw 하지 않는다.
 */
export class CollectSources {
  private readonly deps: CollectSourcesDeps;
  private readonly log: Logger;

  constructor(deps: CollectSourcesDeps) {
    this.deps = deps;
    this.log = deps.logger.child("collect");
  }

  async collect(input: CollectInput): Promise<CollectSummary> {
    const selected = this.selectSources(input.sourceIds);
    if (selected.length === 0) {
      this.log.warn("no sources selected", { requested: input.sourceIds?.length ?? 0 });
      return { perSource: [], overall: "NO_NEW_ITEMS" };
    }

    const overallDeadlineMs = this.deps.clock.nowMs() + this.deps.defaults.overallDeadlineMs;
    const settled = await Promise.allSettled(
      selected.map((adapter) => this.collectOne(adapter, input, overallDeadlineMs)),
    );

    const perSource: PerSourceSummary[] = settled.map((outcome, index) => {
      if (outcome.status === "fulfilled") return outcome.value;
      const sourceId = selected[index]?.descriptor.id ?? "unknown";
      this.log.error("source pipeline threw", { sourceId, error: errorName(outcome.reason) });
      return {
        sourceId,
        status: "FAILED",
        newObservations: 0,
        observationsSeen: 0,
        coverage: null,
        errors: [
          { kind: "UNKNOWN", message: `collect pipeline threw ${errorName(outcome.reason)}`, retryable: false },
        ],
      };
    });

    const summary: CollectSummary = { perSource, overall: decideOverall(perSource) };
    this.log.info("collect finished", {
      overall: summary.overall,
      sources: perSource.length,
      newObservations: perSource.reduce((sum, s) => sum + s.newObservations, 0),
    });
    return summary;
  }

  private selectSources(sourceIds: readonly string[] | undefined): SourceAdapter[] {
    if (!sourceIds) return [...this.deps.sources];
    const wanted = new Set(sourceIds);
    return this.deps.sources.filter((adapter) => wanted.has(adapter.descriptor.id));
  }

  private async collectOne(
    adapter: SourceAdapter,
    input: CollectInput,
    overallDeadlineMs: number,
  ): Promise<PerSourceSummary> {
    const sourceId = adapter.descriptor.id;
    try {
      const checkpoint = await this.loadCheckpoint(sourceId);
      let result = await this.runAttempt(adapter, input, checkpoint, overallDeadlineMs);

      if (result.status === "FAILED" && result.errors.some((e) => e.retryable)) {
        const backoffEndsAt = this.deps.clock.nowMs() + RETRY_BACKOFF_MS;
        if (backoffEndsAt < overallDeadlineMs) {
          this.log.warn("retrying source after retryable failure", { sourceId });
          await delay(RETRY_BACKOFF_MS);
          result = await this.runAttempt(adapter, input, checkpoint, overallDeadlineMs);
        }
      }

      return await this.applyResult(adapter, input, result);
    } catch (error) {
      this.log.error("source failed unexpectedly", { sourceId, error: errorName(error) });
      return {
        sourceId,
        status: "FAILED",
        newObservations: 0,
        observationsSeen: 0,
        coverage: null,
        errors: [{ kind: "UNKNOWN", message: `collect threw ${errorName(error)}`, retryable: false }],
      };
    }
  }

  private async loadCheckpoint(sourceId: string): Promise<SourceCheckpoint | null> {
    try {
      return await this.deps.checkpoints.get(sourceId);
    } catch (error) {
      this.log.warn("checkpoint unreadable, starting cold", { sourceId, error: errorName(error) });
      return null;
    }
  }

  /** adapter 한 번 실행. 계약 위반(throw)은 FAILED/UNKNOWN 으로 바꾼다. */
  private async runAttempt(
    adapter: SourceAdapter,
    input: CollectInput,
    checkpoint: SourceCheckpoint | null,
    overallDeadlineMs: number,
  ): Promise<CollectResult> {
    const sourceId = adapter.descriptor.id;
    const timeoutMs = Math.min(this.deps.defaults.perSourceTimeoutMs, adapter.descriptor.limits.defaultTimeoutMs);
    const deadlineMs = Math.min(this.deps.clock.nowMs() + timeoutMs, overallDeadlineMs);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, Math.max(1, deadlineMs - this.deps.clock.nowMs()));

    try {
      return await adapter.collect(
        {
          window: input.window,
          checkpoint,
          maxItems: Math.min(this.deps.defaults.maxItemsPerSource, adapter.descriptor.limits.maxItemsPerRun),
          deadlineAt: new Date(deadlineMs).toISOString(),
          runId: input.runId,
        },
        {
          signal: controller.signal,
          clock: this.deps.clock,
          logger: this.deps.logger,
          http: this.deps.http,
        },
      );
    } catch (error) {
      this.log.error("adapter threw from collect", { sourceId, error: errorName(error) });
      return {
        status: "FAILED",
        observations: [],
        nextCheckpoint: null,
        coverage: {
          windowRequested: input.window,
          windowCovered: null,
          truncated: false,
          truncationReason: null,
          itemsSeen: 0,
        },
        errors: [{ kind: "UNKNOWN", message: `adapter threw ${errorName(error)}`, retryable: false }],
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async applyResult(
    adapter: SourceAdapter,
    input: CollectInput,
    result: CollectResult,
  ): Promise<PerSourceSummary> {
    const sourceId = adapter.descriptor.id;
    const errors = [...result.errors];
    const valid = this.validate(result.observations, sourceId, errors);

    let newObservations = 0;
    for (const observation of valid) {
      let stored = false;
      try {
        stored = await this.deps.raw.putIfAbsent(observation);
      } catch (error) {
        this.log.error("raw store rejected observation", { sourceId, observationId: observation.id, error: errorName(error) });
        errors.push({ kind: "UNKNOWN", message: `raw store failed for one observation of ${sourceId}`, retryable: true });
        continue;
      }
      if (!stored) continue;
      newObservations += 1;
      this.deps.events.emit({ type: "ITEM_COLLECTED", observationId: observation.id, sourceId }, input.runId);
    }

    if (result.status !== "FAILED" && result.nextCheckpoint !== null) {
      try {
        await this.deps.checkpoints.put(sourceId, result.nextCheckpoint, input.runId, this.deps.clock.nowIso());
      } catch (error) {
        this.log.error("checkpoint not saved", { sourceId, error: errorName(error) });
        errors.push({ kind: "UNKNOWN", message: `checkpoint save failed for ${sourceId}`, retryable: true });
      }
    }

    return {
      sourceId,
      status: statusOf(result.status, newObservations),
      newObservations,
      observationsSeen: valid.length,
      coverage: result.coverage,
      errors,
    };
  }

  /** 계약을 어긴 observation 은 버리고 오류로 남긴다. 본문은 로그에 넣지 않는다. */
  private validate(observations: readonly RawObservation[], sourceId: string, errors: CollectError[]): RawObservation[] {
    const out: RawObservation[] = [];
    const seen = new Set<string>();
    for (const candidate of observations) {
      let validated: RawObservation;
      try {
        validated = validateRawObservation(candidate);
      } catch (error) {
        this.log.error("invalid observation dropped", {
          sourceId,
          externalId: typeof candidate?.externalId === "string" ? candidate.externalId : null,
          error: errorName(error),
        });
        errors.push({ kind: "PARSE", message: `invalid RawObservation from ${sourceId}`, retryable: false });
        continue;
      }
      if (seen.has(validated.id)) continue;
      seen.add(validated.id);
      out.push(validated);
    }
    return out;
  }
}

function statusOf(adapterStatus: CollectResult["status"], newObservations: number): SourceRunStatus {
  if (adapterStatus === "FAILED") return "FAILED";
  if (adapterStatus === "PARTIAL") return "PARTIAL";
  return newObservations === 0 ? "NO_NEW_ITEMS" : "COMPLETE";
}
