import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ThreadsSource } from "../src/adapters/sources/threads/index.js";
import { validateRawObservation } from "../src/domain/documents/raw-observation.js";
import { validateNormalizedDocument } from "../src/domain/documents/normalized-document.js";
import type { CollectContext, CollectRequest } from "../src/ports/sources/source-adapter.js";
import { FakeClock, FakeHttp, FakeLogger, jsonResponse } from "./helpers/fake-system.js";

const NOW = "2026-10-06T12:00:00.000Z";
const WINDOW = { start: "2026-10-05T00:00:00.000Z", end: NOW };
const TOKEN = "private-threads-token";
const BASE = "https://graph.threads.net/profile_posts?username=choi.openai&fields=id%2Ctext%2Ctimestamp%2Cpermalink%2Cusername%2Cmedia_type";

function post(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    text: `Workflow ${id}: https://example.com/${id}.`,
    timestamp: "2026-10-06T01:00:00+00:00",
    permalink: `https://www.threads.net/@choi.openai/post/${id}`,
    username: "choi.openai",
    media_type: "TEXT_POST",
    ...fields,
  };
}

function setup(routes: Record<string, ReturnType<typeof jsonResponse>>, token: string | undefined = TOKEN) {
  const clock = new FakeClock(NOW);
  const http = new FakeHttp(routes);
  const logger = new FakeLogger();
  const ctx: CollectContext = { signal: new AbortController().signal, clock, http, logger };
  const request: CollectRequest = {
    window: WINDOW,
    checkpoint: { schemaVersion: 1, data: { after: "stale-cursor", accessToken: "must-not-use" } },
    maxItems: 10,
    deadlineAt: "2026-10-06T13:00:00.000Z",
    runId: "run_threads_test",
  };
  return { source: new ThreadsSource({ username: "choi.openai", accessToken: token }), ctx, request, http, logger };
}

describe("ThreadsSource", () => {
  test("reads exact public posts, keeps text, links and observation lineage", async () => {
    const { source, ctx, request, http } = setup({ [BASE]: jsonResponse({ data: [post("ABC", { text: "First line\nSee https://example.com/guide." })] }) });
    const result = await source.collect(request, ctx);
    assert.equal(source.descriptor.id, "threads:choi.openai");
    assert.equal(source.descriptor.kind, "API");
    assert.deepEqual(source.descriptor.capabilities.metrics, []);
    assert.equal(source.descriptor.capabilities.comments, false);
    assert.equal(source.descriptor.capabilities.checkpoint, false);
    assert.equal(result.status, "COMPLETE");
    assert.equal(result.nextCheckpoint, null);
    assert.equal(result.observations.length, 1);
    assert.equal(http.requests[0]?.url, BASE);
    assert.equal(http.requests[0]?.headers?.authorization, `Bearer ${TOKEN}`);
    assert.ok(!http.requests[0]?.url.includes(TOKEN));
    const observation = result.observations[0]!;
    assert.doesNotThrow(() => validateRawObservation(observation));
    assert.equal(observation.originalUrl, "https://www.threads.net/@choi.openai/post/ABC");
    assert.deepEqual(observation.rawMetadata, { mediaType: "TEXT_POST" });
    assert.equal(JSON.stringify(observation).includes(TOKEN), false);
    const document = source.normalize({ observation, existing: null, runId: "run_threads_test", normalizedAt: NOW });
    assert.doesNotThrow(() => validateNormalizedDocument(document));
    assert.equal(document.title, "First line");
    assert.equal(document.content, "First line\nSee https://example.com/guide.");
    assert.equal(document.publishedAt, "2026-10-06T01:00:00.000Z");
    assert.equal(document.canonicalUrl, observation.originalUrl);
    assert.deepEqual(document.urls, [observation.originalUrl, "https://example.com/guide"]);
    assert.deepEqual(document.comments, []);
    assert.deepEqual(document.metrics, []);
    assert.equal(document.latestObservationId, observation.id);
    assert.equal(document.firstObservationId, observation.id);
    const versioned = source.normalize({ observation, existing: { ...document, firstObservationId: "obs_first" }, runId: "next", normalizedAt: NOW });
    assert.equal(versioned.firstObservationId, "obs_first");
  });

  test("missing authorization fails before HTTP and never exposes token in errors or logs", async () => {
    const { source, ctx, request, http } = setup({}, "");
    const result = await source.collect(request, ctx);
    assert.equal(result.status, "FAILED");
    assert.equal(result.errors[0]?.kind, "ACCESS");
    assert.match(result.errors[0]!.message, /authorization/u);
    assert.equal(http.requests.length, 0);
  });

  test("an actual empty data array succeeds; absent or malformed data fails", async () => {
    const empty = setup({ [BASE]: jsonResponse({ data: [] }) });
    assert.equal((await empty.source.collect(empty.request, empty.ctx)).status, "COMPLETE");
    for (const payload of [{}, { data: null }, { data: {} }, { data: [null] }]) {
      const fixture = setup({ [BASE]: jsonResponse(payload) });
      const result = await fixture.source.collect(fixture.request, fixture.ctx);
      assert.equal(result.status, "FAILED");
      assert.equal(result.errors[0]?.kind, "PARSE");
    }
  });

  test("rejects another author and off-platform or non-post permalink", async () => {
    for (const bad of [
      post("A", { username: "other" }),
      post("A", { permalink: "https://evil.example/@choi.openai/post/A" }),
      post("A", { permalink: "https://www.threads.com/@other/post/A" }),
      post("A", { permalink: "https://www.threads.com/@choi.openai" }),
    ]) {
      const fixture = setup({ [BASE]: jsonResponse({ data: [bad] }) });
      const result = await fixture.source.collect(fixture.request, fixture.ctx);
      assert.equal(result.status, "FAILED");
      assert.equal(result.observations.length, 0);
    }
  });

  test("unknown timestamp remains null and an old dated post is excluded", async () => {
    const fixture = setup({ [BASE]: jsonResponse({ data: [post("A", { timestamp: "unknown", permalink: "https://www.threads.com/@choi.openai/post/A" }), post("B", { timestamp: "2020-01-01T00:00:00Z" })] }) });
    const result = await fixture.source.collect(fixture.request, fixture.ctx);
    assert.equal(result.status, "COMPLETE");
    assert.deepEqual(result.observations.map((item) => item.externalId), ["A"]);
    const document = fixture.source.normalize({ observation: result.observations[0]!, existing: null, runId: fixture.request.runId, normalizedAt: NOW });
    assert.equal(document.publishedAt, null);
    assert.equal(document.canonicalUrl, "https://www.threads.com/@choi.openai/post/A");
  });

  test("rebuilds only the official URL from an after cursor and dedupes repeated posts", async () => {
    const second = `${BASE}&after=cursor-1`;
    const fixture = setup({
      [BASE]: jsonResponse({ data: [post("A")], paging: { cursors: { after: "cursor-1" }, next: "https://evil.example/steal" } }),
      [second]: jsonResponse({ data: [post("A"), post("B")] }),
    });
    const result = await fixture.source.collect(fixture.request, fixture.ctx);
    assert.equal(result.status, "COMPLETE");
    assert.deepEqual(result.observations.map((item) => item.externalId), ["A", "B"]);
    assert.deepEqual(fixture.http.requests.map((item) => item.url), [BASE, second]);
    assert.equal(result.nextCheckpoint, null);
  });

  test("bounded page count and maxItems report partial without advancing checkpoint", async () => {
    const routes: Record<string, ReturnType<typeof jsonResponse>> = {};
    for (let n = 0; n < 5; n += 1) {
      routes[n === 0 ? BASE : `${BASE}&after=cursor-${n}`] = jsonResponse({ data: [post(String(n))], paging: { cursors: { after: `cursor-${n + 1}` } } });
    }
    const fixture = setup(routes);
    const result = await fixture.source.collect(fixture.request, fixture.ctx);
    assert.equal(result.status, "PARTIAL");
    assert.equal(result.coverage.truncationReason, "PAGINATION_LIMIT");
    assert.equal(result.observations.length, 5);
    assert.equal(fixture.http.requests.length, 5);
    assert.equal(result.nextCheckpoint, null);
    const limited = setup({ [BASE]: jsonResponse({ data: [post("A"), post("B")] }) });
    const max = await limited.source.collect({ ...limited.request, maxItems: 1 }, limited.ctx);
    assert.equal(max.status, "PARTIAL");
    assert.equal(max.coverage.truncationReason, "MAX_ITEMS");
    assert.equal(max.observations.length, 1);
    assert.equal(max.nextCheckpoint, null);
  });

  test("unusable or repeated pagination remains partial and never follows next URL", async () => {
    const nextOnly = setup({ [BASE]: jsonResponse({ data: [post("A")], paging: { next: "https://evil.example/steal" } }) });
    const partial = await nextOnly.source.collect(nextOnly.request, nextOnly.ctx);
    assert.equal(partial.status, "PARTIAL");
    assert.equal(partial.errors[0]?.kind, "PARSE");
    assert.deepEqual(nextOnly.http.requests.map((entry) => entry.url), [BASE]);
    const repeated = setup({
      [BASE]: jsonResponse({ data: [post("A")], paging: { cursors: { after: "same" } } }),
      [`${BASE}&after=same`]: jsonResponse({ data: [post("B")], paging: { cursors: { after: "same" } } }),
    });
    const repeatedResult = await repeated.source.collect(repeated.request, repeated.ctx);
    assert.equal(repeatedResult.status, "PARTIAL");
    assert.equal(repeatedResult.errors[0]?.kind, "PARSE");
    assert.equal(repeatedResult.observations.length, 2);
    assert.equal(repeated.http.requests.length, 2);
  });

  test("expired deadline and aborted request report timeout without HTTP", async () => {
    const expired = setup({});
    const result = await expired.source.collect({ ...expired.request, deadlineAt: NOW }, expired.ctx);
    assert.equal(result.status, "FAILED");
    assert.equal(result.errors[0]?.kind, "TIMEOUT");
    assert.equal(expired.http.requests.length, 0);
    const aborted = setup({});
    const controller = new AbortController();
    controller.abort();
    const abortedResult = await aborted.source.collect(aborted.request, { ...aborted.ctx, signal: controller.signal });
    assert.equal(abortedResult.errors[0]?.kind, "TIMEOUT");
    assert.equal(aborted.http.requests.length, 0);
  });

  test("auth, rate limit, network, malformed JSON and later-page failure retain honest coverage", async () => {
    for (const [status, kind] of [[401, "ACCESS"], [403, "ACCESS"], [429, "RATE_LIMIT"], [503, "NETWORK"]] as const) {
      const fixture = setup({ [BASE]: jsonResponse({ error: { message: TOKEN } }, status) });
      const result = await fixture.source.collect(fixture.request, fixture.ctx);
      assert.equal(result.status, "FAILED");
      assert.equal(result.errors[0]?.kind, kind);
      assert.equal(JSON.stringify(result).includes(TOKEN), false);
    }
    const invalidJson = setup({ [BASE]: { status: 200, headers: {}, text: "{bad" } });
    assert.equal((await invalidJson.source.collect(invalidJson.request, invalidJson.ctx)).errors[0]?.kind, "PARSE");
    const network = setup({});
    const networkResult = await network.source.collect(network.request, network.ctx);
    assert.equal(networkResult.status, "FAILED");
    assert.equal(networkResult.errors[0]?.kind, "NETWORK");
    const later = setup({ [BASE]: jsonResponse({ data: [post("A")], paging: { cursors: { after: "next" } } }), [`${BASE}&after=next`]: jsonResponse({ error: "denied" }, 403) });
    const partial = await later.source.collect(later.request, later.ctx);
    assert.equal(partial.status, "PARTIAL");
    assert.equal(partial.observations.length, 1);
    assert.equal(partial.coverage.windowCovered, null);
  });
});
