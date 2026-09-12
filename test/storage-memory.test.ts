import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createMemoryStores } from "../src/adapters/storage/memory/index.js";
import { sanitizeSegment } from "../src/adapters/storage/fs/paths.js";
import { rawPayloadPath, writeRawPayload } from "../src/adapters/storage/fs/raw-payload.js";
import { describeStoreConformance, makeObservation, type StoreHarness } from "./helpers/store-conformance.js";

async function openHarness(): Promise<StoreHarness> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ai-radar-memory-"));
  const stores = createMemoryStores();
  return {
    stores,
    rawPayloadRoot: dir,
    async cleanup(): Promise<void> {
      await stores.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describeStoreConformance("memory", openHarness);

test("fs: raw payload path is sanitized and never overwritten", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ai-radar-fs-"));
  try {
    const observation = makeObservation({ sourceId: "rss:simonwillison", fetchedAt: "2026-09-11T12:05:00.000Z" });
    const target = rawPayloadPath(dir, observation);
    assert.ok(target.includes(`${path.sep}raw${path.sep}rss_simonwillison${path.sep}2026-09${path.sep}`));
    assert.ok(target.endsWith(`${observation.id}.json`));

    const first = await writeRawPayload(dir, observation, { a: 1 });
    assert.equal(first.created, true);
    const second = await writeRawPayload(dir, observation, { a: 2 });
    assert.equal(second.created, false);
    assert.equal(second.path, first.path);
    assert.equal(second.bytes, first.bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fs: sanitizeSegment removes traversal and reserved characters", () => {
  assert.equal(sanitizeSegment(".."), "_");
  assert.equal(sanitizeSegment("."), "_");
  assert.equal(sanitizeSegment(""), "_");
  assert.equal(sanitizeSegment("horizon:reddit"), "horizon_reddit");
  assert.equal(sanitizeSegment("a/b\\c"), "a_b_c");
  assert.equal(sanitizeSegment("2026-09-12"), "2026-09-12");
  assert.equal(sanitizeSegment("con"), "con_");
});
