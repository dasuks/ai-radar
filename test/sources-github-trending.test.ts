import assert from "node:assert/strict";
import { test } from "node:test";
import { GithubTrendingSource, TRENDING_BASE } from "../src/adapters/sources/github-trending/index.js";
import { looksAiRelated } from "../src/policies/classification/source-relevance.js";
import { validateRawObservation } from "../src/domain/documents/raw-observation.js";
import { validateNormalizedDocument } from "../src/domain/documents/normalized-document.js";
import { FakeClock, FakeHttp, FakeLogger, jsonResponse, textResponse } from "./helpers/fake-system.js";
const NOW = "2026-10-06T12:00:00.000Z";
const repo = { url: "https://github.com/example/assistant", description: "Coding assistant" };
function setup(items: unknown[] = [repo]) {
  const snapshot = { pubDate: NOW, items };
  const http = new FakeHttp({
    [`${TRENDING_BASE}/daily/all.json`]: jsonResponse(snapshot),
    [`${TRENDING_BASE}/weekly/all.json`]: jsonResponse(snapshot),
    "https://api.github.com/repos/example/assistant/readme": textResponse("# Agent\nRun coding workflows. Requires Python. https://untrusted.example/instructions"),
  });
  const source = new GithubTrendingSource(looksAiRelated);
  const ctx = { clock: new FakeClock(NOW), http, logger: new FakeLogger(), signal: new AbortController().signal };
  const request = { window: { start: "2026-10-05T12:00:00.000Z", end: NOW }, checkpoint: null, maxItems: 25, deadlineAt: "2026-10-06T12:05:00.000Z", runId: "test" };
  return { source, ctx, request, http };
}
test("Trending merges daily/weekly, reads README once, preserves evidence without inventing release date", async () => {
  const { source, ctx, request, http } = setup();
  const result = await source.collect(request, ctx);
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.observations.length, 1);
  const observation = validateRawObservation(result.observations[0]);
  const doc = validateNormalizedDocument(source.normalize({ observation, existing: null, runId: "test", normalizedAt: NOW }));
  assert.equal(doc.publishedAt, null);
  assert.match(doc.content!, /Requires Python/);
  assert.match(doc.content!, /weekly Trending/);
  assert.deepEqual(doc.metrics, []);
  assert.ok(doc.urls.includes("https://github.com/example/assistant#readme"));
  assert.equal(http.requests.length, 3);
  assert.ok(http.requests.every(r => !r.url.includes("untrusted.example")));
  const repeated = await source.collect({ ...request, checkpoint: result.nextCheckpoint }, ctx);
  assert.equal(repeated.observations.length, 0);
  http.set("https://api.github.com/repos/example/assistant/readme", textResponse("# Agent\nNow supports local testing."));
  const changed = await source.collect({ ...request, checkpoint: result.nextCheckpoint }, ctx);
  assert.equal(changed.observations.length, 1);
  assert.equal(source.normalize({ observation: changed.observations[0]!, existing: doc, runId: "test", normalizedAt: NOW }).firstObservationId, doc.firstObservationId);
});
test("Trending rejects stale or malformed snapshots and unsafe repository URLs", async () => {
  for (const data of [{}, { pubDate: "2020-01-01", items: [repo] }, { pubDate: "2030-01-01", items: [] }]) {
    const f = setup();
    for (const p of ["daily", "weekly"]) f.http.set(`${TRENDING_BASE}/${p}/all.json`, jsonResponse(data));
    const result = await f.source.collect(f.request, f.ctx);
    assert.equal(result.status, "FAILED");
    assert.equal(result.observations.length, 0);
  }
  const bad = setup([{ ...repo, url: "https://github.com.evil.example/owner/repo" }]);
  const result = await bad.source.collect(bad.request, bad.ctx);
  assert.equal(result.status, "PARTIAL");
  assert.equal(bad.http.requests.length, 2);
});
test("Trending keeps healthy period on mirror failure and handles README rate limits honestly", async () => {
  for (const status of [403, 429, 500]) {
    for (const period of ["daily", "weekly"]) {
      const partial = setup();
      partial.http.set(`${TRENDING_BASE}/${period}/all.json`, textResponse("unavailable", status));
      const healthy = await partial.source.collect(partial.request, partial.ctx);
      assert.equal(healthy.status, "PARTIAL");
      assert.equal(healthy.observations.length, 1, `${period} ${status} must not block the other period`);
    }
  }
  const f = setup();
  f.http.set(`${TRENDING_BASE}/weekly/all.json`, textResponse("broken", 500));
  const result = await f.source.collect(f.request, f.ctx);
  assert.equal(result.status, "PARTIAL");
  assert.equal(result.observations.length, 1);
  f.http.set("https://api.github.com/repos/example/assistant/readme", textResponse("limited", 429));
  const limited = await f.source.collect(f.request, f.ctx);
  assert.equal(limited.status, "PARTIAL");
  assert.equal(limited.coverage.truncationReason, "RATE_LIMIT");
  assert.equal(limited.observations.length, 0);
});
test("Trending filters unrelated README and bounds requests with deadline/item limits", async () => {
  const f = setup();
  f.http.set("https://api.github.com/repos/example/assistant/readme", textResponse("# Cooking recipes"));
  const source = new GithubTrendingSource(() => false);
  assert.equal((await source.collect(f.request, f.ctx)).observations.length, 0);
  const limited = await f.source.collect({ ...f.request, maxItems: 0 }, f.ctx);
  assert.equal(limited.coverage.truncationReason, "MAX_ITEMS");
  const expired = await f.source.collect({ ...f.request, deadlineAt: NOW }, f.ctx);
  assert.equal(expired.status, "FAILED");
  assert.equal(expired.coverage.truncationReason, "DEADLINE");
});
