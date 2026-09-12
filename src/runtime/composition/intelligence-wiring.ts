/**
 * 자동 Daily Brief 경로 조립 (Composition Root, ARCHITECTURE.md §3.2).
 * collect → normalize/link/metrics → analyze 단계를 파이프라인 앞에 붙이고,
 * `autoBrief` 훅에서 BuildDailyBrief 를 호출한다. 비즈니스 규칙은 두지 않는다.
 */
import type { Artifact } from "../../domain/artifacts/artifact.js";
import { contentHashOf } from "../../domain/artifacts/artifact.js";
import { DAILY_BRIEF_TITLE, type DailyBriefBody, type RunCoverageSummary } from "../../domain/artifacts/daily-brief.js";
import type { NormalizedDocument } from "../../domain/documents/normalized-document.js";
import type { Entity } from "../../domain/entities/entity.js";
import type { Claim } from "../../domain/evidence/claim.js";
import type { Classification } from "../../domain/evidence/analysis.js";
import { artifactId as makeArtifactId } from "../../domain/shared/ids.js";
import type { LlmProvider } from "../../ports/llm/llm-provider.js";
import type { SourceAdapter } from "../../ports/sources/source-adapter.js";
import type { Stores } from "../../ports/storage/index.js";
import type { Clock, EventSink, HttpClient, Logger, RandomSource } from "../../ports/system/index.js";
import { CollectSources, type CollectSummary } from "../../application/collect/index.js";
import { LinkAndDedupe, NormalizeObservations, RecordMetrics } from "../../application/normalize/index.js";
import { ClassifyDocuments, ExtractClaims } from "../../application/analyze/index.js";
import { BuildDailyBrief, type BriefCluster } from "../../application/briefing/index.js";
import type { AutoBriefContext, DailyPipelineDeps, PipelineStage } from "../../application/runs/run-daily-pipeline.js";
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
}

export interface IntelligenceWiring {
  stagesBefore: (deps: DailyPipelineDeps) => PipelineStage[];
  autoBrief: (ctx: AutoBriefContext) => Promise<Artifact<DailyBriefBody>>;
}

function coverageSummary(summary: CollectSummary | null, sourceIds: string[]): RunCoverageSummary {
  if (!summary) return { sourcesAttempted: sourceIds, sourcesFailed: [], partial: false, note: "collect stage did not run" };
  const failed = summary.perSource.filter((s) => s.status === "FAILED").map((s) => s.sourceId);
  const partial = summary.perSource.some((s) => s.status === "PARTIAL" || s.status === "FAILED");
  return {
    sourcesAttempted: summary.perSource.map((s) => s.sourceId),
    sourcesFailed: failed,
    partial,
    note: failed.length > 0 ? `수집 실패: ${failed.join(", ")}` : null,
  };
}

/** 문서 우선순위: 본문 완전성 + engagement 점수. 분석 대상 상한을 정할 때 쓴다. */
function documentPriority(document: NormalizedDocument): number {
  const completeness = { FULL: 3, EXCERPT: 2, TITLE_ONLY: 1, MISSING: 0 }[document.contentCompleteness];
  const points = document.metrics.find((m) => m.key === "hn.points")?.value ?? 0;
  const comments = document.metrics.find((m) => m.key === "hn.comments")?.value ?? 0;
  return completeness * 10 + Math.log10(1 + points) * 5 + Math.log10(1 + comments) * 3;
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
  };
  const sourceIds = sources.map((s) => s.descriptor.id);

  const stagesBefore = (pipeline: DailyPipelineDeps): PipelineStage[] => [
    {
      name: "collect",
      enabled: () => sources.length > 0,
      async run(ctx) {
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
        const candidates = [...state.representatives].sort((a, b) => documentPriority(b) - documentPriority(a)).slice(0, config.llm.maxDocumentsPerRun);
        const classify = new ClassifyDocuments({ claims: stores.claims, llm, model, clock, logger: logger.child("classify"), random });
        const classified = await classify.execute({ runId: ctx.runId, documents: candidates, maxCallsPerRun: config.llm.maxCallsPerRun });
        state.classifications = classified.classifications;
        const extractor = new ExtractClaims({ claims: stores.claims, entities: stores.entities, llm, model, clock, logger: logger.child("claims"), random });
        const remainingCalls = Math.max(1, config.llm.maxCallsPerRun - classified.llmCalls);
        const extracted = await extractor.execute({ runId: ctx.runId, documents: candidates, maxCallsPerRun: remainingCalls });
        state.claimsByDocument = {};
        for (const claim of extracted.claims) {
          const docIds = new Set<string>();
          for (const [docId, entityIds] of Object.entries(extracted.entityIdsByDocument)) if (entityIds.some((id) => claim.subjectEntityIds.includes(id))) docIds.add(docId);
          const evidenceDocs = extracted.evidence.filter((e) => claim.evidenceIds.includes(e.id)).map((e) => e.documentId);
          for (const docId of [...docIds, ...evidenceDocs]) (state.claimsByDocument[docId] ??= []).push(claim);
        }
        const entityIds = new Set(Object.values(extracted.entityIdsByDocument).flat());
        state.entities = (await Promise.all([...entityIds].map((id) => stores.entities.get(id)))).filter((e): e is Entity => e !== null);
        state.analysisNotes = [...classified.notes, ...extracted.notes];
        await pipeline.recorder.addLlmUsage([...classified.usage, ...extracted.usage]);
        await pipeline.recorder.updateCounters((counters) => {
          counters.claimsCreated = extracted.claims.length;
          counters.claimsRejected = extracted.rejectedItems;
          counters.entitiesResolved = entityIds.size;
        });
        const failed = classified.status === "FAILED" && extracted.status === "FAILED";
        if (failed || extracted.claims.length === 0) {
          ctx.analysisFailed = true;
          await pipeline.recorder.addError({ stage: "analyze", message: `analysis produced no claims (classify=${classified.status}, claims=${extracted.status})`, retryable: true });
        }
        logger.info(`analyze: ${extracted.claims.length} claims, ${extracted.rejectedItems} rejected, calls=${classified.llmCalls + extracted.llmCalls}`);
      },
    },
  ];

  const autoBrief = async (ctx: AutoBriefContext): Promise<Artifact<DailyBriefBody>> => {
    const id = makeArtifactId("DAILY_BRIEF", ctx.date);
    const coverage = coverageSummary(state.summary, sourceIds);
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
      const observed = state.summary?.perSource.reduce((n, s) => n + s.observationsSeen, 0) ?? 0;
      const reason = state.analysisNotes.length > 0 ? state.analysisNotes.slice(0, 3).join(" / ") : "분석 결과가 없습니다";
      body = {
        bodySchemaVersion: 2,
        date: ctx.date,
        title: DAILY_BRIEF_TITLE,
        oneMinuteSummary: [
          `오늘은 검증된 항목이 없습니다. 수집 ${observed}건, window 내 문서 ${state.documents.length}건.`,
          `분석 상태: ${reason}`,
        ],
        sections: [],
        learnOneThing: null,
        applyCandidates: [],
        sources: [],
        coverage,
      };
    }
    const claims = Object.values(state.claimsByDocument).flat();
    const visibility = claims.length > 0 && claims.every((c) => c.visibility === "PUBLIC_OK") ? "PUBLIC_OK" : "PRIVATE";
    return {
      schemaVersion: 1,
      id,
      type: "DAILY_BRIEF",
      targetKey: ctx.date,
      revision: 0,
      contentHash: contentHashOf(body),
      status: "FINAL",
      timezone: ctx.timezone,
      window: ctx.window,
      body,
      inputs,
      visibility,
      createdAt: ctx.clock.nowIso(),
    };
  };

  return { stagesBefore, autoBrief };
}
