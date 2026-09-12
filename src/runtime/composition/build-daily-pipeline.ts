import { calendarDateIn, trailingWindow, type TimeWindow } from "../../domain/shared/time.js";
import type { Publisher, VaultPort } from "../../ports/publishing/index.js";
import type { Clock, EventSink, HttpClient, Logger, RandomSource } from "../../ports/system/index.js";
import {
  buildDailyStages,
  runDailyPipeline,
  type BriefSource,
  type ChannelWiring,
  type DailyPipelineDeps,
  type PipelineStage,
  type RunDailyPipelineResult,
} from "../../application/runs/run-daily-pipeline.js";
import { NotionPublisher, type NotionClient } from "../../adapters/notion/notion-publisher.js";
import { NotionReportsPublisher } from "../../adapters/notion/notion-reports-publisher.js";
import { ObsidianDailyPublisher } from "../../adapters/obsidian/daily-publisher.js";
import { ObsidianVault } from "../../adapters/obsidian/vault.js";
import { MarkdownDailyRenderer } from "../../adapters/rendering/markdown/daily-renderer.js";
import { NotionBlocksRenderer } from "../../adapters/rendering/notion-blocks/daily-renderer.js";
import { NotionSectionReportRenderer } from "../../adapters/rendering/notion-blocks/section-report-renderer.js";
import { NotionDigestRenderer } from "../../adapters/rendering/notion-blocks/digest-renderer.js";
import { readJsonFile } from "../../adapters/storage/json-files/json-file.js";
import { openSqliteStores } from "../../adapters/storage/sqlite/index.js";
import { HackerNewsSource } from "../../adapters/sources/hackernews/index.js";
import { createRssSources } from "../../adapters/sources/rss/index.js";
import { CodexCliProvider } from "../../adapters/llm/codex-cli/index.js";
import { FetchHttpClient } from "../../adapters/system/http-client.js";
import type { SourceAdapter } from "../../ports/sources/source-adapter.js";
import type { LlmProvider } from "../../ports/llm/llm-provider.js";
import type { Stores } from "../../ports/storage/index.js";
import { looksAiRelated } from "../../policies/classification/source-relevance.js";
import { buildIntelligenceWiring, type ReportChannels } from "./intelligence-wiring.js";
import { ConsoleLogger } from "../../adapters/system/logger.js";
import { LogEventSink } from "../../adapters/system/event-sink.js";
import { NodeRandom } from "../../adapters/system/random.js";
import { SystemClock } from "../../adapters/system/clock.js";
import { JsonRunRecorder } from "../runs/run-recorder.js";
import type { AppConfig } from "../config/app-config.js";

export interface DailyRunOptions {
  /** YYYY-MM-DD. 생략하면 config.timezone 기준 오늘 */
  date?: string;
  /** 수동 입력 파일 경로 (`--input`) */
  input?: string | null;
  dryRun?: boolean;
  skipNotion?: boolean;
  skipObsidian?: boolean;
  skipLibrarian?: boolean;
}

export interface DailyPipelineOverrides {
  clock?: Clock;
  logger?: Logger;
  random?: RandomSource;
  events?: EventSink;
  vault?: VaultPort;
  notionClient?: NotionClient;
  notionPublisher?: Publisher;
  obsidianPublisher?: Publisher;
  /** 리포트 발행 채널 교체 (테스트). null 을 주면 reports 단계가 SKIPPED 된다 */
  reportChannels?: ReportChannels | null;
  /** 자동 Daily Brief 생성 훅 (Phase 3 에서 BuildDailyBrief 가 연결된다) */
  autoBrief?: Extract<BriefSource, { kind: "auto" }>["build"];
  readJson?: (filePath: string) => Promise<unknown>;
  /** 기본 단계 앞에 붙일 단계 (collect/normalize/analyze) */
  stagesBefore?: (deps: DailyPipelineDeps) => PipelineStage[];
  /** 저장소 교체 (테스트: createMemoryStores) */
  stores?: Stores;
  /** Source 교체 (테스트: fixture adapter) */
  sources?: SourceAdapter[];
  /** LLM 교체 (테스트: FakeLlmProvider) */
  llm?: LlmProvider;
  http?: HttpClient;
}

export interface DailyPipeline {
  run(options?: DailyRunOptions): Promise<RunDailyPipelineResult>;
}

/**
 * Composition Root (ARCHITECTURE.md §3.2).
 * 설정을 읽어 adapter 를 만들고 Use Case 에 주입한다. 비즈니스 규칙은 두지 않는다.
 */
export function buildDailyPipeline(config: AppConfig, overrides: DailyPipelineOverrides = {}): DailyPipeline {
  const clock = overrides.clock ?? new SystemClock();
  const logger = overrides.logger ?? new ConsoleLogger({ redact: config.redaction });
  const random = overrides.random ?? new NodeRandom();
  const events = overrides.events ?? new LogEventSink(logger.child("events"));
  const readJson = overrides.readJson ?? readJsonFile;

  const stores = overrides.stores ?? openSqliteStores({ dir: config.store.dir, rawPayloadRoot: config.store.dir });
  const artifactStore = stores.artifacts;
  const runStore = stores.runs;
  const http = overrides.http ?? new FetchHttpClient();
  const sources: SourceAdapter[] =
    overrides.sources ??
    [
      ...(config.sources.hackerNews.enabled ? [new HackerNewsSource({ isRelevant: looksAiRelated })] : []),
      ...createRssSources(config.sources.rssFeeds.map(({ id, name, url }) => ({ id, name, url }))),
    ];
  const llm: LlmProvider =
    overrides.llm ??
    new CodexCliProvider({
      workDir: config.store.dir,
      binary: config.llm.codexBinary,
      timeoutMs: config.llm.timeoutMs,
      logger: logger.child("codex"),
    });
  const vault = overrides.vault ?? new ObsidianVault({ root: config.obsidian.vaultRoot, logger: logger.child("obsidian") });

  return {
    async run(options: DailyRunOptions = {}): Promise<RunDailyPipelineResult> {
      const dryRun = options.dryRun ?? false;
      const date = options.date ?? calendarDateIn(config.timezone, clock.nowMs());
      const window: TimeWindow = trailingWindow(clock.nowMs(), config.sources.windowHours);
      const reportChannels = resolveReportChannels(config, options, overrides, logger);
      if (reportChannels === null && !options.skipNotion) {
        logger.warn("NOTION_REPORTS_DATABASE_ID is not set; the reports stage is skipped and the daily brief gets no report links");
      }
      const intelligence = buildIntelligenceWiring({
        config,
        stores,
        sources,
        llm,
        http,
        clock,
        logger,
        events,
        random,
        reportChannels,
      });
      const source = resolveBriefSource(options, overrides, intelligence.autoBrief);

      const channels: ChannelWiring[] = [];
      if (!options.skipNotion) {
        channels.push({
          channel: "notion",
          renderer: new NotionBlocksRenderer(),
          publisher:
            overrides.notionPublisher ??
            new NotionPublisher({
              token: config.notion.token,
              databaseId: config.notion.databaseId,
              dataSourceId: config.notion.dataSourceId,
              allowSchemaFallback: config.notion.allowSchemaFallback,
              ...(overrides.notionClient ? { client: overrides.notionClient } : {}),
              logger: logger.child("notion"),
            }),
        });
      }
      if (!options.skipObsidian) {
        channels.push({
          channel: "obsidian",
          renderer: new MarkdownDailyRenderer(),
          publisher:
            overrides.obsidianPublisher ??
            new ObsidianDailyPublisher({
              vault,
              dailyFolder: config.obsidian.dailyFolder,
              logger: logger.child("obsidian"),
            }),
        });
      }

      const autoStages = source.kind === "auto" && !overrides.stagesBefore ? ["collect", "normalize", "analyze", "reports"] : [];
      const stageNames = [...autoStages, "input", ...channels.map((wiring) => `publish:${wiring.channel}`), "librarian"];
      const recorder = await JsonRunRecorder.start({
        store: runStore,
        clock,
        random,
        kind: "DAILY",
        window,
        timezone: config.timezone,
        stages: stageNames,
      });

      const deps: DailyPipelineDeps = {
        clock,
        logger,
        events,
        artifactStore,
        recorder,
        readJson,
        source,
        channels,
        librarian:
          options.skipLibrarian || options.skipObsidian
            ? null
            : { vault, maxNotesPerRun: config.obsidian.maxNotesPerRun },
      };

      const extra = overrides.stagesBefore?.(deps) ?? (source.kind === "auto" ? intelligence.stagesBefore(deps) : []);
      const result = await runDailyPipeline(deps, {
        date,
        window,
        timezone: config.timezone,
        dryRun,
        ...(extra.length > 0 ? { stages: [...extra, ...buildDailyStages(deps)] } : {}),
      });
      await recorder.finish(result.status);
      return result;
    },
  };
}

function resolveBriefSource(
  options: DailyRunOptions,
  overrides: DailyPipelineOverrides,
  autoBrief: Extract<BriefSource, { kind: "auto" }>["build"],
): BriefSource {
  if (options.input) return { kind: "manual", filePath: options.input };
  return { kind: "auto", build: overrides.autoBrief ?? autoBrief };
}

/**
 * 리포트 발행 채널 (INTEGRATIONS_AND_SAFETY.md §1.6).
 * `NOTION_REPORTS_DATABASE_ID` 가 없거나 `--skip-notion` 이면 null 이고, reports 단계는 SKIPPED 된다.
 */
function resolveReportChannels(
  config: AppConfig,
  options: DailyRunOptions,
  overrides: DailyPipelineOverrides,
  logger: Logger,
): ReportChannels | null {
  if (overrides.reportChannels !== undefined) return overrides.reportChannels;
  if (options.skipNotion) return null;
  const reports = config.notion.reports;
  if (!reports) return null;
  const publisher = new NotionReportsPublisher({
    token: config.notion.token,
    databaseId: reports.databaseId,
    dataSourceId: reports.dataSourceId,
    allowSchemaFallback: config.notion.allowSchemaFallback,
    logger: logger.child("notion-reports"),
  });
  return {
    sectionReport: { renderer: new NotionSectionReportRenderer(), publisher },
    digest: { renderer: new NotionDigestRenderer(), publisher },
  };
}
