import { artifactId as makeArtifactId } from "../../domain/shared/ids.js";
import type { Artifact, ChannelId, PublicationRecord } from "../../domain/artifacts/artifact.js";
import {
  isV1Briefing,
  parseDailyBriefingV1,
  upcastV1ToDailyBriefBody,
} from "../../domain/artifacts/daily-brief-v1.js";
import { parseDailyBriefBody, type DailyBriefBody } from "../../domain/artifacts/daily-brief.js";
import {
  decideRunStatus,
  type Run,
  type RunCounters,
  type RunError,
  type RunOutcomeInput,
  type RunStatus,
} from "../../domain/runs/run.js";
import type { TimeWindow } from "../../domain/shared/time.js";
import type { Publisher, Renderer, VaultPort } from "../../ports/publishing/index.js";
import type { ArtifactStore } from "../../ports/storage/index.js";
import type { Clock, EventSink, Logger } from "../../ports/system/index.js";
import { dailyBriefArtifact } from "../briefing/artifact-envelope.js";
import { publishArtifact } from "../publish/publish-artifact.js";
import { runLibrarian, type LibrarianResult } from "../librarian/run-librarian.js";

/** 수집·정규화·분석 단계가 붙기 전까지 Artifact 를 만들어 내는 입력 경로. */
export type BriefSource =
  | { kind: "manual"; filePath: string }
  | { kind: "auto"; build: (ctx: AutoBriefContext) => Promise<Artifact<DailyBriefBody>> };

/** `auto` BriefSource 가 받는 컨텍스트. Phase 3 의 BuildDailyBrief 가 여기에 연결된다. */
export interface AutoBriefContext {
  date: string;
  runId: string;
  timezone: string;
  window: TimeWindow;
  clock: Clock;
  logger: Logger;
  artifactStore: ArtifactStore;
}

/** 단계 기록기. `runtime/runs` 가 RunStore 로 구현한다 (application 은 runtime 을 import 하지 않는다). */
export interface RunRecorder {
  readonly runId: string;
  begin(stage: string): Promise<void>;
  end(stage: string, status: "DONE" | "FAILED" | "SKIPPED"): Promise<void>;
  addError(error: RunError): Promise<void>;
  updateCounters(mutate: (counters: RunCounters) => void): Promise<void>;
  addLlmUsage(entries: Run["llmUsage"]): Promise<void>;
}

export interface PipelineContext {
  readonly runId: string;
  readonly timezone: string;
  readonly window: TimeWindow;
  readonly dryRun: boolean;
  /** 입력 단계에서 확정된다 (수동 brief 는 파일의 date 를 따른다). */
  date: string;
  artifact: Artifact<DailyBriefBody> | null;
  collect: RunOutcomeInput["collect"];
  analysisFailed: boolean;
  analysisPartial: boolean;
  publications: PublicationRecord[];
  librarian: LibrarianResult | null;
  librarianFailed: boolean;
  errors: RunError[];
  warnings: string[];
}

export interface PipelineStage {
  readonly name: string;
  /** false 를 돌려주면 SKIPPED 로 기록하고 실행하지 않는다. */
  enabled(ctx: PipelineContext): boolean;
  run(ctx: PipelineContext): Promise<void>;
}

export interface ChannelWiring {
  channel: ChannelId;
  renderer: Renderer<DailyBriefBody>;
  publisher: Publisher;
}

export interface DailyPipelineDeps {
  clock: Clock;
  logger: Logger;
  events?: EventSink;
  artifactStore: ArtifactStore;
  recorder: RunRecorder;
  /** manual BriefSource 의 JSON 을 읽는다 (application 은 node:fs 를 쓰지 않는다). */
  readJson: (filePath: string) => Promise<unknown>;
  source: BriefSource;
  channels: ChannelWiring[];
  librarian: { vault: VaultPort; maxNotesPerRun: number } | null;
}

export interface RunDailyPipelineOptions {
  date: string;
  window: TimeWindow;
  timezone: string;
  dryRun: boolean;
  /** 기본 단계 목록 대신 쓸 단계 배열 (collect/normalize/analyze 를 앞에 붙일 때 사용) */
  stages?: PipelineStage[];
}

export interface RunDailyPipelineResult {
  runId: string;
  status: RunStatus;
  context: PipelineContext;
}

/** 입력 단계: BriefSource → Artifact<DailyBriefBody>. */
export function inputStage(deps: DailyPipelineDeps): PipelineStage {
  return {
    name: "input",
    enabled: () => true,
    async run(ctx) {
      const artifact =
        deps.source.kind === "auto"
          ? await deps.source.build({
              date: ctx.date,
              runId: ctx.runId,
              timezone: ctx.timezone,
              window: ctx.window,
              clock: deps.clock,
              logger: deps.logger,
              artifactStore: deps.artifactStore,
            })
          : await buildManualArtifact(deps, ctx);

      const head = await deps.artifactStore.head(artifact.type, artifact.targetKey);
      const next: Artifact<DailyBriefBody> =
        artifact.revision > 0 ? artifact : { ...artifact, revision: (head?.revision ?? 0) + 1 };
      const storedHead = await deps.artifactStore.putRevision(next);
      ctx.artifact = storedHead.revision === next.revision ? next : { ...next, revision: storedHead.revision };
      ctx.date = ctx.artifact.body.date;
      await deps.recorder.updateCounters((counters) => {
        if (!counters.artifactsCreated.includes(ctx.artifact!.id)) counters.artifactsCreated.push(ctx.artifact!.id);
      });
      deps.events?.emit(
        { type: "ARTIFACT_CREATED", artifactId: ctx.artifact.id, revision: ctx.artifact.revision },
        ctx.runId,
      );
      deps.logger.info(`artifact ${ctx.artifact.id} revision ${ctx.artifact.revision}`, {
        items: ctx.artifact.body.sections.reduce((total, section) => total + section.items.length, 0),
      });
    },
  };
}

async function buildManualArtifact(
  deps: DailyPipelineDeps,
  ctx: PipelineContext,
): Promise<Artifact<DailyBriefBody>> {
  if (deps.source.kind !== "manual") throw new Error("buildManualArtifact called for a non-manual source");
  const raw = await deps.readJson(deps.source.filePath);
  let body: DailyBriefBody;
  if (isV1Briefing(raw)) {
    const v1 = parseDailyBriefingV1(raw);
    body = upcastV1ToDailyBriefBody(v1, makeArtifactId("DAILY_BRIEF", v1.date));
  } else {
    body = parseDailyBriefBody(raw);
  }
  if (body.date !== ctx.date) {
    deps.logger.warn(`manual brief is dated ${body.date}; using it instead of the requested ${ctx.date}`);
  }
  return dailyBriefArtifact({
    date: body.date,
    body,
    inputs: {
      claimIds: [],
      documentIds: body.sources.map((source) => source.documentId),
      signalRefs: [],
      rankingPolicies: [{ id: "manual", version: "0" }],
      runId: ctx.runId,
    },
    visibility: "PRIVATE",
    timezone: ctx.timezone,
    window: ctx.window,
    createdAt: deps.clock.nowIso(),
  });
}

/** 채널 발행 단계. 한 채널의 실패가 다른 채널을 막지 않는다 (R-P1). */
export function publishStage(deps: DailyPipelineDeps, wiring: ChannelWiring): PipelineStage {
  return {
    name: `publish:${wiring.channel}`,
    enabled: (ctx) => ctx.artifact !== null,
    async run(ctx) {
      const artifact = ctx.artifact;
      if (!artifact) return;
      const record = await publishArtifact({
        artifact,
        channel: wiring.channel,
        renderer: wiring.renderer,
        publisher: wiring.publisher,
        artifactStore: deps.artifactStore,
        runId: ctx.runId,
        dryRun: ctx.dryRun,
        clock: deps.clock,
        logger: deps.logger.child(wiring.channel),
      });
      ctx.publications.push(record);
      await deps.recorder.updateCounters((counters) => {
        counters.publications.push(`${wiring.channel}:${record.status}`);
      });
      deps.events?.emit(
        { type: "PUBLICATION_COMPLETED", artifactId: artifact.id, channel: wiring.channel, externalId: record.externalId },
        ctx.runId,
      );
      if (record.status !== "SUCCEEDED") {
        const error: RunError = {
          stage: `publish:${wiring.channel}`,
          message: record.error ?? `publication status ${record.status}`,
          retryable: true,
        };
        ctx.errors.push(error);
        await deps.recorder.addError(error);
      }
    },
  };
}

/** Librarian 단계. Obsidian Daily Note 경로가 있어야 실행된다. */
export function librarianStage(deps: DailyPipelineDeps): PipelineStage {
  return {
    name: "librarian",
    enabled: (ctx) => deps.librarian !== null && obsidianNotePath(ctx) !== null,
    async run(ctx) {
      const librarian = deps.librarian;
      const dailyNotePath = obsidianNotePath(ctx);
      if (!librarian || !dailyNotePath || !ctx.artifact) return;
      const result = await runLibrarian({
        body: ctx.artifact.body,
        vault: librarian.vault,
        dailyNotePath,
        maxNotesPerRun: librarian.maxNotesPerRun,
        dryRun: ctx.dryRun,
        logger: deps.logger.child("librarian"),
      });
      ctx.librarian = result;
      if (result.failures.length > 0) {
        ctx.librarianFailed = true;
        for (const failure of result.failures) {
          const error: RunError = {
            stage: "librarian",
            message: `${failure.title}: ${failure.error}`,
            retryable: false,
          };
          ctx.errors.push(error);
          await deps.recorder.addError(error);
        }
      }
      deps.logger.info(
        `knowledge notes: ${result.created.length} created, ${result.updated.length} updated, ${result.failures.length} failed`,
      );
    },
  };
}

function obsidianNotePath(ctx: PipelineContext): string | null {
  const record = [...ctx.publications]
    .reverse()
    .find((item) => item.channel === "obsidian" && item.status === "SUCCEEDED");
  return record?.externalId ?? null;
}

/** Phase 1 기본 단계 목록. 앞에 collect/normalize/analyze 단계를 덧붙일 수 있다. */
export function buildDailyStages(deps: DailyPipelineDeps): PipelineStage[] {
  return [inputStage(deps), ...deps.channels.map((wiring) => publishStage(deps, wiring)), librarianStage(deps)];
}

/**
 * RunDailyPipeline (PIPELINES_AND_POLICIES.md §1, §4).
 * 단계는 순서 있는 배열이고 공통 컨텍스트를 공유한다. 각 단계는 격리되어 있어
 * 한 단계가 실패해도 남은 단계가 실행되며, Run 상태는 마지막에 `decideRunStatus` 가 판정한다.
 */
export async function runDailyPipeline(
  deps: DailyPipelineDeps,
  options: RunDailyPipelineOptions,
): Promise<RunDailyPipelineResult> {
  const ctx: PipelineContext = {
    runId: deps.recorder.runId,
    timezone: options.timezone,
    window: options.window,
    dryRun: options.dryRun,
    date: options.date,
    artifact: null,
    collect: deps.source.kind === "manual" ? "SKIPPED" : "ALL_OK",
    analysisFailed: false,
    analysisPartial: false,
    publications: [],
    librarian: null,
    librarianFailed: false,
    errors: [],
    warnings: [],
  };

  const stages = options.stages ?? buildDailyStages(deps);
  for (const stage of stages) {
    if (!stage.enabled(ctx)) {
      await deps.recorder.end(stage.name, "SKIPPED");
      deps.logger.info(`stage ${stage.name} skipped`);
      continue;
    }
    await deps.recorder.begin(stage.name);
    try {
      await stage.run(ctx);
      await deps.recorder.end(stage.name, "DONE");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const runError: RunError = { stage: stage.name, message, retryable: false };
      ctx.errors.push(runError);
      await deps.recorder.addError(runError);
      await deps.recorder.end(stage.name, "FAILED");
      deps.logger.error(`stage ${stage.name} failed: ${message}`);
      if (stage.name === "input") {
        // 입력이 없으면 이후 단계는 의미가 없다.
        break;
      }
      if (stage.name === "librarian") ctx.librarianFailed = true;
    }
  }

  const channelsAttempted = ctx.publications.length;
  const channelsFailed = ctx.publications.filter((record) => record.status !== "SUCCEEDED").length;
  const inputFailed = ctx.artifact === null;
  const status = inputFailed
    ? "ABORTED"
    : decideRunStatus({
        collect: ctx.collect,
        analysisFailed: ctx.analysisFailed,
        analysisPartial: ctx.analysisPartial,
        artifactCreated: ctx.artifact !== null,
        channelsAttempted,
        channelsFailed,
        librarianFailed: ctx.librarianFailed,
      });

  return { runId: ctx.runId, status, context: ctx };
}
