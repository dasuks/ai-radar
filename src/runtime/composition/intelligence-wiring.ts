/**
 * 자동 Daily Brief 경로 조립 (Composition Root, ARCHITECTURE.md §3.2).
 * collect → normalize/link/metrics → analyze 단계를 파이프라인 앞에 붙이고,
 * `autoBrief` 훅에서 BuildDailyBrief 를 호출한다. 비즈니스 규칙은 두지 않는다
 * (우선순위·claim 매핑·fallback 본문·visibility·coverage·Artifact 봉투는 policies/application 에 있다).
 */
import type { Artifact } from "../../domain/artifacts/artifact.js";
import {
  DAILY_BRIEF_TITLE,
  type ArtifactLink,
  type BriefSectionKind,
  type DailyBriefBody,
} from "../../domain/artifacts/daily-brief.js";
import type { DailyDigestBody, SectionReportBody } from "../../domain/artifacts/section-report.js";
import type { NormalizedDocument } from "../../domain/documents/normalized-document.js";
import type { Entity } from "../../domain/entities/entity.js";
import type { Claim } from "../../domain/evidence/claim.js";
import type { Classification } from "../../domain/evidence/analysis.js";
import type { LlmProvider } from "../../ports/llm/llm-provider.js";
import type { Publisher, Renderer } from "../../ports/publishing/index.js";
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
import {
  BuildDailyDigest,
  BuildSectionReports,
  digestArtifact,
  sectionReportArtifact,
  type ReportEntryIndex,
} from "../../application/reporting/index.js";
import { publishArtifact } from "../../application/publish/index.js";
import { DIGEST_BATCH_SIZE } from "../../application/analyze/prompts/index.js";
import type { AutoBriefContext, DailyPipelineDeps, PipelineStage } from "../../application/runs/run-daily-pipeline.js";
import { selectAnalysisCandidates } from "../../policies/classification/document-priority.js";
import { artifactVisibility } from "../../policies/classification/visibility.js";
import { cultureRankingPolicyV1 } from "../../policies/culture/v1.js";
import { practicalRankingPolicyV1 } from "../../policies/practical/v1.js";
import type { AppConfig } from "../config/app-config.js";

/**
 * 리포트 Artifact 를 내보내는 채널 (INTEGRATIONS_AND_SAFETY.md §1.6).
 * null 이면 reports 단계는 SKIPPED 되고 Daily 는 링크 없이 발행된다.
 */
export interface ReportChannels {
  sectionReport: { renderer: Renderer<SectionReportBody>; publisher: Publisher };
  digest: { renderer: Renderer<DailyDigestBody>; publisher: Publisher };
}

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
  /** 리포트 발행 채널. 없으면 reports 단계를 건너뛴다 */
  reportChannels?: ReportChannels | null;
  /** 발행된 섹션 리포트 URL (entryId → url). 전체 목록 렌더러가 '상세 리포트 →' 링크에 쓴다 */
  reportEntryUrls?: Map<string, string>;
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
  llmCallsUsed: number;
  sectionReports: SectionReportBody[];
  entryIndex: ReportEntryIndex;
  reportLinks: Map<BriefSectionKind, ArtifactLink>;
  digestLink: ArtifactLink | null;
}

export interface IntelligenceWiring {
  stagesBefore: (deps: DailyPipelineDeps) => PipelineStage[];
  autoBrief: (ctx: AutoBriefContext) => Promise<Artifact<DailyBriefBody>>;
}

export function buildIntelligenceWiring(deps: IntelligenceWiringDeps): IntelligenceWiring {
  const { config, stores, sources, llm, http, clock, logger, events, random } = deps;
  const reportChannels = deps.reportChannels ?? null;
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
    llmCallsUsed: 0,
    sectionReports: [],
    entryIndex: new Map(),
    reportLinks: new Map(),
    digestLink: null,
  };
  const sourceIds = sources.map((s) => s.descriptor.id);

  /** window 안의 cluster 대표 + 그 cluster 의 나머지 문서. 리포트/목록/Daily 가 같은 입력을 쓴다. */
  const briefClusters = (): BriefCluster[] => {
    const byId = new Map(state.documents.map((d) => [d.id, d]));
    return state.representatives.map((rep) => ({
      representative: rep,
      members: (state.clusters.get(rep.id) ?? [])
        .map((m) => byId.get(m))
        .filter((d): d is NormalizedDocument => d !== undefined && d.id !== rep.id),
    }));
  };

  /** Artifact 저장 → 발행 → ArtifactLink. dryRun 이거나 실패하면 externalUrl 은 null 이다. */
  const storeAndPublish = async <TBody>(
    ctx: { runId: string; dryRun: boolean },
    args: {
      artifact: Artifact<TBody>;
      renderer: Renderer<TBody>;
      publisher: Publisher;
      recorder: DailyPipelineDeps["recorder"];
    },
  ): Promise<ArtifactLink> => {
    const head = await stores.artifacts.head(args.artifact.type, args.artifact.targetKey);
    const next: Artifact<TBody> = { ...args.artifact, revision: (head?.revision ?? 0) + 1 };
    const stored = await stores.artifacts.putRevision(next);
    const artifact = stored.revision === next.revision ? next : { ...next, revision: stored.revision };
    const record = await publishArtifact({
      artifact,
      channel: args.renderer.channel,
      renderer: args.renderer,
      publisher: args.publisher,
      artifactStore: stores.artifacts,
      runId: ctx.runId,
      dryRun: ctx.dryRun,
      clock,
      logger: logger.child("reports"),
    });
    await args.recorder.updateCounters((counters) => {
      if (!counters.artifactsCreated.includes(artifact.id)) counters.artifactsCreated.push(artifact.id);
      counters.publications.push(`${args.renderer.channel}:${record.status}`);
    });
    events.emit({ type: "ARTIFACT_CREATED", artifactId: artifact.id, revision: artifact.revision }, ctx.runId);
    return { artifactId: artifact.id, externalUrl: record.externalUrl };
  };

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
        state.llmCallsUsed = classified.llmCalls + extracted.llmCalls;
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
    {
      /**
       * 리포트 단계 (PIPELINES_AND_POLICIES.md §11, ADR-0009).
       * 섹션 상세 리포트 + 전체 목록을 만들고 발행해서 externalUrl 을 확보한 뒤 Daily 가 링크한다.
       */
      name: "reports",
      enabled: () => reportChannels !== null && state.representatives.length > 0,
      async run(ctx) {
        if (!reportChannels) return;
        const coverage = runCoverageSummary(state.summary, sourceIds);
        const clusters = briefClusters();
        const evidence = (
          await Promise.all(
            clusters.flatMap((cluster) =>
              [cluster.representative, ...cluster.members].map((document) => stores.claims.evidenceOfDocument(document.id)),
            ),
          )
        ).flat();

        // 목록(digest)과 Daily 작문 몫을 먼저 떼어 두고 남은 예산을 섹션 리포트에 준다.
        const remaining = Math.max(1, config.llm.maxCallsPerRun - state.llmCallsUsed);
        const digestBatches = Math.max(1, Math.ceil(clusters.length / DIGEST_BATCH_SIZE));
        const sectionBuilder = new BuildSectionReports({
          llm,
          model,
          policies: [cultureRankingPolicyV1, practicalRankingPolicyV1],
          clock,
          logger: logger.child("reports"),
        });
        const built = await sectionBuilder.execute({
          date: ctx.date,
          window: ctx.window,
          timezone: ctx.timezone,
          runId: ctx.runId,
          clusters,
          classifications: state.classifications,
          claimsByDocument: state.claimsByDocument,
          evidence,
          entities: state.entities,
          documents: state.documents,
          coverage,
          maxCallsPerRun: Math.max(1, remaining - digestBatches - 1),
        });
        state.sectionReports = built.reports;
        state.entryIndex = built.entryIndex;
        state.llmCallsUsed += built.usage.length;
        await pipeline.recorder.addLlmUsage(built.usage);

        const digestBuilder = new BuildDailyDigest({ llm, model, clock, logger: logger.child("digest") });
        const digest = await digestBuilder.execute({
          date: ctx.date,
          runId: ctx.runId,
          clusters,
          classifications: state.classifications,
          claimsByDocument: state.claimsByDocument,
          entryIndex: built.entryIndex,
          coverage,
          maxCallsPerRun: digestBatches,
        });
        state.llmCallsUsed += digest.usage.length;
        await pipeline.recorder.addLlmUsage(digest.usage);

        const visibility = artifactVisibility(Object.values(state.claimsByDocument).flat());
        const claims = Object.values(state.claimsByDocument).flat();
        const rankingPolicies = [cultureRankingPolicyV1, practicalRankingPolicyV1].map((policy) => ({
          id: policy.id,
          version: policy.version,
        }));

        for (const body of built.reports) {
          const link = await storeAndPublish(ctx, {
            artifact: sectionReportArtifact({
              body,
              inputs: {
                claimIds: [...new Set(body.entries.flatMap((entry) => entry.claims.map((claim) => claim.claimId)))].sort(),
                documentIds: [...new Set(body.sources.map((source) => source.documentId))].sort(),
                signalRefs: [],
                rankingPolicies,
                runId: ctx.runId,
              },
              visibility,
              timezone: ctx.timezone,
              window: ctx.window,
              createdAt: clock.nowIso(),
            }),
            renderer: reportChannels.sectionReport.renderer,
            publisher: reportChannels.sectionReport.publisher,
            recorder: pipeline.recorder,
          });
          state.reportLinks.set(body.section, link);
          if (link.externalUrl && deps.reportEntryUrls) {
            for (const entry of body.entries) deps.reportEntryUrls.set(entry.id, link.externalUrl);
          }
        }

        state.digestLink = await storeAndPublish(ctx, {
          artifact: digestArtifact({
            body: digest.body,
            inputs: {
              claimIds: [...new Set(claims.map((claim) => claim.id))].sort(),
              documentIds: [...new Set(digest.body.stories.map((story) => story.documentId))].sort(),
              signalRefs: [],
              rankingPolicies,
              runId: ctx.runId,
            },
            visibility,
            timezone: ctx.timezone,
            window: ctx.window,
            createdAt: clock.nowIso(),
          }),
          renderer: reportChannels.digest.renderer,
          publisher: reportChannels.digest.publisher,
          recorder: pipeline.recorder,
        });

        for (const note of [...built.notes, ...digest.notes].slice(0, 10)) ctx.warnings.push(`reports: ${note}`);
        logger.info(
          `reports: ${built.reports.length} section report(s), ${built.entryIndex.size} entries, ${digest.body.stories.length} digest stories`,
        );
      },
    },
  ];

  const autoBrief = async (ctx: AutoBriefContext): Promise<Artifact<DailyBriefBody>> => {
    const coverage = runCoverageSummary(state.summary, sourceIds);
    let body: DailyBriefBody;
    let inputs: Artifact<DailyBriefBody>["inputs"] = { claimIds: [], documentIds: state.documents.map((d) => d.id), signalRefs: [], rankingPolicies: [], runId: ctx.runId };
    const hasReports = state.sectionReports.length > 0 && state.entryIndex.size > 0;
    const hasClaims = Object.keys(state.claimsByDocument).length > 0;
    if (hasClaims || hasReports) {
      const byId = new Map(state.documents.map((d) => [d.id, d]));
      const clusters: BriefCluster[] = state.representatives
        .filter((rep) => hasReports || state.claimsByDocument[rep.id]?.length)
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
        sectionReports: state.sectionReports,
        entryIndex: state.entryIndex,
        reportLinks: state.reportLinks,
        digestLink: state.digestLink,
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
