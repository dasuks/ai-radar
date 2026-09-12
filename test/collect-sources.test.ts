import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { CollectSources } from "../src/application/collect/collect-sources.js";
import { HackerNewsSource } from "../src/adapters/sources/hackernews/hackernews-source.js";
import { RssSource } from "../src/adapters/sources/rss/rss-source.js";
import type {
  CollectRequest,
  CollectResult,
  NormalizeInput,
  SourceAdapter,
  SourceDescriptor,
} from "../src/ports/sources/source-adapter.js";
import type { NormalizedDocument } from "../src/domain/documents/normalized-document.js";
import type { TimeWindow } from "../src/domain/shared/time.js";
import { FakeClock, FakeEvents, FakeHttp, FakeLogger, textResponse } from "./helpers/fake-system.js";
import { InMemoryCheckpointStore, InMemoryRawStore } from "./helpers/fake-stores.js";
import { HN_TOP_STORIES_URL, HN_WINDOW, hackerNewsRoutes } from "./fixtures/hackernews.js";
import { RSS_2_FEED_XML, RSS_FEED_URL } from "./fixtures/feeds.js";

const NOW = "2026-09-12T12:00:00.000Z";
const RUN_ID = "run_collect_test";
const WINDOW: TimeWindow = HN_WINDOW;

const RSS_FEED = { id: "example-weekly", name: "Example AI Weekly", url: RSS_FEED_URL };

const DEFAULTS = { maxItemsPerSource: 50, perSourceTimeoutMs: 5_000, overallDeadlineMs: 30_000 };

interface Harness {
  collector: CollectSources;
  raw: InMemoryRawStore;
  checkpoints: InMemoryCheckpointStore;
  events: FakeEvents;
  logger: FakeLogger;
  http: FakeHttp;
}

function harness(sources: SourceAdapter[], routes: Record<string, ReturnType<typeof textResponse>> = {}): Harness {
  const raw = new InMemoryRawStore();
  const checkpoints = new InMemoryCheckpointStore();
  const events = new FakeEvents();
  const logger = new FakeLogger();
  const clock = new FakeClock(NOW);
  const http = new FakeHttp({ ...hackerNewsRoutes(), [RSS_FEED_URL]: textResponse(RSS_2_FEED_XML), ...routes });
  const collector = new CollectSources({
    sources,
    raw,
    checkpoints,
    http,
    clock,
    logger,
    events,
    defaults: DEFAULTS,
  });
  return { collector, raw, checkpoints, events, logger, http };
}

/** 테스트용 stub adapter. 결과를 그대로 돌려주거나 throw 한다. */
function stubSource(
  id: string,
  behaviour: (request: CollectRequest, attempt: number) => CollectResult | Promise<CollectResult>,
  limits: Partial<SourceDescriptor["limits"]> = {},
): SourceAdapter & { attempts: number; lastRequest: CollectRequest | null } {
  let attempts = 0;
  let lastRequest: CollectRequest | null = null;
  const adapter: SourceAdapter & { attempts: number; lastRequest: CollectRequest | null } = {
    descriptor: {
      id,
      kind: "API",
      capabilities: {
        timeWindow: false,
        cursor: false,
        checkpoint: true,
        comments: false,
        metrics: [],
        expectedCompleteness: "TITLE_ONLY",
      },
      limits: { requestsPerMinute: null, maxItemsPerRun: 50, defaultTimeoutMs: 5_000, ...limits },
      license: { name: "stub", url: null, attributionRequired: false },
    },
    async collect(request: CollectRequest): Promise<CollectResult> {
      attempts += 1;
      adapter.attempts = attempts;
      lastRequest = request;
      adapter.lastRequest = request;
      return behaviour(request, attempts);
    },
    normalize(_input: NormalizeInput): NormalizedDocument {
      throw new Error("not implemented");
    },
    attempts: 0,
    lastRequest: null,
  };
  return adapter;
}

function emptyResult(status: CollectResult["status"], window: TimeWindow): CollectResult {
  return {
    status,
    observations: [],
    nextCheckpoint: status === "FAILED" ? null : { schemaVersion: 1, data: { ok: true } },
    coverage: {
      windowRequested: window,
      windowCovered: status === "FAILED" ? null : window,
      truncated: false,
      truncationReason: null,
      itemsSeen: 0,
    },
    errors: status === "FAILED" ? [{ kind: "ACCESS", message: "stub refused", retryable: false }] : [],
  };
}

describe("CollectSources", () => {
  test("stores observations, saves checkpoints and emits ITEM_COLLECTED", async () => {
    const { collector, raw, checkpoints, events } = harness([new HackerNewsSource(), new RssSource(RSS_FEED)]);

    const summary = await collector.collect({ window: WINDOW, runId: RUN_ID });

    assert.equal(summary.overall, "ALL_OK");
    assert.deepEqual(
      summary.perSource.map((entry) => entry.sourceId).sort(),
      ["hackernews", "rss:example-weekly"],
    );
    for (const entry of summary.perSource) {
      assert.equal(entry.status, "COMPLETE");
      assert.equal(entry.errors.length, 0);
      assert.ok(entry.newObservations > 0);
      assert.equal(entry.newObservations, entry.observationsSeen);
    }

    assert.equal(raw.observations.size, 5);
    assert.equal(checkpoints.saved.size, 2);
    assert.equal(checkpoints.saved.get("hackernews")?.runId, RUN_ID);
    assert.equal(events.ofType("ITEM_COLLECTED").length, 5);
  });

  test("rerunning the same window stores nothing new and reports NO_NEW_ITEMS", async () => {
    const { collector, raw } = harness([new HackerNewsSource(), new RssSource(RSS_FEED)]);

    const first = await collector.collect({ window: WINDOW, runId: RUN_ID });
    assert.equal(first.overall, "ALL_OK");
    const storedAfterFirst = raw.observations.size;

    const second = await collector.collect({ window: WINDOW, runId: "run_collect_test_2" });
    assert.equal(second.overall, "NO_NEW_ITEMS");
    for (const entry of second.perSource) {
      assert.equal(entry.status, "NO_NEW_ITEMS");
      assert.equal(entry.newObservations, 0);
    }
    assert.equal(raw.observations.size, storedAfterFirst);
  });

  test("one failing source plus one healthy source is PARTIAL", async () => {
    const failing = stubSource("stub-broken", (request) => emptyResult("FAILED", request.window));
    const { collector, checkpoints } = harness([new HackerNewsSource(), failing]);

    const summary = await collector.collect({ window: WINDOW, runId: RUN_ID });

    assert.equal(summary.overall, "PARTIAL");
    const broken = summary.perSource.find((entry) => entry.sourceId === "stub-broken");
    assert.equal(broken?.status, "FAILED");
    assert.equal(broken?.errors[0]?.kind, "ACCESS");
    // FAILED 소스의 checkpoint 는 건드리지 않는다.
    assert.equal(checkpoints.saved.has("stub-broken"), false);
    assert.equal(checkpoints.saved.has("hackernews"), true);
  });

  test("every source failing is ALL_FAILED", async () => {
    const a = stubSource("stub-a", (request) => emptyResult("FAILED", request.window));
    const b = stubSource("stub-b", (request) => emptyResult("FAILED", request.window));
    const { collector, checkpoints } = harness([a, b]);

    const summary = await collector.collect({ window: WINDOW, runId: RUN_ID });

    assert.equal(summary.overall, "ALL_FAILED");
    assert.equal(checkpoints.writes, 0);
  });

  test("a 429 from Hacker News is FAILED and leaves the stored checkpoint alone", async () => {
    const { collector, checkpoints } = harness([new HackerNewsSource()], {
      [HN_TOP_STORIES_URL]: { status: 429, headers: {}, text: "" },
    });
    checkpoints.seed("hackernews", { schemaVersion: 1, data: { lastMaxItemId: 40999999 } });

    const summary = await collector.collect({ window: WINDOW, runId: RUN_ID });

    assert.equal(summary.overall, "ALL_FAILED");
    assert.equal(summary.perSource[0]?.status, "FAILED");
    assert.equal(summary.perSource[0]?.errors.some((error) => error.kind === "RATE_LIMIT"), true);
    assert.deepEqual(checkpoints.saved.get("hackernews")?.checkpoint, {
      schemaVersion: 1,
      data: { lastMaxItemId: 40999999 },
    });
  });

  test("a partial source keeps its checkpoint and reports PARTIAL", async () => {
    const partial = stubSource("stub-partial", (request) => ({
      ...emptyResult("PARTIAL", request.window),
      coverage: {
        windowRequested: request.window,
        windowCovered: request.window,
        truncated: true,
        truncationReason: "DEADLINE",
        itemsSeen: 3,
      },
    }));
    const { collector, checkpoints } = harness([partial]);

    const summary = await collector.collect({ window: WINDOW, runId: RUN_ID });
    assert.equal(summary.overall, "PARTIAL");
    assert.equal(summary.perSource[0]?.status, "PARTIAL");
    assert.equal(summary.perSource[0]?.coverage?.truncationReason, "DEADLINE");
    assert.equal(checkpoints.saved.has("stub-partial"), true);
  });

  test("an adapter that throws becomes FAILED/UNKNOWN without killing the run", async () => {
    const throwing = stubSource("stub-throws", () => {
      throw new Error("boom");
    });
    const { collector } = harness([new HackerNewsSource(), throwing]);

    const summary = await collector.collect({ window: WINDOW, runId: RUN_ID });

    assert.equal(summary.overall, "PARTIAL");
    const entry = summary.perSource.find((s) => s.sourceId === "stub-throws");
    assert.equal(entry?.status, "FAILED");
    assert.equal(entry?.errors[0]?.kind, "UNKNOWN");
    assert.equal(entry?.errors[0]?.retryable, false);
  });

  test("retries a retryable failure once", async () => {
    const flaky = stubSource("stub-flaky", (request, attempt) => {
      if (attempt === 1) {
        return {
          ...emptyResult("FAILED", request.window),
          errors: [{ kind: "NETWORK", message: "temporary", retryable: true }],
        };
      }
      return emptyResult("COMPLETE", request.window);
    });
    const { collector } = harness([flaky]);

    const summary = await collector.collect({ window: WINDOW, runId: RUN_ID });

    assert.equal(flaky.attempts, 2);
    assert.equal(summary.perSource[0]?.status, "NO_NEW_ITEMS");
    assert.equal(summary.overall, "NO_NEW_ITEMS");
  });

  test("does not retry a non-retryable failure", async () => {
    const hard = stubSource("stub-hard", (request) => emptyResult("FAILED", request.window));
    const { collector } = harness([hard]);

    await collector.collect({ window: WINDOW, runId: RUN_ID });
    assert.equal(hard.attempts, 1);
  });

  test("drops observations that violate the RawObservation contract", async () => {
    const bad = stubSource("stub-bad", (request) => ({
      ...emptyResult("COMPLETE", request.window),
      observations: [
        {
          schemaVersion: 1,
          id: "not-an-obs-id",
          sourceId: "stub-bad",
          sourceKind: "API",
          externalId: "1",
          originalUrl: null,
          observedAt: "2026-09-12T06:00:00.000Z",
          observedAtIsFetchedAt: true,
          fetchedAt: "2026-09-12T06:00:00.000Z",
          runId: RUN_ID,
          payloadHash: "abc",
          payloadRef: { kind: "inline", json: {} },
          completeness: "TITLE_ONLY",
          rawMetadata: {},
        },
      ],
    }));
    const { collector, raw, logger } = harness([bad]);

    const summary = await collector.collect({ window: WINDOW, runId: RUN_ID });

    assert.equal(raw.observations.size, 0);
    assert.equal(summary.perSource[0]?.observationsSeen, 0);
    assert.equal(summary.perSource[0]?.errors[0]?.kind, "PARSE");
    assert.ok(logger.errors().some((line) => line.message === "invalid observation dropped"));
  });

  test("sourceIds narrows the run", async () => {
    const { collector } = harness([new HackerNewsSource(), new RssSource(RSS_FEED)]);

    const summary = await collector.collect({ window: WINDOW, runId: RUN_ID, sourceIds: ["rss:example-weekly"] });

    assert.equal(summary.perSource.length, 1);
    assert.equal(summary.perSource[0]?.sourceId, "rss:example-weekly");
  });

  test("passes a deadline and an item cap built from defaults and descriptor limits", async () => {
    const probe = stubSource("stub-probe", (request) => emptyResult("COMPLETE", request.window), {
      maxItemsPerRun: 7,
      defaultTimeoutMs: 1_000,
    });
    const { collector } = harness([probe]);

    await collector.collect({ window: WINDOW, runId: RUN_ID });

    assert.equal(probe.lastRequest?.maxItems, 7);
    assert.equal(probe.lastRequest?.runId, RUN_ID);
    assert.equal(probe.lastRequest?.deadlineAt, new Date(Date.parse(NOW) + 1_000).toISOString());
  });

  test("an empty source selection never throws", async () => {
    const { collector } = harness([]);
    const summary = await collector.collect({ window: WINDOW, runId: RUN_ID });
    assert.deepEqual(summary, { perSource: [], overall: "NO_NEW_ITEMS" });
  });
});
