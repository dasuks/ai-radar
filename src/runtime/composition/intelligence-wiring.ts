/**
 * 자동 Daily Brief 경로 조립 (Composition Root, ARCHITECTURE.md §3.2).
 * collect → normalize/link/metrics → analyze 단계를 파이프라인 앞에 붙이고,
 * `autoBrief` 훅에서 BuildDailyBrief 를 호출한다. 비즈니스 규칙은 두지 않는다
 * (우선순위·claim 매핑·fallback 본문·visibility·coverage·Artifact 봉투는 policies/application 에 있다).
 */
import type { Artifact } from "../../domain/artifacts/artifact.js";
import { DAILY_BRIEF_TITLE, type DailyBriefBody } from "../../domain/artifacts/daily-brief.js";
import type { NormalizedDocument } from "../../domain/documents/normalized-document.js";
import type { Entity } from "../../domain/entities/entity.js";
import type { Claim } from "../../domain/evidence/claim.js";
import type { Classification } from "../../domain/evidence/analysis.js";
import type { LlmProvider } from "../../ports/llm/llm-provider.js";
import type { SourceAdapter } from "../../ports/sources/source-adapter.js";
import type { Stores } from "../../ports/storage/index.js";
import type { Clock, EventSink, HttpClient, Logger, RandomSource } from "../../ports/system/index.js";
import { CollectSources, runCoverageSummary, type CollectSummary } from "../../application/collect/index.js";
import { LinkAndDedupe, NormalizeObservations, RecordMetrics } from "../../application/normalize/index.js";
import { ClassifyDocuments, ExtractClaims, claimsByDocument } from "../../application/analyze/index.js";
import {
  BuildDailyBrief,
  buildUnverifiedBrief,
  dailyBriefArtifact,
  type BriefCluster,
} from "../../application/briefing/index.js";
import type { AutoBriefContext, DailyPipelineDeps, PipelineStage } from "../../application/runs/run-daily-pipeline.js";
import { selectAnalysisCandidates } from "../../policies/classification/document-priority.js";
import { artifactVisibility } from "../../policies/classification/visibility.js";
import { cultureRankingPolicyV1 } from "../../policies/culture/v1.js";
import { practicalRankingPolicyV1 } from "../../policies/practical/v1.js";
import type { AppConfig } from "../config/app-config.js";

export interface IntelligenceWiringDeps {
  config: AppConfig;
  stores: Stores;
  sources: SourceAdapter[];
  llm: LlmProvider;
  http: HttpClient;
  clock: Clock;
  logger: Logger;
  events: EventSink;
  random: RandomSource;
}

interface IntelState {
  summary: CollectSummary | null;
  documents: NormalizedDocument[];
  clusters: Map<string, string[]>;
  representatives: NormalizedDocument[];
  classifications: Classification[];
  claimsByDocument: Record<string, Claim[]>;
  entities: Entity[];
  analysisNotes: string[];
  analysisFailed: boolean;
}

export interface IntelligenceWiring {
  stagesBefore: (deps: DailyPipelineDeps) => PipelineStage[];
  autoBrief: (ctx: AutoBriefContext) => Promise<Artifact<DailyBriefBody>>;
}

export function buildIntelligenceWiring(deps: IntelligenceWiringDeps): IntelligenceWiring {
  const { config, stores, sources, llm, http, clock, logger, events, random } = deps;
  const model = config.llm.model ?? "default";
  const state: IntelState = {
    summary: null,
    documents: [],
    clusters: new Map(),
    representatives: [],
    classifications: [],
    claimsByDocument: {},
    entities: [],
    analysisNotes: [],
    analysisFailed: false,
  };
  const sourceIds = sources.map((s) => s.descriptor.id);

  const stagesBefore = (pipeline: DailyPipelineDeps): PipelineStage[] => [
    {
      name: "collect",
      enabled: () => true,
      async run(ctx) {
        if (sources.length === 0) {
          ctx.collect = "ALL_FAILED";
          throw new Error("no sources configured (config/sources.json and AI_RADAR hackerNews)");
        }
        const collector = new CollectSources({
          sources,
          raw: stores.raw,
          checkpoints: stores.checkpoints,
          http,
          clock,
          logger: logger.child("collect"),
          events,
          defaults: { maxItemsPerSource: config.sources.hackerNews.maxItems, perSourceTimeoutMs: 60_000, overallDeadlineMs: 180_000 },
        });
        state.summary = await collector.collect({ window: ctx.window, runId: ctx.runId });
        ctx.collect = state.summary.overall;
        const summary = state.summary;
        await pipeline.recorder.updateCounters((counters) => {
          counters.sourcesAttempted = summary.perSource.map((s) => s.sourceId);
          counters.sourcesSucceeded = summary.perSource.filter((s) => s.status !== "FAILED").map((s) => s.sourceId);
          counters.sourcesFailed = summary.perSource.filter((s) => s.status === "FAILED").map((s) => s.sourceId);
          counters.observationsCollected = summary.perSource.reduce((n, s) => n + s.observationsSeen, 0);
          counters.observationsNew = summary.perSource.reduce((n, s) => n + s.newObservations, 0);
        });
        for (const s of summary.perSource) {
          for (const error of s.errors) {
            await pipeline.recorder.addError({ stage: "collect", sourceId: s.sourceId, message: error.message, retryable: error.retryable });
          }
        }
        logger.info(`collect ${summary.overall}`, Object.fromEntries(summary.perSource.map((s) => [s.sourceId, `${s.status}:${s.newObservations}new`])));
      },
    },
    {
      name: "normalize",
      enabled: () => true,
      async run(ctx) {
        // 수집은 window 계산 이후에 일어나므로 observedAt(=fetchedAt) 이 window.end 를 넘는다. end 를 지금으로 늘린다.
        const effectiveWindow = { start: ctx.window.start, end: clock.nowIso() };
        const observations = (await Promise.all(sources.map((s) => stores.raw.listBySource(s.descriptor.id, effectiveWindow)))).flat();
        const normalizer = new NormalizeObservations({ adapters: sources, raw: stores.raw, documents: stores.documents, clock, logger: logger.child("normalize"), events });
        const normalized = await normalizer.normalize({ observations, runId: ctx.runId });
        const linker = new LinkAndDedupe({ documents: stores.documents, clock, logger: logger.child("link") });
        const linked = await linker.run({ window: effectiveWindow, runId: ctx.runId });
        state.documents = await stores.documents.listInWindow(effectiveWindow);
        state.clusters = linked.clusters;
        const byId = new Map(state.documents.map((d) => [d.id, d]));
        state.representatives = [...linked.clusters.keys()].map((id) => byId.get(id)).filter((d): d is NormalizedDocument => d !== undefined);
        if (state.summary) {
          const recorder = new RecordMetrics({ metrics: stores.metrics, logger: logger.child("metrics"), events });
          const recorded = await recorder.record({ documents: state.documents, runId: ctx.runId, summary: state.summary });
          await pipeline.recorder.updateCounters((counters) => {
            counters.metricsRecorded = recorded.recorded;
          });
        }
        await pipeline.recorder.updateCounters((counters) => {
          counters.documentsUpserted = normalized.documentsUpserted;
          counters.linksCreated = linked.links.length;
        });
        logger.info(`normalize: ${normalized.documentsUpserted} upserted, ${state.documents.length} in window, ${linked.clusters.size} clusters`);
      },
    },
    {
      name: "analyze",
      enabled: () => state.representatives.length > 0,
      async run(ctx) {
        const candidates = selectAnalysisCandidates(state.representatives, config.llm.maxDocumentsPerRun);
        const classify = new ClassifyDocuments({ claims: stores.claims, llm, model, clock, logger: logger.child("classify"), random });
        const classified = await classify.execute({ runId: ctx.runId, documents: candidates, maxCallsPerRun: config.llm.maxCallsPerRun });
        state.classifications = classified.classifications;
        const extractor = new ExtractClaims({ claims: stores.claims, entities: stores.entities, llm, model, clock, logger: logger.child("claims"), random });
        const remainingCalls = Math.max(1, config.llm.maxCallsPerRun - classified.llmCalls);
        const extracted = await extractor.execute({ runId: ctx.runId, documents: candidates, maxCallsPerRun: remainingCalls });
        state.claimsByDocument = claimsByDocument(extracted);
        const entityIds = new Set(Object.values(extracted.entityIdsByDocument).flat());
        state.entities = (await Promise.all([...entityIds].map((id) => stores.entities.get(id)))).filter((e): e is Entity => e !== null);
        state.analysisNotes = [...classified.notes, ...extracted.notes];
        await pipeline.recorder.addLlmUsage([...classified.usage, ...extracted.usage]);
        await pipeline.recorder.updateCounters((counters) => {
          counters.claimsCreated = extracted.claims.length;
          counters.claimsRejected = extracted.rejectedItems;
          counters.entitiesResolved = entityIds.size;
        });
        // ANALYSIS_FAILURE 는 LLM 단계 자체가 실패했을 때만이다. 정상 실행에서 claim 이 0건인 것은 실패가 아니다 (PIPELINES §4).
        if (extracted.status === "FAILED") {
          ctx.analysisFailed = true;
          state.analysisFailed = true;
          await pipeline.recorder.addError({ stage: "analyze", message: `claim extraction failed (classify=${classified.status}, claims=${extracted.status})`, retryable: true });
        } else if (classified.status !== "SUCCEEDED" || extracted.status !== "SUCCEEDED") {
          ctx.analysisPartial = true;
          await pipeline.recorder.addError({ stage: "analyze", message: `analysis partial (classify=${classified.status}, claims=${extracted.status}); LLM call budget or a failed batch`, retryable: true });
        }
        logger.info(`analyze: ${extracted.claims.length} claims, ${extracted.rejectedItems} rejected, calls=${classified.llmCalls + extracted.llmCalls}`);
      },
    },
  ];

  const autoBrief = async (ctx: AutoBriefContext): Promise<Artifact<DailyBriefBody>> => {
    const coverage = runCoverageSummary(state.summary, sourceIds);
    let body: DailyBriefBody;
    let inputs: Artifact<DailyBriefBody>["inputs"] = { claimIds: [], documentIds: state.documents.map((d) => d.id), signalRefs: [], rankingPolicies: [], runId: ctx.runId };
    const hasClaims = Object.keys(state.claimsByDocument).length > 0;
    if (hasClaims) {
      const byId = new Map(state.documents.map((d) => [d.id, d]));
      const clusters: BriefCluster[] = state.representatives
        .filter((rep) => state.claimsByDocument[rep.id]?.length)
        .map((rep) => ({
          representative: rep,
          members: (state.clusters.get(rep.id) ?? []).map((m) => byId.get(m)).filter((d): d is NormalizedDocument => d !== undefined && d.id !== rep.id),
        }));
      const builder = new BuildDailyBrief({ llm, model, policies: [cultureRankingPolicyV1, practicalRankingPolicyV1], clock, logger: ctx.logger.child("brief") });
      const evidence = (await Promise.all(clusters.map((c) => stores.claims.evidenceOfDocument(c.representative.id)))).flat();
      const result = await builder.execute({
        date: ctx.date,
        window: ctx.window,
        timezone: ctx.timezone,
        runId: ctx.runId,
        clusters,
        classifications: state.classifications,
        claimsByDocument: state.claimsByDocument,
        entities: state.entities,
        evidence,
        coverage,
      });
      body = { ...result.body, title: DAILY_BRIEF_TITLE };
      inputs = { ...result.inputs, signalRefs: [] };
      if (result.usage.length > 0) ctx.logger.info(`brief: ${result.usage.length} LLM call(s)`, { rejected: result.rejectedItems });
    } else {
      body = buildUnverifiedBrief({
        date: ctx.date,
        title: DAILY_BRIEF_TITLE,
        observed: state.summary?.perSource.reduce((n, s) => n + s.observationsSeen, 0) ?? 0,
        documentsInWindow: state.documents.length,
        reason: state.analysisFailed
          ? `분석 실패: ${state.analysisNotes.slice(0, 2).join(" / ") || "LLM 호출 실패"}`
          : coverage.sourcesFailed.length > 0 && coverage.sourcesFailed.length === coverage.sourcesAttempted.length
            ? "모든 소스 수집 실패"
            : "수집은 정상이며 검증을 통과한 항목이 없습니다",
        coverage,
      });
    }
    return dailyBriefArtifact({
      date: ctx.date,
      body,
      inputs,
      visibility: artifactVisibility(Object.values(state.claimsByDocument).flat()),
      timezone: ctx.timezone,
      window: ctx.window,
      createdAt: ctx.clock.nowIso(),
    });
  };

  return { stagesBefore, autoBrief };
}
