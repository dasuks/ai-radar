import test from "node:test";
import assert from "node:assert/strict";
import { discordStage, previewDiscordEdition, publishDiscordEdition } from "../src/application/discord/publish-discord-edition.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteStores } from "../src/adapters/storage/sqlite/index.js";
import { buildDailyStages, runDailyPipeline, type DailyPipelineDeps } from "../src/application/runs/run-daily-pipeline.js";
import { createMemoryStores } from "../src/adapters/storage/memory/index.js";
import { FakeLlmProvider } from "../src/adapters/llm/fake/index.js";
import { DiscordEditionRenderer } from "../src/adapters/rendering/discord/edition-renderer.js";
import { FixedClock } from "../src/adapters/system/clock.js";
import { JsonRunRecorder } from "../src/runtime/runs/run-recorder.js";
import type { Publisher } from "../src/ports/publishing/index.js";
import type { DiscordEditionBody } from "../src/domain/artifacts/discord-edition.js";
import { dailyArtifact } from "./helpers/daily-brief-fixture.js";
import { makeDocument } from "./helpers/store-conformance.js";
import { silentLogger } from "./helpers/memory-vault.js";

async function setup(manual = false, malformed = false) {
  const stores = createMemoryStores();
  const clock = new FixedClock(Date.UTC(2026, 8, 12));
  const logger = silentLogger();
  const brief = dailyArtifact();
  brief.inputs.claimIds = ["claim-public"];
  brief.inputs.rankingPolicies = [{ id: "ranking.practical", version: "2" }];
  const recorder = await JsonRunRecorder.start({ store: stores.runs, clock, kind: "DAILY", window: brief.window,
    timezone: brief.timezone, stages: ["input", "publish:discord", "after"] });
  const llm = new FakeLlmProvider({ WRITE_DISCORD: () => malformed ? null : ({
    bodySchemaVersion: 2, date: brief.body.date, posts: [{ id: brief.body.sections[0]!.items[0]!.id,
      sector: "coding", title: "검증 루프", summary: "검토 단계 소개", detail: "독립 검토 방법을 설명한다.",
      example: null, caveat: null, links: [{ label: "원문", url: "https://example.com" }] }],
  }) });
  let calls = 0;
  let after = false;
  const publisher: Publisher = { channel: "discord", async publish() { calls++; return { externalId: "journal", externalUrl: null, action: "created" }; } };
  const deps: DailyPipelineDeps = { clock, logger, artifactStore: stores.artifacts, recorder,
    readJson: async () => brief.body, source: manual ? { kind: "manual", filePath: "private-input" } : { kind: "auto", build: async () => brief },
    channels: [], librarian: null };
  const stage = discordStage({ pipeline: deps, stores, llm, model: "test", clock, logger, publisher, renderer: new DiscordEditionRenderer() });
  const run = (dryRun = false) => runDailyPipeline(deps, { date: brief.body.date, window: brief.window, timezone: brief.timezone, dryRun,
    stages: [...buildDailyStages(deps), stage, { name: "after", enabled: () => true, async run() { after = true; } }] });
  return { run, stores, llm, brief, get calls() { return calls; }, get after() { return after; } };
}

test("Discord pipeline persists provenance and caches edition on repeat source", async () => {
  const fixture = await setup();
  assert.equal((await fixture.run()).status, "SUCCESS");
  const edition = await fixture.stores.artifacts.get<DiscordEditionBody>("DISCORD_EDITION", fixture.brief.body.date, 1);
  assert.ok(edition);
  assert.deepEqual(edition.inputs.claimIds, fixture.brief.inputs.claimIds);
  assert.deepEqual(edition.inputs.documentIds, fixture.brief.inputs.documentIds);
  assert.deepEqual(edition.inputs.signalRefs, fixture.brief.inputs.signalRefs);
  assert.deepEqual(edition.inputs.rankingPolicies[0], fixture.brief.inputs.rankingPolicies[0]);
  assert.equal((await fixture.run()).status, "SUCCESS");
  assert.equal(fixture.llm.callCount, 1);
  assert.equal(fixture.calls, 1);
  assert.equal((await fixture.stores.runs.latestByKind("DAILY"))?.llmUsage.length, 1);
});

test("changed stored evidence invalidates editorial cache without touching an old Discord message", async () => {
  const fixture = await setup();
  const source = fixture.brief.body.sections[0]!.items[0]!.sourceRefs[0]!;
  const doc = makeDocument({ id: source.documentId, sourceId: source.sourceId, canonicalUrl: source.url,
    urls: [source.url], content: "First original explanation" });
  await fixture.stores.documents.upsert(doc);
  await fixture.run();
  assert.equal(fixture.llm.callCount, 1);
  await fixture.stores.documents.upsert({ ...doc, content: "Updated original explanation" });
  await fixture.run();
  assert.equal(fixture.llm.callCount, 2);
  assert.equal(fixture.calls, 1);
});

test("legacy manual input never enters automatic Discord curation or delivery", async () => {
  const fixture = await setup(true);
  await fixture.run();
  assert.equal(fixture.llm.callCount, 0);
  assert.equal(fixture.calls, 0);
  assert.equal(await fixture.stores.artifacts.head("DISCORD_EDITION", fixture.brief.body.date), null);
});

test("Discord curation failure is recorded and later stages still run", async () => {
  const fixture = await setup(false, true);
  const result = await fixture.run();
  assert.equal(result.context.publications.find((record) => record.channel === "discord")?.status, "FAILED");
  assert.ok(result.context.errors.some((error) => error.stage === "publish:discord"));
  assert.equal(fixture.calls, 0);
  assert.equal(fixture.after, true);
  assert.notEqual(result.status, "SUCCESS");
});

test("Discord dry run does not persist edition, approval or publication", async () => {
  const fixture = await setup();
  await fixture.run(true);
  assert.equal(await fixture.stores.artifacts.head("DISCORD_EDITION", fixture.brief.body.date), null);
  assert.equal(fixture.stores.artifacts.approvals.size, 0);
  assert.equal(fixture.stores.artifacts.publications.size, 0);
});

test("standalone preview works without destinations, stores or publisher", () => {
  assert.equal(previewDiscordEdition({ bodySchemaVersion: 1, date: "2026-09-12", posts: [] }, new DiscordEditionRenderer(),
    new FixedClock(Date.UTC(2026, 8, 12)), "Asia/Seoul"), "");
});

test("standalone publication with recorded PUBLISH_ONLY run satisfies SQLite foreign keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "discord-publication-"));
  const stores = openSqliteStores({ dir, rawPayloadRoot: dir });
  const clock = new FixedClock(Date.UTC(2026, 8, 12));
  const window = { start: clock.nowIso(), end: clock.nowIso() };
  try {
    const recorder = await JsonRunRecorder.start({ store: stores.runs, clock, kind: "PUBLISH_ONLY", window, timezone: "Asia/Seoul", stages: ["publish:discord"] });
    const result = await publishDiscordEdition({ body: { bodySchemaVersion: 1, date: "2026-09-12", posts: [] }, stores, clock,
      renderer: new DiscordEditionRenderer(), logger: silentLogger(), runId: recorder.runId, dryRun: false, timezone: "Asia/Seoul", window,
      publisher: { channel: "discord", async publish() { return { externalId: "journal", externalUrl: null, action: "created" }; } } });
    assert.equal(result.status, "SUCCEEDED");
    await recorder.finish("SUCCESS");
    assert.equal((await stores.runs.get(recorder.runId))?.status, "SUCCESS");
    assert.equal((await stores.artifacts.latestPublication(result.artifactId, "discord"))?.runId, recorder.runId);
  } finally { stores.close(); }
});
