import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { HackerNewsSource } from "../src/adapters/sources/hackernews/hackernews-source.js";
import { looksAiRelated } from "../src/adapters/sources/hackernews/keywords.js";
import { readHnPayload } from "../src/adapters/sources/hackernews/normalize.js";
import { validateRawObservation } from "../src/domain/documents/raw-observation.js";
import { validateNormalizedDocument } from "../src/domain/documents/normalized-document.js";
import type { CollectContext, CollectRequest } from "../src/ports/sources/source-adapter.js";
import type { RawObservation } from "../src/domain/documents/raw-observation.js";
import { FakeClock, FakeHttp, FakeLogger, jsonResponse } from "./helpers/fake-system.js";
import {
  HN_MCP_STORY_ID,
  HN_STORY_ID,
  HN_TEXT_STORY_ID,
  HN_TOP_STORIES,
  HN_TOP_STORIES_URL,
  HN_WINDOW,
  hackerNewsRoutes,
} from "./fixtures/hackernews.js";

const NOW = "2026-09-12T12:00:00.000Z";
const RUN_ID = "run_hn_test";

function makeContext(http: FakeHttp, clock: FakeClock): { ctx: CollectContext; logger: FakeLogger } {
  const logger = new FakeLogger();
  const controller = new AbortController();
  return { ctx: { signal: controller.signal, clock, logger, http }, logger };
}

function makeRequest(clock: FakeClock, overrides: Partial<CollectRequest> = {}): CollectRequest {
  return {
    window: HN_WINDOW,
    checkpoint: null,
    maxItems: 50,
    deadlineAt: new Date(clock.nowMs() + 60_000).toISOString(),
    runId: RUN_ID,
    ...overrides,
  };
}

function byExternalId(observations: readonly RawObservation[], externalId: string): RawObservation {
  const found = observations.find((observation) => observation.externalId === externalId);
  assert.ok(found, `expected an observation for ${externalId}`);
  return found;
}

describe("HackerNewsSource descriptor", () => {
  test("declares honest capabilities and license", () => {
    const source = new HackerNewsSource();
    assert.equal(source.descriptor.id, "hackernews");
    assert.equal(source.descriptor.kind, "API");
    assert.deepEqual(source.descriptor.capabilities.metrics, ["hn.points", "hn.comments"]);
    assert.equal(source.descriptor.capabilities.expectedCompleteness, "TITLE_ONLY");
    assert.equal(source.descriptor.capabilities.comments, true);
    assert.deepEqual(source.descriptor.license, {
      name: "Hacker News API (Firebase)",
      url: "https://github.com/HackerNews/API",
      attributionRequired: false,
    });
  });
});

describe("AI keyword filter", () => {
  test("keeps AI titles and drops unrelated ones", () => {
    assert.equal(looksAiRelated("Claude Opus 5 ships a 1M token context window"), true);
    assert.equal(looksAiRelated("Ask HN: LLM inference on a Raspberry Pi"), true);
    assert.equal(looksAiRelated("Agents that read your repo"), true);
    assert.equal(looksAiRelated("Vibe coding considered harmful"), true);
    assert.equal(looksAiRelated("A new sourdough starter technique"), false);
    assert.equal(looksAiRelated("Waiting in the rain for a train"), false);
  });
});

describe("HackerNewsSource.collect", () => {
  test("happy path: filters by window and keyword, attaches comments and metrics", async () => {
    const clock = new FakeClock(NOW);
    const http = new FakeHttp(hackerNewsRoutes());
    const { ctx } = makeContext(http, clock);
    const source = new HackerNewsSource();

    const result = await source.collect(makeRequest(clock), ctx);

    assert.equal(result.status, "COMPLETE");
    assert.equal(result.errors.length, 0);
    assert.equal(result.coverage.itemsSeen, HN_TOP_STORIES.length);
    assert.equal(result.coverage.truncated, false);
    assert.deepEqual(result.coverage.windowCovered, HN_WINDOW);

    const externalIds = result.observations.map((observation) => observation.externalId).sort();
    assert.deepEqual(externalIds, [String(HN_STORY_ID), String(HN_TEXT_STORY_ID), String(HN_MCP_STORY_ID)].sort());

    for (const observation of result.observations) {
      assert.doesNotThrow(() => validateRawObservation(observation));
      assert.equal(observation.sourceId, "hackernews");
      assert.equal(observation.sourceKind, "API");
      assert.equal(observation.observedAtIsFetchedAt, true);
      assert.equal(observation.observedAt, observation.fetchedAt);
      assert.equal(observation.fetchedAt, NOW);
      assert.equal(observation.payloadRef.kind, "inline");
      assert.ok(observation.id.startsWith("obs_"));
    }

    const story = byExternalId(result.observations, String(HN_STORY_ID));
    assert.equal(story.originalUrl, "https://example.com/claude-opus-5");
    assert.equal(story.completeness, "TITLE_ONLY");
    assert.deepEqual(story.rawMetadata, { score: 412, descendants: 87, type: "story" });
    const payload = readHnPayload(story.payloadRef.kind === "inline" ? story.payloadRef.json : null);
    assert.ok(payload);
    // 삭제된 댓글은 payload 에 들어가지 않는다.
    assert.deepEqual(
      payload.comments.map((comment) => comment.id),
      [41000101, 41000102],
    );

    const askHn = byExternalId(result.observations, String(HN_TEXT_STORY_ID));
    assert.equal(askHn.completeness, "EXCERPT");
    assert.equal(askHn.originalUrl, `https://news.ycombinator.com/item?id=${HN_TEXT_STORY_ID}`);

    assert.deepEqual(result.nextCheckpoint, { schemaVersion: 1, data: { lastMaxItemId: HN_MCP_STORY_ID } });
  });

  test("normalize produces a valid document with stripped html, comments and metrics", async () => {
    const clock = new FakeClock(NOW);
    const http = new FakeHttp(hackerNewsRoutes());
    const { ctx } = makeContext(http, clock);
    const source = new HackerNewsSource();
    const result = await source.collect(makeRequest(clock), ctx);

    const story = byExternalId(result.observations, String(HN_STORY_ID));
    const document = source.normalize({
      observation: story,
      existing: null,
      runId: RUN_ID,
      normalizedAt: NOW,
    });
    assert.doesNotThrow(() => validateNormalizedDocument(document));

    assert.equal(document.title, "Claude Opus 5 ships a 1M token context window");
    assert.equal(document.content, null);
    assert.equal(document.contentCompleteness, "TITLE_ONLY");
    assert.equal(document.canonicalUrl, "https://example.com/claude-opus-5");
    assert.deepEqual(document.urls, ["https://example.com/claude-opus-5"]);
    assert.equal(document.author.name, "alice");
    assert.equal(document.publishedAt, "2026-09-12T06:00:00.000Z");
    assert.deepEqual(document.tags, ["hackernews"]);
    assert.equal(document.status, "ACTIVE");
    assert.equal(document.provenance.normalizerVersion, "hackernews@1");
    assert.equal(document.latestObservationId, story.id);
    assert.equal(document.firstObservationId, story.id);
    assert.deepEqual(document.metrics, [
      { key: "hn.points", value: 412, observedAt: story.observedAt },
      { key: "hn.comments", value: 87, observedAt: story.observedAt },
    ]);
    assert.equal(document.comments.length, 2);
    assert.equal(document.comments[0]?.author, "bob");
    assert.equal(document.comments[0]?.content, "Impressive numbers. I'm curious about latency.");
    assert.equal(document.comments[1]?.content, "Benchmarks or it didn't happen.");
    assert.equal(document.comments[0]?.parentExternalId, String(HN_STORY_ID));

    const askHn = byExternalId(result.observations, String(HN_TEXT_STORY_ID));
    const askDocument = source.normalize({ observation: askHn, existing: null, runId: RUN_ID, normalizedAt: NOW });
    assert.equal(askDocument.contentCompleteness, "EXCERPT");
    assert.equal(askDocument.content, "We ran a 7B model on a Pi 5 & measured 3.4 tok/s.\nNotes: writeup");
    assert.deepEqual(askDocument.urls, ["https://example.org/pi-llm"]);
  });

  test("429 maps to a retryable RATE_LIMIT failure and keeps the checkpoint", async () => {
    const clock = new FakeClock(NOW);
    const routes = hackerNewsRoutes();
    routes[HN_TOP_STORIES_URL] = { status: 429, headers: { "retry-after": "30" }, text: "" };
    const http = new FakeHttp(routes);
    const { ctx } = makeContext(http, clock);
    const source = new HackerNewsSource();

    const seeded = { schemaVersion: 1, data: { lastMaxItemId: 40999999 } };
    const result = await source.collect(makeRequest(clock, { checkpoint: seeded }), ctx);

    assert.equal(result.status, "FAILED");
    assert.deepEqual(result.observations, []);
    // FAILED 면 checkpoint 를 갱신하지 않는다 (PIPELINES §2.2).
    assert.equal(result.nextCheckpoint, null);
    assert.equal(result.coverage.windowCovered, null);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]?.kind, "RATE_LIMIT");
    assert.equal(result.errors[0]?.retryable, true);
  });

  test("invalid JSON maps to a non-retryable PARSE failure", async () => {
    const clock = new FakeClock(NOW);
    const routes = hackerNewsRoutes();
    routes[HN_TOP_STORIES_URL] = { status: 200, headers: {}, text: "{not json" };
    const http = new FakeHttp(routes);
    const { ctx } = makeContext(http, clock);

    const result = await new HackerNewsSource().collect(makeRequest(clock), ctx);

    assert.equal(result.status, "FAILED");
    assert.equal(result.errors[0]?.kind, "PARSE");
    assert.equal(result.errors[0]?.retryable, false);
  });

  test("maxItems truncates and reports PARTIAL/MAX_ITEMS", async () => {
    const clock = new FakeClock(NOW);
    const http = new FakeHttp(hackerNewsRoutes());
    const { ctx } = makeContext(http, clock);

    const result = await new HackerNewsSource().collect(makeRequest(clock, { maxItems: 1 }), ctx);

    assert.equal(result.status, "PARTIAL");
    assert.equal(result.observations.length, 1);
    assert.equal(result.coverage.truncated, true);
    assert.equal(result.coverage.truncationReason, "MAX_ITEMS");
  });

  test("passing the deadline stops the run and reports PARTIAL/DEADLINE", async () => {
    const clock = new FakeClock(NOW);
    // 요청 한 번마다 5초가 흐른다. deadline 은 3초 뒤다.
    const http = new FakeHttp(hackerNewsRoutes(), { onRequest: () => clock.advance(5_000) });
    const { ctx } = makeContext(http, clock);

    const request = makeRequest(clock, { deadlineAt: new Date(clock.nowMs() + 3_000).toISOString() });
    const result = await new HackerNewsSource().collect(request, ctx);

    assert.equal(result.status, "PARTIAL");
    assert.equal(result.coverage.truncated, true);
    assert.equal(result.coverage.truncationReason, "DEADLINE");
    // topstories 한 번만 부르고 멈춘다.
    assert.equal(http.requests.length, 1);
  });

  test("an aborted signal stops the run without throwing", async () => {
    const clock = new FakeClock(NOW);
    const http = new FakeHttp(hackerNewsRoutes());
    const logger = new FakeLogger();
    const controller = new AbortController();
    controller.abort();
    const ctx: CollectContext = { signal: controller.signal, clock, logger, http };

    const result = await new HackerNewsSource().collect(makeRequest(clock), ctx);
    assert.ok(result.status === "PARTIAL" || result.status === "FAILED");
  });

  test("skips items the API returns as null without failing", async () => {
    const clock = new FakeClock(NOW);
    const routes = hackerNewsRoutes();
    routes[`https://hacker-news.firebaseio.com/v0/item/${HN_MCP_STORY_ID}.json`] = jsonResponse(null);
    const http = new FakeHttp(routes);
    const { ctx } = makeContext(http, clock);

    const result = await new HackerNewsSource().collect(makeRequest(clock), ctx);
    assert.equal(result.status, "COMPLETE");
    assert.equal(result.observations.length, 2);
  });
});
