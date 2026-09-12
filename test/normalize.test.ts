import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { CollectSources } from "../src/application/collect/collect-sources.js";
import { LinkAndDedupe } from "../src/application/normalize/link-and-dedupe.js";
import { NormalizeObservations } from "../src/application/normalize/normalize-observations.js";
import { RecordMetrics, coverageFromSummary } from "../src/application/normalize/record-metrics.js";
import { HackerNewsSource } from "../src/adapters/sources/hackernews/hackernews-source.js";
import { RssSource } from "../src/adapters/sources/rss/rss-source.js";
import type { NormalizedDocument } from "../src/domain/documents/normalized-document.js";
import type { RawObservation } from "../src/domain/documents/raw-observation.js";
import type { SourceAdapter } from "../src/ports/sources/source-adapter.js";
import type { TimeWindow } from "../src/domain/shared/time.js";
import { observationId, payloadHashOf } from "../src/domain/shared/ids.js";
import { FakeClock, FakeEvents, FakeHttp, FakeLogger, textResponse } from "./helpers/fake-system.js";
import {
  InMemoryCheckpointStore,
  InMemoryDocumentStore,
  InMemoryMetricStore,
  InMemoryRawStore,
} from "./helpers/fake-stores.js";
import { HN_MCP_STORY_ID, HN_STORY_ID, HN_TEXT_STORY_ID, HN_WINDOW, hackerNewsRoutes } from "./fixtures/hackernews.js";
import {
  ATOM_AGENTS_ID,
  ATOM_FEED_URL,
  ATOM_FEED_XML,
  ATOM_MCP_ID,
  RSS_2_FEED_XML,
  RSS_FEED_URL,
  RSS_ITEM_GUID,
} from "./fixtures/feeds.js";

const NOW = "2026-09-12T12:00:00.000Z";
const RUN_ID = "run_normalize_test";
const WINDOW: TimeWindow = HN_WINDOW;

const RSS_FEED = { id: "example-weekly", name: "Example AI Weekly", url: RSS_FEED_URL };
const ATOM_FEED = { id: "example-blog", name: "Example Engineering Blog", url: ATOM_FEED_URL };

interface Pipeline {
  sources: SourceAdapter[];
  collector: CollectSources;
  normalizer: NormalizeObservations;
  linker: LinkAndDedupe;
  recorder: RecordMetrics;
  raw: InMemoryRawStore;
  documents: InMemoryDocumentStore;
  metrics: InMemoryMetricStore;
  events: FakeEvents;
  logger: FakeLogger;
  clock: FakeClock;
}

function pipeline(): Pipeline {
  const raw = new InMemoryRawStore();
  const documents = new InMemoryDocumentStore();
  const metrics = new InMemoryMetricStore();
  const checkpoints = new InMemoryCheckpointStore();
  const events = new FakeEvents();
  const logger = new FakeLogger();
  const clock = new FakeClock(NOW);
  const http = new FakeHttp({
    ...hackerNewsRoutes(),
    [RSS_FEED_URL]: textResponse(RSS_2_FEED_XML),
    [ATOM_FEED_URL]: textResponse(ATOM_FEED_XML),
  });
  const sources: SourceAdapter[] = [new HackerNewsSource(), new RssSource(RSS_FEED), new RssSource(ATOM_FEED)];
  return {
    sources,
    collector: new CollectSources({
      sources,
      raw,
      checkpoints,
      http,
      clock,
      logger,
      events,
      defaults: { maxItemsPerSource: 50, perSourceTimeoutMs: 5_000, overallDeadlineMs: 30_000 },
    }),
    normalizer: new NormalizeObservations({ adapters: sources, raw, documents, clock, logger, events }),
    linker: new LinkAndDedupe({ documents, clock, logger }),
    recorder: new RecordMetrics({ metrics, logger, events }),
    raw,
    documents,
    metrics,
    events,
    logger,
    clock,
  };
}

function documentOf(documents: InMemoryDocumentStore, sourceId: string, externalId: string): NormalizedDocument {
  const found = [...documents.documents.values()].find(
    (document) => document.sourceId === sourceId && document.externalId === externalId,
  );
  assert.ok(found, `expected a document for ${sourceId}/${externalId}`);
  return found;
}

describe("NormalizeObservations", () => {
  test("normalizes every collected observation and emits ITEM_NORMALIZED", async () => {
    const p = pipeline();
    const summary = await p.collector.collect({ window: WINDOW, runId: RUN_ID });
    assert.equal(summary.overall, "ALL_OK");

    const result = await p.normalizer.normalize({
      observations: [...p.raw.observations.values()],
      runId: RUN_ID,
    });

    assert.equal(result.errors.length, 0);
    assert.equal(result.skipped, 0);
    assert.equal(result.documentsUpserted, p.raw.observations.size);
    assert.equal(p.events.ofType("ITEM_NORMALIZED").length, result.documentsUpserted);

    const hn = documentOf(p.documents, "hackernews", String(HN_STORY_ID));
    assert.equal(hn.provenance.runId, RUN_ID);
    assert.equal(hn.status, "ACTIVE");
    assert.equal(hn.canonicalUrl, "https://example.com/claude-opus-5");

    const rss = documentOf(p.documents, "rss:example-weekly", RSS_ITEM_GUID);
    assert.equal(rss.contentCompleteness, "FULL");
  });

  test("accepts observation ids as well as objects", async () => {
    const p = pipeline();
    await p.collector.collect({ window: WINDOW, runId: RUN_ID });
    const ids = [...p.raw.observations.keys()];

    const result = await p.normalizer.normalize({ observations: ids, runId: RUN_ID });
    assert.equal(result.documentsUpserted, ids.length);
  });

  test("keeps firstObservationId and marks the document CORRECTED when the content changed", async () => {
    const p = pipeline();
    await p.collector.collect({ window: WINDOW, runId: RUN_ID });
    const first = await p.normalizer.normalize({ observations: [...p.raw.observations.values()], runId: RUN_ID });
    assert.equal(first.errors.length, 0);

    const original = [...p.raw.observations.values()].find(
      (observation) => observation.externalId === String(HN_TEXT_STORY_ID),
    );
    assert.ok(original);
    assert.ok(original.payloadRef.kind === "inline");
    const payload = structuredClone(original.payloadRef.json) as { item: Record<string, unknown>; comments: unknown[] };
    payload.item.text = "<p>Correction: 4.1 tok/s after a kernel update.</p>";
    payload.item.score = 190;
    const payloadHash = payloadHashOf(payload);
    const corrected: RawObservation = {
      ...original,
      id: observationId(original.sourceId, original.externalId, payloadHash),
      payloadHash,
      payloadRef: { kind: "inline", json: payload },
      fetchedAt: "2026-09-12T11:00:00.000Z",
      observedAt: "2026-09-12T11:00:00.000Z",
    };
    await p.raw.putIfAbsent(corrected);

    const second = await p.normalizer.normalize({ observations: [corrected], runId: "run_second" });
    assert.equal(second.documentsUpserted, 1);

    const document = documentOf(p.documents, "hackernews", String(HN_TEXT_STORY_ID));
    assert.equal(document.status, "CORRECTED");
    assert.equal(document.latestObservationId, corrected.id);
    assert.equal(document.firstObservationId, original.id);
    assert.equal(document.content, "Correction: 4.1 tok/s after a kernel update.");
    assert.equal(document.metrics[0]?.value, 190);
  });

  test("skips observations with no registered adapter and logs the reason", async () => {
    const p = pipeline();
    await p.collector.collect({ window: WINDOW, runId: RUN_ID });
    const sample = [...p.raw.observations.values()][0];
    assert.ok(sample);
    const orphan: RawObservation = { ...sample, id: "obs_orphan", sourceId: "not-registered" };

    const result = await p.normalizer.normalize({ observations: [orphan], runId: RUN_ID });

    assert.equal(result.documentsUpserted, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.errors[0]?.observationId, "obs_orphan");
    assert.match(result.errors[0]?.message ?? "", /no adapter registered/);
  });
});

describe("LinkAndDedupe", () => {
  async function linked(): Promise<{ p: Pipeline; result: Awaited<ReturnType<LinkAndDedupe["run"]>> }> {
    const p = pipeline();
    await p.collector.collect({ window: WINDOW, runId: RUN_ID });
    await p.normalizer.normalize({ observations: [...p.raw.observations.values()], runId: RUN_ID });
    const result = await p.linker.run({ window: WINDOW, runId: RUN_ID });
    return { p, result };
  }

  test("links two sources that point at the same canonical url", async () => {
    const { p, result } = await linked();
    const hn = documentOf(p.documents, "hackernews", String(HN_STORY_ID));
    const rss = documentOf(p.documents, "rss:example-weekly", RSS_ITEM_GUID);
    assert.equal(hn.canonicalUrl, rss.canonicalUrl);

    const link = result.links.find(
      (candidate) =>
        candidate.type === "SAME_URL" &&
        [candidate.fromDocumentId, candidate.toDocumentId].sort().join("|") === [hn.id, rss.id].sort().join("|"),
    );
    assert.ok(link, "expected a SAME_URL link between the HN post and the feed item");
    assert.equal(link.confidence, 1);
    assert.equal(link.provenance.method, "RULE");
    assert.equal(link.provenance.runId, RUN_ID);

    // link 는 저장소에도 남는다.
    const stored = await p.documents.linksOf(hn.id);
    assert.ok(stored.some((candidate) => candidate.type === "SAME_URL"));

    // 같은 이야기이므로 한 cluster 로 묶인다.
    const cluster = [...result.clusters.values()].find((members) => members.includes(hn.id));
    assert.ok(cluster);
    assert.ok(cluster.includes(rss.id));
  });

  test("links near-identical titles as SAME_STORY inside 48 hours", async () => {
    const { p, result } = await linked();
    const hn = documentOf(p.documents, "hackernews", String(HN_MCP_STORY_ID));
    const atom = documentOf(p.documents, "rss:example-blog", ATOM_MCP_ID);
    assert.notEqual(hn.canonicalUrl, atom.canonicalUrl);

    const link = result.links.find(
      (candidate) =>
        candidate.type === "SAME_STORY" &&
        [candidate.fromDocumentId, candidate.toDocumentId].sort().join("|") === [hn.id, atom.id].sort().join("|"),
    );
    assert.ok(link, "expected a SAME_STORY link for the identical titles");
    assert.ok(link.confidence >= 0.8);
  });

  test("links a body url to the document it points at", async () => {
    const { p, result } = await linked();
    const agents = documentOf(p.documents, "rss:example-blog", ATOM_AGENTS_ID);

    const mentions = result.links.filter(
      (candidate) => candidate.type === "MENTIONS_URL" && candidate.fromDocumentId === agents.id,
    );
    assert.equal(mentions.length, 1);
    const target = await p.documents.get(mentions[0]?.toDocumentId ?? "");
    assert.equal(target?.canonicalUrl, "https://example.com/claude-opus-5");
  });

  test("picks the most complete document as the cluster representative", async () => {
    const { p, result } = await linked();
    const hn = documentOf(p.documents, "hackernews", String(HN_STORY_ID));
    const rss = documentOf(p.documents, "rss:example-weekly", RSS_ITEM_GUID);

    const representative = [...result.clusters.entries()].find(([, members]) => members.includes(hn.id))?.[0];
    // FULL 본문을 가진 피드 문서가 TITLE_ONLY 인 HN 문서를 이긴다.
    assert.equal(representative, rss.id);
  });

  test("every document ends up in exactly one cluster", async () => {
    const { p, result } = await linked();
    const members = [...result.clusters.values()].flat();
    assert.equal(members.length, p.documents.documents.size);
    assert.equal(new Set(members).size, members.length);
  });
});

describe("RecordMetrics", () => {
  test("records document metrics with scope ITEM and coverage from the collect summary", async () => {
    const p = pipeline();
    const summary = await p.collector.collect({ window: WINDOW, runId: RUN_ID });
    const normalized = await p.normalizer.normalize({
      observations: [...p.raw.observations.values()],
      runId: RUN_ID,
    });

    const result = await p.recorder.record({ documents: normalized.documents, runId: RUN_ID, summary });

    // HN 문서 3개 × (hn.points, hn.comments). RSS 문서는 metric 을 주지 않는다.
    assert.equal(result.recorded, 6);
    assert.equal(result.skipped, 0);
    assert.equal(p.metrics.observations.size, 6);

    const hn = documentOf(p.documents, "hackernews", String(HN_STORY_ID));
    const points = result.observations.find(
      (observation) => observation.subjectId === hn.id && observation.key === "hn.points",
    );
    assert.ok(points);
    assert.equal(points.subjectType, "DOCUMENT");
    assert.equal(points.scope, "ITEM");
    assert.equal(points.unit, "score");
    assert.equal(points.value, 412);
    assert.equal(points.window, null);
    assert.equal(points.sourceId, "hackernews");
    assert.equal(points.observationId, hn.latestObservationId);
    assert.deepEqual(points.coverage, {
      sourcesAttempted: 3,
      sourcesSucceeded: 3,
      truncated: false,
      note: null,
    });

    const comments = result.observations.find(
      (observation) => observation.subjectId === hn.id && observation.key === "hn.comments",
    );
    assert.equal(comments?.unit, "count");

    assert.equal(p.events.ofType("METRIC_RECORDED").length, 6);
  });

  test("rejects metrics that break the scope rules and keeps the valid ones", async () => {
    const p = pipeline();
    const summary = await p.collector.collect({ window: WINDOW, runId: RUN_ID });
    await p.normalizer.normalize({ observations: [...p.raw.observations.values()], runId: RUN_ID });
    const hn = documentOf(p.documents, "hackernews", String(HN_STORY_ID));
    const tampered: NormalizedDocument = {
      ...hn,
      metrics: [
        { key: "github.stars", value: 9000, observedAt: hn.fetchedAt },
        { key: "hn.points", value: 412, observedAt: hn.fetchedAt },
      ],
    };

    const result = await p.recorder.record({ documents: [tampered], runId: RUN_ID, summary });

    assert.equal(result.skipped, 1);
    assert.equal(result.recorded, 1);
    assert.equal(result.observations[0]?.key, "hn.points");
    assert.ok(
      p.logger.errors().some((line) => line.message === "metric rejected by scope validator"),
      "expected the scope violation to be logged",
    );
  });

  test("coverageFromSummary reports failed sources", () => {
    const coverage = coverageFromSummary({
      overall: "PARTIAL",
      perSource: [
        { sourceId: "hackernews", status: "COMPLETE", newObservations: 2, observationsSeen: 2, coverage: null, errors: [] },
        { sourceId: "rss:example-weekly", status: "FAILED", newObservations: 0, observationsSeen: 0, coverage: null, errors: [] },
      ],
    });
    assert.deepEqual(coverage, {
      sourcesAttempted: 2,
      sourcesSucceeded: 1,
      truncated: false,
      note: "failed sources: rss:example-weekly",
    });
  });
});
