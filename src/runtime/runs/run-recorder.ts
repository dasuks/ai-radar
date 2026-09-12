import {
  emptyCounters,
  type Run,
  type RunCounters,
  type RunError,
  type RunKind,
  type RunStage,
  type RunStatus,
} from "../../domain/runs/run.js";
import { runId as makeRunId } from "../../domain/shared/ids.js";
import type { TimeWindow } from "../../domain/shared/time.js";
import type { RunStore } from "../../ports/storage/index.js";
import type { Clock, RandomSource } from "../../ports/system/index.js";
import type { RunRecorder } from "../../application/runs/run-daily-pipeline.js";

export interface StartRunOptions {
  store: RunStore;
  clock: Clock;
  random?: RandomSource;
  kind: RunKind;
  window: TimeWindow;
  timezone: string;
  /** 미리 알고 있는 단계 이름 (PENDING 으로 기록해 둔다) */
  stages: string[];
}

/**
 * Run lifecycle 기록기.
 * 단계가 바뀔 때마다 RunStore 로 flush 한다 (프로세스가 죽어도 어디까지 했는지 남는다, PIPELINES §4).
 */
export class JsonRunRecorder implements RunRecorder {
  private constructor(
    private run: Run,
    private readonly store: RunStore,
    private readonly clock: Clock,
  ) {}

  static async start(options: StartRunOptions): Promise<JsonRunRecorder> {
    const random = options.random;
    const id = makeRunId(options.clock.nowMs(), random ? (n) => random.bytes(n) : undefined);
    const run: Run = {
      schemaVersion: 1,
      id,
      kind: options.kind,
      startedAt: options.clock.nowIso(),
      finishedAt: null,
      targetWindow: options.window,
      timezone: options.timezone,
      status: "RUNNING",
      counters: emptyCounters(),
      llmUsage: [],
      errors: [],
      stages: options.stages.map((name) => stage(name, "PENDING")),
    };
    const recorder = new JsonRunRecorder(run, options.store, options.clock);
    await recorder.flush();
    return recorder;
  }

  get runId(): string {
    return this.run.id;
  }

  get snapshot(): Run {
    return this.run;
  }

  async begin(name: string): Promise<void> {
    const existing = this.stageOf(name);
    const next: RunStage = {
      name,
      status: "RUNNING",
      startedAt: this.clock.nowIso(),
      finishedAt: null,
      checkpoint: existing?.checkpoint ?? null,
    };
    this.replaceStage(next);
    await this.flush();
  }

  async end(name: string, status: "DONE" | "FAILED" | "SKIPPED"): Promise<void> {
    const existing = this.stageOf(name);
    const next: RunStage = {
      name,
      status,
      startedAt: existing?.startedAt ?? (status === "SKIPPED" ? null : this.clock.nowIso()),
      finishedAt: this.clock.nowIso(),
      checkpoint: existing?.checkpoint ?? null,
    };
    this.replaceStage(next);
    await this.flush();
  }

  async addError(error: RunError): Promise<void> {
    this.run = { ...this.run, errors: [...this.run.errors, error] };
    await this.flush();
  }

  async updateCounters(mutate: (counters: RunCounters) => void): Promise<void> {
    const counters: RunCounters = { ...this.run.counters };
    mutate(counters);
    this.run = { ...this.run, counters };
    await this.flush();
  }

  async addLlmUsage(entries: Run["llmUsage"]): Promise<void> {
    if (entries.length === 0) return;
    this.run = { ...this.run, llmUsage: [...this.run.llmUsage, ...entries] };
    await this.flush();
  }

  async finish(status: RunStatus): Promise<Run> {
    this.run = { ...this.run, status, finishedAt: this.clock.nowIso() };
    await this.flush();
    return this.run;
  }

  private stageOf(name: string): RunStage | undefined {
    return this.run.stages.find((item) => item.name === name);
  }

  private replaceStage(next: RunStage): void {
    const stages = this.run.stages.some((item) => item.name === next.name)
      ? this.run.stages.map((item) => (item.name === next.name ? next : item))
      : [...this.run.stages, next];
    this.run = { ...this.run, stages };
  }

  private async flush(): Promise<void> {
    await this.store.put(this.run);
  }
}

function stage(name: string, status: RunStage["status"]): RunStage {
  return { name, status, startedAt: null, finishedAt: null, checkpoint: null };
}
