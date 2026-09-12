/**
 * 리포트 단계가 파이프라인에 붙는 방식 (PIPELINES_AND_POLICIES.md §11):
 * analyze → reports → input(daily) 순서, 리포트/목록 링크가 Daily 본문으로 흐르는지, dry-run 이면 externalUrl 이 null 인지.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FakeLlmProvider } from "../src/adapters/llm/fake/index.js";
import { createMemoryStores } from "../src/adapters/storage/memory/index.js";
import { buildDailyPipeline, type DailyPipelineOverrides } from "../src/runtime/composition/build-daily-pipeline.js";
import type { ReportChannels } from "../src/runtime/composition/intelligence-wiring.js";
import type { AppConfig } from "../src/runtime/config/app-config.js";
import type { Artifact } from "../src/domain/artifacts/artifact.js";
import type { DailyDigestBody, SectionReportBody } from "../src/domain/artifacts/section-report.js";
import type { NormalizedDocument } from "../src/domain/documents/normalized-document.js";
import type { RawObservation } from "../src/domain/documents/raw-observation.js";
import { payloadHashOf, observationId, documentId } from "../src/domain/shared/ids.js";
import type { PublishOutcome, Publisher, Rendered, Renderer } from "../src/ports/publishing/index.js";
import type {
  CollectRequest,
  CollectResult,
  NormalizeInput,
  SourceAdapter,
} from "../src/ports/sources/source-adapter.js";
import type { Stores } from "../src/ports/storage/index.js";
import { FakeClock, FakeLogger } from "./helpers/fake-system.js";
import { MemoryVault } from "./helpers/memory-vault.js";

const NOW = "2026-09-12T12:00:00.000Z";
const DATE = "2026-09-12";
const SOURCE_ID = "stub";

interface StubStory {
  externalId: string;
  title: string;
  content: string;
  url: string;
  tags: string[];
}

const STORIES: StubStory[] = [
  {
    externalId: "s1",
    title: "코딩 에이전트 공개",
    content: "```bash\nnpm install -g tool\n```\n\n회사가 공식 발표했고 리뷰 시간이 줄었다는 후기가 이어졌다.",
    url: "https://github.com/anthropics/claude-code",
    tags: ["code"],
  },
  {
    externalId: "s2",
    title: "모델 컨텍스트 확장",
    content: "컨텍스트 길이가 늘었다는 설명과 실사용 후기가 있다. 문서 하나를 통째로 넣었다.",
    url: "https://example.com/llm",
    tags: [],
  },
];

function observationOf(story: StubStory): RawObservation {
  const payload = { ...story };
  const payloadHash = payloadHashOf(payload);
  return {
    schemaVersion: 1,
    id: observationId(SOURCE_ID, story.externalId, payloadHash),
    sourceId: SOURCE_ID,
    sourceKind: "API",
    externalId: story.externalId,
    originalUrl: story.url,
    observedAt: "2026-09-12T06:00:00.000Z",
    observedAtIsFetchedAt: false,
    fetchedAt: NOW,
    runId: "run_stub",
    payloadHash,
    payloadRef: { kind: "inline", json: payload },
    completeness: "FULL",
    rawMetadata: {},
  };
}

const stubSource: SourceAdapter = {
  descriptor: {
    id: SOURCE_ID,
    kind: "API",
    capabilities: {
      timeWindow: false,
      cursor: false,
      checkpoint: false,
      comments: false,
      metrics: [],
      expectedCompleteness: "FULL",
    },
    limits: { requestsPerMinute: null, maxItemsPerRun: 50, defaultTimeoutMs: 5_000 },
    license: { name: "stub", url: null, attributionRequired: false },
  },
  async collect(request: CollectRequest): Promise<CollectResult> {
    return {
      status: "COMPLETE",
      observations: STORIES.map(observationOf),
      nextCheckpoint: null,
      coverage: {
        windowRequested: request.window,
        windowCovered: request.window,
        truncated: false,
        truncationReason: null,
        itemsSeen: STORIES.length,
      },
      errors: [],
    };
  },
  normalize(input: NormalizeInput): NormalizedDocument {
    const story = input.observation.payloadRef.kind === "inline" ? (input.observation.payloadRef.json as StubStory) : STORIES[0]!;
    return {
      schemaVersion: 1,
      id: documentId(SOURCE_ID, input.observation.externalId),
      sourceId: SOURCE_ID,
      externalId: input.observation.externalId,
      latestObservationId: input.observation.id,
      firstObservationId: input.existing?.firstObservationId ?? input.observation.id,
      title: story.title,
      content: story.content,
      contentCompleteness: "FULL",
      author: { name: null, externalId: null, url: null },
      language: "ko",
      publishedAt: "2026-09-12T06:00:00.000Z",
      updatedAt: null,
      fetchedAt: input.observation.fetchedAt,
      canonicalUrl: story.url,
      urls: [story.url],
      comments: [],
      metrics: [{ key: "hn.points", value: 450, observedAt: "2026-09-12T06:00:00.000Z" }],
      tags: story.tags,
      status: "ACTIVE",
      provenance: { normalizerVersion: "1", runId: input.runId, normalizedAt: input.normalizedAt },
    };
  },
};

function llmProvider(): FakeLlmProvider {
  return new FakeLlmProvider({
    CLASSIFY: (req) => ({
      items: req.untrusted.map((item) => ({
        documentId: item.id,
        categories: [
          { category: "AI_CODING", confidence: 0.9 },
          { category: "CULTURE", confidence: 0.9 },
        ],
        audience: "PRACTITIONER",
      })),
    }),
    EXTRACT_CLAIMS: (req) =>
      ({
        claims: req.untrusted.flatMap((block) => {
          const evidenceIds = [...block.text.matchAll(/evidence id="(evd_[^"]+)"/g)].map((match) => match[1]!);
          if (evidenceIds.length === 0) return [];
          return [
            {
              documentId: block.id,
              type: "OFFICIAL_CLAIM",
              statement: "회사가 도구를 공개했다.",
              evidenceIds: [evidenceIds[0]!],
              subjectSurfaceForms: [],
              sentiment: "NEUTRAL",
              confidence: 0.8,
            },
            {
              documentId: block.id,
              type: "USER_EXPERIENCE",
              statement: "글쓴이는 리뷰 시간이 줄었다고 말한다.",
              evidenceIds: [evidenceIds[0]!],
              subjectSurfaceForms: [],
              sentiment: "POSITIVE",
              confidence: 0.8,
            },
            {
              documentId: block.id,
              type: "FACT",
              statement: "도구는 CLI 로 배포된다.",
              evidenceIds: [evidenceIds[0]!],
              subjectSurfaceForms: [],
              sentiment: "NEUTRAL",
              confidence: 0.8,
            },
          ];
        }),
      }),
    WRITE_SECTION_REPORT: (req) => ({
      overview: ["오늘 이 분야의 흐름이다.", "두 번째 문장.", "세 번째 문장."],
      entries: req.untrusted.map((block, index) => ({
        entryId: block.id,
        title: `리포트 항목 ${index + 1}`,
        narrative: ["첫 문단이다.", "둘째 문단이다."],
        evidenceIds: [...block.text.matchAll(/evidence id="(evd_[^"]+)"/g)].map((match) => match[1]!),
        communityReaction: null,
        whyItMatters: "중요한 이유다.",
        howToApply: "이번 주에 적용한다.",
        counterpoints: [],
        openQuestions: [],
        importance: 4,
      })),
    }),
    WRITE_DIGEST: (req) => ({
      stories: req.untrusted.map((block, index) => ({
        documentId: block.id,
        titleKo: `목록 제목 ${index + 1}`,
        summary: "한 줄 요약이다.",
        importance: 3,
      })),
    }),
    WRITE_BRIEF_KO: (req) => ({
      items: req.untrusted.map((block, index) => ({
        itemId: block.id,
        title: `짧은 제목 ${index + 1}`,
        whatChanged: "무엇이 바뀌었는지 적는다. 두 번째 문장이다.",
        whyItMatters: "왜 중요한지 적는다. 두 번째 문장이다.",
        howDevelopersUseIt: null,
        howToApply: null,
        importance: 4,
        claimIds: [...block.text.matchAll(/claim id="(clm_[^"]+)"/g)].map((match) => match[1]!),
      })),
      oneMinuteSummary: ["요약1", "요약2", "요약3"],
    }),
  });
}

class RecordingPublisher implements Publisher {
  readonly channel = "notion" as const;
  readonly published: { artifactId: string; dryRun: boolean }[] = [];
  constructor(private readonly url: string | null) {}
  async publish(input: { artifactId: string; dryRun: boolean }): Promise<PublishOutcome> {
    this.published.push({ artifactId: input.artifactId, dryRun: input.dryRun });
    return { externalId: `page-${this.published.length}`, externalUrl: this.url, action: "created" };
  }
}

function stubRenderer<TBody>(): Renderer<TBody> {
  return {
    channel: "notion",
    render(artifact: Artifact<TBody>): Rendered {
      return { channel: "notion", hash: `hash-${artifact.id}-${artifact.revision}`, payload: {}, preview: "" };
    },
  };
}

function reportChannelsWith(publisher: Publisher): ReportChannels {
  return {
    sectionReport: { renderer: stubRenderer<SectionReportBody>(), publisher },
    digest: { renderer: stubRenderer<DailyDigestBody>(), publisher },
  };
}

function config(): AppConfig {
  return {
    projectRoot: ".",
    notion: {
      token: "t",
      databaseId: "db",
      allowSchemaFallback: false,
      reports: { databaseId: "reports-db" },
    },
    obsidian: { vaultRoot: "/vault", dailyFolder: "99 Daily", maxNotesPerRun: 5 },
    store: { dir: "/tmp/ai-radar-test" },
    timezone: "Asia/Seoul",
    llm: {
      provider: "fake",
      model: "gpt-test",
      maxCallsPerRun: 24,
      codexBinary: "codex",
      maxDocumentsPerRun: 60,
      timeoutMs: 1000,
    },
    sources: { rssFeeds: [], hackerNews: { enabled: false, maxItems: 10 }, windowHours: 24 },
    redaction: [],
  };
}

interface Harness {
  overrides: DailyPipelineOverrides;
  logger: FakeLogger;
  reportsPublisher: RecordingPublisher;
  llm: FakeLlmProvider;
  stores: Stores;
}

function harness(options: { reportUrl: string | null; reportChannels?: ReportChannels | null } = { reportUrl: "https://notion.so/page" }): Harness {
  const logger = new FakeLogger();
  const reportsPublisher = new RecordingPublisher(options.reportUrl);
  const llm = llmProvider();
  const stores = createMemoryStores();
  const overrides: DailyPipelineOverrides = {
    clock: new FakeClock(NOW),
    logger,
    stores,
    sources: [stubSource],
    llm,
    vault: new MemoryVault(),
    notionPublisher: new RecordingPublisher(null),
    obsidianPublisher: new RecordingPublisher(null) as unknown as Publisher,
    reportChannels: options.reportChannels === undefined ? reportChannelsWith(reportsPublisher) : options.reportChannels,
  };
  return { overrides, logger, reportsPublisher, llm, stores };
}

function stageOrder(logger: FakeLogger): string[] {
  return logger.lines
    .map((line) => /^stage (\S+) (skipped)$/.exec(line.message)?.[1] ?? null)
    .filter((name): name is string => name !== null);
}

describe("reports 단계", () => {
  test("analyze 다음, input(daily) 앞에서 실행되고 링크가 Daily 본문으로 흐른다", async () => {
    const { overrides, reportsPublisher, llm, stores } = harness();
    const result = await buildDailyPipeline(config(), overrides).run({ date: DATE, skipLibrarian: true });

    const run = await stores.runs.get(result.runId);
    const executed = (run?.stages ?? []).map((stage) => stage.name);
    assert.deepEqual(executed.slice(0, 5), ["collect", "normalize", "analyze", "reports", "input"]);
    assert.equal(run?.stages.find((stage) => stage.name === "reports")?.status, "DONE");

    const body = result.context.artifact!.body;
    assert.ok(body.sections.length > 0, "Daily 에 섹션이 있다");
    for (const section of body.sections) {
      assert.ok(section.report, `${section.kind} 섹션에 리포트 링크가 있다`);
      assert.equal(section.report!.externalUrl, "https://notion.so/page");
    }
    assert.ok(body.digest);
    assert.equal(body.digest!.externalUrl, "https://notion.so/page");

    // 리포트/목록이 Daily 보다 먼저 발행됐다.
    assert.ok(reportsPublisher.published.length >= 2);
    assert.ok(llm.callsFor("WRITE_SECTION_REPORT").length >= 1);
    assert.equal(llm.callsFor("WRITE_DIGEST").length, 1);
    assert.equal(llm.callsFor("WRITE_BRIEF_KO").length, 1);
    assert.equal(llm.callsFor("WRITE_BRIEF_KO")[0]!.req.promptVersion, "v3");

    // Daily 의 item id 는 리포트 항목 id 와 같다.
    const itemIds = body.sections.flatMap((section) => section.items.map((item) => item.id)).sort();
    assert.ok(itemIds.length > 0);
    assert.equal(new Set(itemIds).size, itemIds.length);
  });

  test("dry-run 이면 externalUrl 이 null 이고 발행 기록을 남기지 않는다", async () => {
    const { overrides, reportsPublisher } = harness({ reportUrl: null });
    const result = await buildDailyPipeline(config(), overrides).run({ date: DATE, dryRun: true, skipLibrarian: true });

    const body = result.context.artifact!.body;
    for (const section of body.sections) assert.equal(section.report?.externalUrl ?? null, null);
    assert.equal(body.digest?.externalUrl ?? null, null);
    assert.ok(reportsPublisher.published.every((entry) => entry.dryRun === true));
  });

  test("리포트 채널이 없으면 reports 단계를 건너뛰고 Daily 는 링크 없이 나간다", async () => {
    const { overrides, logger, llm } = harness({ reportUrl: null, reportChannels: null });
    const result = await buildDailyPipeline(config(), overrides).run({ date: DATE, skipLibrarian: true });

    assert.ok(stageOrder(logger).includes("reports"), "reports 단계가 SKIPPED 로 기록된다");
    assert.equal(llm.callsFor("WRITE_SECTION_REPORT").length, 0);
    assert.equal(llm.callsFor("WRITE_DIGEST").length, 0);
    const body = result.context.artifact!.body;
    assert.equal(body.digest, null);
    for (const section of body.sections) assert.equal(section.report, null);
  });
});
