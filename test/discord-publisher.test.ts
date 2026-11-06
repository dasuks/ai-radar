import assert from "node:assert/strict";
import { test } from "node:test";
import { DiscordPublisher, DiscordDeliveryError, type DiscordPublisherOptions } from "../src/adapters/discord/publisher.js";
import { createMemoryStores } from "../src/adapters/storage/memory/index.js";
import type { DiscordChannelKey, DiscordDeliveryPayload } from "../src/domain/artifacts/discord-edition.js";
import type { HttpRequest, HttpResponse } from "../src/ports/system/index.js";

const channels: DiscordChannelKey[] = ["models", "coding", "agents", "products", "infra", "evals", "culture", "summary"];
const routes = Object.fromEntries(channels.map((channel, index) => [channel, { channelId: String(100 + index), webhookUrl: `https://discord.com/api/webhooks/${200 + index}/secret-token` }])) as DiscordPublisherOptions["routes"];
const post = (key: string, channel: DiscordDeliveryPayload["posts"][number]["channel"] = "models") => ({ key, channel, title: `Title ${key}`, summary: `Summary ${key}`, content: `Detail ${key}` });
function setup() {
  const stores = createMemoryStores();
  const requests: HttpRequest[] = [];
  const sleeps: number[] = [];
  let nextId = 1000;
  let handler: ((request: HttpRequest) => HttpResponse | undefined) | undefined;
  const options: DiscordPublisherOptions = {
    guildId: "99", routes, checkpoints: stores.checkpoints,
    clock: { nowMs: () => 0, nowIso: () => "2026-10-05T00:00:00.000Z" },
    sleep: async (ms) => { sleeps.push(ms); },
    http: { async request(request) {
      requests.push(request);
      const override = handler?.(request);
      if (override) return override;
      const index = Number(new URL(request.url).pathname.split("/")[3]) - 200;
      const channelId = String(100 + index);
      return { status: 200, headers: {}, text: JSON.stringify(request.method === "GET" ? { guild_id: "99", channel_id: channelId } : {
        id: request.method === "PATCH" ? request.url.split("/").at(-1) : String(nextId++), channel_id: channelId,
      }) };
    } },
  };
  const input = (posts: DiscordDeliveryPayload["posts"], revision = 1, dryRun = false) => ({ artifactId: "artifact", revision,
    existingExternalId: null, dryRun, rendered: { channel: "discord" as const, hash: "hash", preview: "preview", payload: { date: "2026-10-05", posts } } });
  return { options, stores, requests, sleeps, input, publisher: () => new DiscordPublisher(options), intercept: (fn: typeof handler) => { handler = fn; } };
}
const response = (status: number, body: unknown = {}) => ({ status, headers: {}, text: JSON.stringify(body) });
const writes = (requests: HttpRequest[]) => requests.filter((request) => request.method !== "GET");

test("Discord dry run performs no network or journal write; invalid content rejects before writes", async () => {
  const s = setup();
  assert.equal((await s.publisher().publish(s.input([post("one")], 1, true))).action, "skipped");
  assert.equal(s.requests.length, 0);
  assert.equal(await s.stores.checkpoints.get("discord:99:2026-10-05"), null);
  await assert.rejects(s.publisher().publish(s.input([{ ...post("bad"), content: "x".repeat(2001) }])));
  assert.equal(s.requests.length, 0);
});

test("Discord verifies all bindings, routes all sectors and suppresses mentions", async () => {
  const s = setup();
  const posts = channels.filter((channel) => channel !== "summary").map((channel) => post(channel, channel));
  const result = await s.publisher().publish(s.input(posts));
  assert.equal(result.externalId, "discord:99:2026-10-05");
  assert.match(result.externalUrl!, /^https:\/\/discord.com\/channels\/99\/107\/\d+$/);
  assert.ok(s.requests.slice(0, 8).every((request) => request.method === "GET"));
  const sent = writes(s.requests);
  assert.equal(sent.length, 8);
  for (const request of sent) {
    const body = JSON.parse(request.body!);
    assert.deepEqual(body.allowed_mentions, { parse: [] });
    assert.ok(body.content.length <= 2000);
    assert.ok(request.url.endsWith("?wait=true"));
  }
  const summary = JSON.parse(sent.at(-1)!.body!).content;
  for (let index = 0; index < 7; index++) assert.ok(summary.includes(`/99/${100 + index}/${1000 + index}`));
  s.requests.length = 0;
  assert.equal((await s.publisher().publish(s.input(posts))).action, "skipped");
  assert.equal(writes(s.requests).length, 0);
});

test("Discord persists partial successes, summarizes them, retries only rejected posts and retains omitted successes", async () => {
  const s = setup();
  s.intercept((request) => request.method === "POST" && request.body?.includes("Detail fail") ? response(400) : undefined);
  await assert.rejects(s.publisher().publish(s.input([post("ok"), post("fail")])), (error: unknown) => error instanceof DiscordDeliveryError && error.deliveredCount === 1);
  assert.ok(JSON.parse(writes(s.requests).at(-1)!.body!).content.includes("Title ok"));
  s.requests.length = 0;
  s.intercept(undefined);
  await s.publisher().publish(s.input([post("fail")]));
  assert.equal(writes(s.requests).filter((request) => request.method === "POST").length, 1);
  const summary = JSON.parse(writes(s.requests).at(-1)!.body!).content;
  assert.ok(summary.includes("Title ok") && summary.includes("Title fail"));
  assert.equal(writes(s.requests).at(-1)!.method, "PATCH");
});

for (const failure of ["timeout", "server", "malformed"] as const) {
  test(`Discord ambiguous ${failure} POST is never duplicated across publisher restarts`, async () => {
    const s = setup();
    let checkedIntent = false;
    s.intercept((request) => {
      if (request.method !== "POST") return;
      // Memory store exposes committed rows; intent is durable before transport starts.
      checkedIntent = s.stores.checkpoints.byId.has("discord:99:2026-10-05");
      if (failure === "timeout") throw new Error("secret-token https://discord.com/api/webhooks/200/secret-token");
      return failure === "server" ? response(503) : response(200, { id: "1000" });
    });
    await assert.rejects(s.publisher().publish(s.input([post("one")])), (error: unknown) => error instanceof Error && !error.message.includes("secret-token"));
    assert.ok(checkedIntent);
    s.requests.length = 0;
    s.intercept(undefined);
    await assert.rejects(s.publisher().publish(s.input([post("one")])));
    assert.equal(writes(s.requests).length, 0);
  });
}

test("Discord safe edits retain IDs, show revisions and remain retryable after timeout", async () => {
  const s = setup();
  await s.publisher().publish(s.input([post("one")]));
  s.requests.length = 0;
  s.intercept((request) => { if (request.method === "PATCH") throw new Error("secret-token"); return undefined; });
  const changed = { ...post("one"), content: "Changed\n2026-10-05 · 수정 2" };
  await assert.rejects(s.publisher().publish(s.input([changed], 2)));
  s.requests.length = 0;
  s.intercept(undefined);
  await s.publisher().publish(s.input([changed], 2));
  assert.ok(writes(s.requests).every((request) => request.method === "PATCH"));
  assert.equal(JSON.parse(writes(s.requests)[0]!.body!).content, changed.content);
  assert.ok(writes(s.requests)[0]!.url.endsWith("/messages/1000"));
});

test("Discord definite 429 respects bounded retry_after seconds", async () => {
  const s = setup();
  let attempts = 0;
  s.intercept((request) => request.method === "POST" && attempts++ === 0 ? response(429, { retry_after: 0.25 }) : undefined);
  await s.publisher().publish(s.input([post("one")]));
  assert.deepEqual(s.sleeps, [250]);
  const other = setup();
  other.intercept((request) => request.method === "POST" ? response(429, { retry_after: 99 }) : undefined);
  await assert.rejects(other.publisher().publish(other.input([post("one")])));
  assert.equal(other.sleeps.length, 0);
  other.intercept(undefined);
  await other.publisher().publish(other.input([post("one")]));
});

test("Discord rejects mismatched destinations and arbitrary URLs before sends", async () => {
  const s = setup();
  s.intercept(() => response(200, { guild_id: "wrong", channel_id: "100" }));
  await assert.rejects(s.publisher().publish(s.input([post("one")])));
  assert.equal(writes(s.requests).length, 0);
  const other = setup();
  const publisher = new DiscordPublisher({ ...other.options, routes: { ...routes, models: { ...routes.models, webhookUrl: "https://evil.example/api/webhooks/200/secret-token" } } });
  await assert.rejects(publisher.publish(other.input([post("one")])));
  assert.equal(other.requests.length, 0);
});

test("Discord all-item summaries split within limits and retain page IDs on rerun", async () => {
  const s = setup();
  const posts = Array.from({ length: 30 }, (_, index) => ({ ...post(String(index)), summary: "설명".repeat(80) }));
  await s.publisher().publish(s.input(posts));
  const summaries = writes(s.requests).filter((request) => request.url.includes("/207/"));
  assert.ok(summaries.length > 1);
  const combined = summaries.map((request) => JSON.parse(request.body!).content).join("\n");
  for (let index = 0; index < 30; index++) assert.ok(combined.includes(`/99/100/${1000 + index}`));
  assert.ok(summaries.every((request) => JSON.parse(request.body!).content.length <= 2000));
  s.requests.length = 0;
  await s.publisher().publish(s.input(posts.map((item) => ({ ...item, summary: "New" }))));
  const edits = writes(s.requests).filter((request) => request.url.includes("/207/"));
  assert.ok(edits.length > 0 && edits.every((request) => request.method === "PATCH"));
});

test("Discord existing post cannot change channel and failed edit retains its prior successful summary", async () => {
  const s = setup();
  await s.publisher().publish(s.input([post("one")]));
  s.requests.length = 0;
  await assert.rejects(s.publisher().publish(s.input([post("one", "coding")])));
  assert.equal(writes(s.requests).length, 0);
  s.intercept((request) => request.method === "PATCH" && request.url.includes("/200/") ? response(400) : undefined);
  await assert.rejects(s.publisher().publish(s.input([{ ...post("one"), title: "Unpublished replacement", content: "New" }, post("two")], 2)));
  const summary = JSON.parse(writes(s.requests).at(-1)!.body!).content;
  assert.ok(summary.includes("Title one") && summary.includes("Title two"));
  assert.ok(!summary.includes("Unpublished replacement"));
});

test("Discord ambiguous summary POST is held while delivered details remain durable", async () => {
  const s = setup();
  s.intercept((request) => request.method === "POST" && request.url.includes("/207/") ? response(502) : undefined);
  await assert.rejects(s.publisher().publish(s.input([post("one")])));
  s.requests.length = 0;
  s.intercept(undefined);
  await assert.rejects(s.publisher().publish(s.input([post("one")])));
  assert.equal(writes(s.requests).length, 0);
});

test("Discord persistent rate limits stop after three attempts and remain retryable", async () => {
  const s = setup();
  s.intercept((request) => request.method === "POST" ? response(429, { retry_after: 0 }) : undefined);
  await assert.rejects(s.publisher().publish(s.input([post("one")])));
  assert.equal(writes(s.requests).length, 3);
  assert.deepEqual(s.sleeps, [0, 0]);
  s.intercept(undefined);
  await s.publisher().publish(s.input([post("one")]));
});
