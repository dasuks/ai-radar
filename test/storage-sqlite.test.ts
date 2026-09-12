import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrate, openSqliteStores } from "../src/adapters/storage/sqlite/index.js";
import { openDatabase } from "../src/adapters/storage/sqlite/driver.js";
import { describeStoreConformance, type StoreHarness } from "./helpers/store-conformance.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "ai-radar-sqlite-"));
}

async function openHarness(): Promise<StoreHarness> {
  const dir = await makeTempDir();
  const stores = openSqliteStores({ dir, rawPayloadRoot: dir });
  return {
    stores,
    rawPayloadRoot: dir,
    async cleanup(): Promise<void> {
      await stores.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describeStoreConformance("sqlite", openHarness);

test("sqlite: migrations are applied once and re-opening is a no-op", async () => {
  const dir = await makeTempDir();
  try {
    const first = openSqliteStores({ dir, rawPayloadRoot: dir });
    const applied = first.db.all("SELECT version, name FROM schema_migrations ORDER BY version");
    assert.equal(applied.length, 1);
    assert.equal(applied[0]?.["version"], 1);
    assert.equal(applied[0]?.["name"], "init");
    await first.close();

    // 같은 파일을 다시 열어도 migration 은 다시 적용되지 않는다.
    const second = openSqliteStores({ dir, rawPayloadRoot: dir });
    const again = second.db.all("SELECT version FROM schema_migrations");
    assert.equal(again.length, 1);
    // migrate() 를 직접 다시 불러도 no-op.
    const result = migrate(second.db, "2026-09-12T00:00:00.000Z");
    assert.deepEqual(result.applied, []);
    assert.equal(result.currentVersion, 1);
    await second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sqlite: foreign keys and WAL are enabled, DDL v1 tables exist", async () => {
  const dir = await makeTempDir();
  try {
    const stores = openSqliteStores({ dir, rawPayloadRoot: dir });
    const fk = stores.db.get("PRAGMA foreign_keys");
    assert.equal(fk?.["foreign_keys"], 1);
    const journal = stores.db.get("PRAGMA journal_mode");
    assert.equal(String(journal?.["journal_mode"]).toLowerCase(), "wal");

    const names = new Set(
      stores.db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => String(row["name"])),
    );
    for (const expected of [
      "schema_migrations",
      "runs",
      "run_events",
      "source_checkpoints",
      "raw_observations",
      "documents",
      "document_links",
      "entities",
      "entity_aliases",
      "entity_merges",
      "entity_mentions",
      "metric_observations",
      "derived_signals",
      "evidence",
      "analyses",
      "claims",
      "claim_evidence",
      "claim_entities",
      "classifications",
      "artifacts",
      "artifacts_current",
      "approvals",
      "publications",
      "feedback_events",
      "knowledge_proposals",
    ]) {
      assert.ok(names.has(expected), `missing table ${expected}`);
    }
    await stores.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sqlite: a failing transaction rolls back", async () => {
  const dir = await makeTempDir();
  try {
    const stores = openSqliteStores({ dir, rawPayloadRoot: dir });
    await assert.rejects(
      stores.unitOfWork.transaction(async () => {
        await stores.checkpoints.put("hackernews", { schemaVersion: 1, data: 1 }, "run_x", "2026-09-12T00:00:00.000Z");
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(await stores.checkpoints.get("hackernews"), null);
    await stores.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sqlite: migration bootstrap works on a bare in-memory database", () => {
  const db = openDatabase(":memory:");
  try {
    const result = migrate(db, "2026-09-12T00:00:00.000Z");
    assert.deepEqual(result.applied, [1]);
    assert.deepEqual(migrate(db, "2026-09-12T00:00:00.000Z").applied, []);
  } finally {
    db.close();
  }
});
