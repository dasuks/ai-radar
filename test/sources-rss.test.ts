import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { RssSource, createRssSources } from "../src/adapters/sources/rss/rss-source.js";
import { parseFeed } from "../src/adapters/sources/rss/feed.js";
import { validateRawObservation } from "../src/domain/documents/raw-observation.js";
import { validateNormalizedDocument } from "../src/domain/documents/normalized-document.js";
import type { CollectContext, CollectRequest, SourceCheckpoint } from "../src/ports/sources/source-adapter.js";
import type { RawObservation } from "../src/domain/documents/raw-observation.js";
import { FakeClock, FakeHttp, FakeLogger, textResponse } from "./helpers/fake-system.js";
import {
  ATOM_AGENTS_ID,
  ATOM_FEED_URL,
  ATOM_FEED_XML,
  ATOM_MCP_ID,
  RSS_2_FEED_XML,
  RSS_EDGE_GUID,
  RSS_FEED_URL,
  RSS_ITEM_GUID,
} from "./fixtures/feeds.js";

const NOW = "2026-09-12T12:00:00.000Z";
const RUN_ID = "run_rss_test";
const WINDOW = { start: "2026-09-12T00:00:00.000Z", end: "2026-09-12T12:00:00.000Z" };

const RSS_FEED = { id: "example-weekly", name: "Example AI Weekly", url: RSS_FEED_URL };
const ATOM_FEED = { id: "example-blog", name: "Example Engineering Blog", url: ATOM_FEED_URL };

function makeContext(http: FakeHttp, clock: FakeClock): { ctx: CollectContext; logger: FakeLogger } {
  const logger = new FakeLogger();
  const controller = new AbortController();
  return { ctx: { signal: controller.signal, clock, logger, http }, logger };
}

function makeRequest(clock: FakeClock, overrides: Partial<CollectRequest> = {}): CollectRequest {
  return {
    window: WINDOW,
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

describe("feed parser", () => {
  test("reads RSS 2.0 items", () => {
    const parsed = parseFeed(RSS_2_FEED_XML);
    assert.ok(parsed);
    assert.equal(parsed.kind, "rss");
    assert.equal(parsed.feedTitle, "Example AI Weekly");
    assert.equal(parsed.items.length, 3);

    const first = parsed.items[0]?.item;
    assert.ok(first);
    assert.equal(first.title, "Claude Opus 5 ships a 1M token context window");
    assert.equal(first.guid, RSS_ITEM_GUID);
    assert.equal(first.externalId, RSS_ITEM_GUID);
    assert.equal(first.link, "https://example.com/claude-opus-5?utm_source=feed&utm_medium=rss");
    assert.equal(first.publishedAt, "2026-09-12T06:30:00.000Z");
    assert.equal(first.author, "Sam Writer");
    assert.deepEqual(first.categories, ["models"]);
    assert.equal(first.completeness, "FULL");
    assert.ok(parsed.items[0]?.rawXml.startsWith("<item>"));

    const second = parsed.items[1]?.item;
    assert.ok(second);
    assert.equal(second.completeness, "EXCERPT");
    assert.equal(second.contentHtml, null);
    assert.equal(second.summaryHtml, "<p>Tom &amp; Jerry benchmarked a 3B model.</p>");
  });

  test("reads Atom entries and prefers rel=alternate links", () => {
    const parsed = parseFeed(ATOM_FEED_XML);
    assert.ok(parsed);
    assert.equal(parsed.kind, "atom");
    assert.equal(parsed.feedTitle, "Example Engineering Blog");
    assert.equal(parsed.items.length, 2);

    const mcp = parsed.items[0]?.item;
    assert.ok(mcp);
    assert.equal(mcp.externalId, ATOM_MCP_ID);
    assert.equal(mcp.link, "https://blog.example.org/mcp-turns-one");
    assert.equal(mcp.publishedAt, "2026-09-12T05:00:00.000Z");
    assert.equal(mcp.updatedAt, "2026-09-12T05:05:00.000Z");
    assert.equal(mcp.author, "Jane Doe");
    assert.deepEqual(mcp.categories, ["protocols"]);
    assert.equal(mcp.completeness, "EXCERPT");

    const agents = parsed.items[1]?.item;
    assert.ok(agents);
    assert.equal(agents.link, "https://blog.example.org/agents-read-repo");
    assert.equal(agents.completeness, "FULL");
  });

  test("returns null for something that is not a feed", () => {
    assert.equal(parseFeed("<html><body>not a feed</body></html>"), null);
  });
});

describe("RssSource.collect", () => {
  test("collects RSS 2.0 items inside the window", async () => {
    const clock = new FakeClock(NOW);
    const http = new FakeHttp({ [RSS_FEED_URL]: textResponse(RSS_2_FEED_XML, 200, { etag: 'W/"v1"' }) });
    const { ctx } = makeContext(http, clock);
    const source = new RssSource(RSS_FEED);

    assert.equal(source.descriptor.id, "rss:example-weekly");
    assert.equal(source.descriptor.kind, "RSS");
    assert.deepEqual(source.descriptor.capabilities.metrics, []);

    const result = await source.collect(makeRequest(clock), ctx);

    assert.equal(result.status, "COMPLETE");
    assert.equal(result.coverage.itemsSeen, 3);
    assert.equal(result.observations.length, 2);
    assert.deepEqual(
      result.observations.map((observation) => observation.externalId),
      [RSS_ITEM_GUID, RSS_EDGE_GUID],
    );

    for (const observation of result.observations) {
      assert.doesNotThrow(() => validateRawObservation(observation));
      assert.equal(observation.sourceId, "rss:example-weekly");
      assert.equal(observation.sourceKind, "RSS");
      assert.equal(observation.observedAtIsFetchedAt, true);
      assert.equal(observation.observedAt, observation.fetchedAt);
      assert.equal(observation.rawMetadata.feedId, "example-weekly");
      assert.equal(observation.rawMetadata.feedTitle, "Example AI Weekly");
    }

    const first = byExternalId(result.observations, RSS_ITEM_GUID);
    assert.equal(first.completeness, "FULL");
    assert.equal(first.originalUrl, "https://example.com/claude-opus-5?utm_source=feed&utm_medium=rss");
    assert.equal(first.payloadRef.kind, "inline");
    if (first.payloadRef.kind === "inline") {
      const payload = first.payloadRef.json as { rawXml: string };
      assert.ok(payload.rawXml.includes("<title>Claude Opus 5"));
    }

    assert.deepEqual(result.nextCheckpoint, {
      schemaVersion: 1,
      data: { lastSeenGuids: [RSS_ITEM_GUID, RSS_EDGE_GUID], etag: 'W/"v1"', lastModified: null },
    });
  });

  test("normalize strips html, decodes entities and canonicalises the url", async () => {
    const clock = new FakeClock(NOW);
    const http = new FakeHttp({ [RSS_FEED_URL]: textResponse(RSS_2_FEED_XML) });
    const { ctx } = makeContext(http, clock);
    const source = new RssSource(RSS_FEED);
    const result = await source.collect(makeRequest(clock), ctx);

    const full = source.normalize({
      observation: byExternalId(result.observations, RSS_ITEM_GUID),
      existing: null,
      runId: RUN_ID,
      normalizedAt: NOW,
    });
    assert.doesNotThrow(() => validateNormalizedDocument(full));
    assert.equal(full.contentCompleteness, "FULL");
    assert.equal(full.canonicalUrl, "https://example.com/claude-opus-5");
    assert.equal(full.author.name, "Sam Writer");
    assert.equal(full.publishedAt, "2026-09-12T06:30:00.000Z");
    assert.deepEqual(full.metrics, []);
    assert.deepEqual(full.comments, []);
    assert.deepEqual(full.tags, ["example-weekly", "models"]);
    assert.equal(full.provenance.normalizerVersion, "rss@1");
    assert.ok(full.content);
    assert.ok(!full.content.includes("<p>"));
    assert.ok(full.urls.includes("https://example.com/claude-opus-5/notes"));

    const excerpt = source.normalize({
      observation: byExternalId(result.observations, RSS_EDGE_GUID),
      existing: null,
      runId: RUN_ID,
      normalizedAt: NOW,
    });
    assert.equal(excerpt.contentCompleteness, "EXCERPT");
    assert.equal(excerpt.content, "Tom & Jerry benchmarked a 3B model.");
  });

  test("collects Atom entries", async () => {
    const clock = new FakeClock(NOW);
    const http = new FakeHttp({ [ATOM_FEED_URL]: textResponse(ATOM_FEED_XML) });
    const { ctx } = makeContext(http, clock);
    const source = new RssSource(ATOM_FEED);

    const result = await source.collect(makeRequest(clock), ctx);
    assert.equal(result.status, "COMPLETE");
    assert.equal(result.observations.length, 2);

    const mcp = byExternalId(result.observations, ATOM_MCP_ID);
    const document = source.normalize({ observation: mcp, existing: null, runId: RUN_ID, normalizedAt: NOW });
    assert.doesNotThrow(() => validateNormalizedDocument(document));
    assert.equal(document.title, "Model Context Protocol turns one");
    assert.equal(document.content, "MCP & the year ahead.");
    assert.equal(document.canonicalUrl, "https://blog.example.org/mcp-turns-one");
    assert.equal(document.updatedAt, "2026-09-12T05:05:00.000Z");

    const agents = byExternalId(result.observations, ATOM_AGENTS_ID);
    const agentsDocument = source.normalize({ observation: agents, existing: null, runId: RUN_ID, normalizedAt: NOW });
    assert.equal(agentsDocument.contentCompleteness, "FULL");
    assert.ok(agentsDocument.urls.includes("https://example.com/claude-opus-5"));
  });

  test("checkpoint skips guids that were already seen but still counts them", async () => {
    const clock = new FakeClock(NOW);
    const http = new FakeHttp({ [RSS_FEED_URL]: textResponse(RSS_2_FEED_XML) });
    const { ctx } = makeContext(http, clock);
    const source = new RssSource(RSS_FEED);

    const checkpoint: SourceCheckpoint = {
      schemaVersion: 1,
      data: { lastSeenGuids: [RSS_ITEM_GUID], etag: null, lastModified: null },
    };
    const result = await source.collect(makeRequest(clock, { checkpoint }), ctx);

    assert.equal(result.status, "COMPLETE");
    assert.equal(result.coverage.itemsSeen, 3);
    assert.deepEqual(
      result.observations.map((observation) => observation.externalId),
      [RSS_EDGE_GUID],
    );
  });

  test("a second run over the same feed yields no observations", async () => {
    const clock = new FakeClock(NOW);
    const http = new FakeHttp({ [RSS_FEED_URL]: textResponse(RSS_2_FEED_XML) });
    const { ctx } = makeContext(http, clock);
    const source = new RssSource(RSS_FEED);

    const first = await source.collect(makeRequest(clock), ctx);
    assert.equal(first.observations.length, 2);

    const second = await source.collect(makeRequest(clock, { checkpoint: first.nextCheckpoint }), ctx);
    assert.equal(second.status, "COMPLETE");
    assert.equal(second.observations.length, 0);
    assert.equal(second.coverage.itemsSeen, 3);
  });

  test("sends conditional GET headers and treats 304 as no new items", async () => {
    const clock = new FakeClock(NOW);
    const http = new FakeHttp({ [RSS_FEED_URL]: { status: 304, headers: {}, text: "" } });
    const { ctx } = makeContext(http, clock);
    const source = new RssSource(RSS_FEED);

    const checkpoint: SourceCheckpoint = {
      schemaVersion: 1,
      data: { lastSeenGuids: [RSS_ITEM_GUID], etag: 'W/"v1"', lastModified: "Sat, 12 Sep 2026 06:30:00 GMT" },
    };
    const result = await source.collect(makeRequest(clock, { checkpoint }), ctx);

    assert.equal(http.requests[0]?.headers?.["if-none-match"], 'W/"v1"');
    assert.equal(http.requests[0]?.headers?.["if-modified-since"], "Sat, 12 Sep 2026 06:30:00 GMT");
    assert.equal(result.status, "COMPLETE");
    assert.equal(result.observations.length, 0);
    assert.deepEqual(result.nextCheckpoint, checkpoint);
  });

  test("maps http and parse failures", async () => {
    const clock = new FakeClock(NOW);
    const source = new RssSource(RSS_FEED);

    const serverError = await source.collect(
      makeRequest(clock),
      makeContext(new FakeHttp({ [RSS_FEED_URL]: { status: 503, headers: {}, text: "" } }), clock).ctx,
    );
    assert.equal(serverError.status, "FAILED");
    assert.equal(serverError.errors[0]?.kind, "NETWORK");
    assert.equal(serverError.errors[0]?.retryable, true);
    assert.equal(serverError.nextCheckpoint, null);

    const rateLimited = await source.collect(
      makeRequest(clock),
      makeContext(new FakeHttp({ [RSS_FEED_URL]: { status: 429, headers: {}, text: "" } }), clock).ctx,
    );
    assert.equal(rateLimited.errors[0]?.kind, "RATE_LIMIT");
    assert.equal(rateLimited.errors[0]?.retryable, true);

    const forbidden = await source.collect(
      makeRequest(clock),
      makeContext(new FakeHttp({ [RSS_FEED_URL]: { status: 403, headers: {}, text: "" } }), clock).ctx,
    );
    assert.equal(forbidden.errors[0]?.kind, "ACCESS");
    assert.equal(forbidden.errors[0]?.retryable, false);

    const garbage = await source.collect(
      makeRequest(clock),
      makeContext(new FakeHttp({ [RSS_FEED_URL]: textResponse("<html><body>nope</body></html>") }), clock).ctx,
    );
    assert.equal(garbage.status, "FAILED");
    assert.equal(garbage.errors[0]?.kind, "PARSE");
    assert.equal(garbage.errors[0]?.retryable, false);
  });

  test("maxItems truncates to PARTIAL", async () => {
    const clock = new FakeClock(NOW);
    const http = new FakeHttp({ [RSS_FEED_URL]: textResponse(RSS_2_FEED_XML) });
    const { ctx } = makeContext(http, clock);

    const result = await new RssSource(RSS_FEED).collect(makeRequest(clock, { maxItems: 1 }), ctx);
    assert.equal(result.status, "PARTIAL");
    assert.equal(result.coverage.truncationReason, "MAX_ITEMS");
    assert.equal(result.observations.length, 1);
  });
});

describe("createRssSources", () => {
  test("builds one adapter per feed", () => {
    const sources = createRssSources([RSS_FEED, ATOM_FEED]);
    assert.deepEqual(
      sources.map((source) => source.descriptor.id),
      ["rss:example-weekly", "rss:example-blog"],
    );
  });

  test("rejects duplicate feed ids", () => {
    assert.throws(() => createRssSources([RSS_FEED, RSS_FEED]), /duplicate rss feed id/);
  });
});
