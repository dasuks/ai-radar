import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runDailyPipeline, type DailyPipelineDeps } from "../src/application/runs/run-daily-pipeline.js";
import { JsonFileArtifactStore } from "../src/adapters/storage/json-files/artifact-store.js";
import { JsonFileRunStore } from "../src/adapters/storage/json-files/run-store.js";
import { MarkdownDailyRenderer } from "../src/adapters/rendering/markdown/daily-renderer.js";
import { ObsidianDailyPublisher } from "../src/adapters/obsidian/daily-publisher.js";
import { FixedClock } from "../src/adapters/system/clock.js";
import { JsonRunRecorder } from "../src/runtime/runs/run-recorder.js";
import type { DailyBriefBody } from "../src/domain/artifacts/daily-brief.js";
import type { Artifact } from "../src/domain/artifacts/artifact.js";
import type { PublishOutcome, Publisher, Rendered, Renderer } from "../src/ports/publishing/index.js";
import { MemoryVault, silentLogger } from "./helpers/memory-vault.js";

const DATE = "2026-09-12";
const WINDOW = { start: "2026-09-11T00:00:00.000Z", end: "2026-09-12T00:00:00.000Z" };
const DAILY_PATH = `99 Daily/${DATE} AI Intelligence Daily.md`;

const v1Brief = {
  date: DATE,
  title: "AI Intelligence Daily",
  summary: ["핵심 요약"],
  topics: [
    {
      id: "verification-loop",
      title: "Verification Loop",
      type: "pattern",
      importance: 5,
      whatChanged: "변경 내용",
      whyItMatters: "중요한 이유",
      howDevelopersUseIt: "사용 방법",
      howToApply: "적용 방법",
      related: ["Independent Review"],
      sources: [{ title: "Source", url: "https://example.com" }],
    },
  ],
};

function noopRenderer(channel: "notion"): Renderer<DailyBriefBody> {
  return {
    channel,
    render(artifact: Artifact<DailyBriefBody>): Rendered {
      return { channel, hash: `hash-${artifact.revision}`, payload: {}, preview: "" };
    },
  };
}

class ScriptedNotionPublisher implements Publisher {
  readonly channel = "notion" as const;
  calls = 0;
  constructor(private readonly fail: boolean) {}
  async publish(): Promise<PublishOutcome> {
    this.calls += 1;
    if (this.fail) throw new Error("notion is down");
    return { externalId: "page-1", externalUrl: null, action: "created" };
  }
}

async function buildDeps(options: { failNotion: boolean }): Promise<{
  deps: DailyPipelineDeps;
  vault: MemoryVault;
  notion: ScriptedNotionPublisher;
  inputPath: string;
}> {
  const storeDir = await mkdtemp(join(tmpdir(), "ai-radar-pipeline-"));
  const inputPath = join(storeDir, "daily-brief.json");
  await writeFile(inputPath, JSON.stringify(v1Brief), "utf8");

  const clock = new FixedClock(Date.UTC(2026, 8, 12, 3, 0, 0));
  const logger = silentLogger();
  const vault = new MemoryVault();
  const notion = new ScriptedNotionPublisher(options.failNotion);
  const artifactStore = new JsonFileArtifactStore(storeDir);
  const recorder = await JsonRunRecorder.start({
    store: new JsonFileRunStore(storeDir),
    clock,
    kind: "DAILY",
    window: WINDOW,
    timezone: "Asia/Seoul",
    stages: ["input", "publish:notion", "publish:obsidian", "librarian"],
  });

  const deps: DailyPipelineDeps = {
    clock,
    logger,
    artifactStore,
    recorder,
    readJson: async (path: string) => JSON.parse(await readFile(path, "utf8")) as unknown,
    source: { kind: "manual", filePath: inputPath },
    channels: [
      { channel: "notion", renderer: noopRenderer("notion"), publisher: notion },
      {
        channel: "obsidian",
        renderer: new MarkdownDailyRenderer(),
        publisher: new ObsidianDailyPublisher({ vault, dailyFolder: "99 Daily", logger }),
      },
    ],
    librarian: { vault, maxNotesPerRun: 20 },
  };
  return { deps, vault, notion, inputPath };
}

test("Notion 이 실패해도 Obsidian 과 Librarian 은 실행되고 Run 은 PARTIAL_SUCCESS 다", async () => {
  const { deps, vault, notion } = await buildDeps({ failNotion: true });

  const result = await runDailyPipeline(deps, { date: DATE, window: WINDOW, timezone: "Asia/Seoul", dryRun: false });

  assert.equal(notion.calls, 1);
  assert.equal(result.status, "PARTIAL_SUCCESS");
  assert.equal(result.context.publications.find((r) => r.channel === "notion")?.status, "FAILED");
  assert.equal(result.context.publications.find((r) => r.channel === "obsidian")?.status, "SUCCEEDED");
  assert.ok(vault.files.has(DAILY_PATH));
  assert.deepEqual(result.context.librarian?.created, ["02 Patterns/Verification Loop.md"]);
  assert.match(vault.files.get(DAILY_PATH) ?? "", /## Knowledge Updates/);
});

test("모든 채널이 성공하면 Run 은 SUCCESS 이고 Artifact revision 1 이 저장된다", async () => {
  const { deps } = await buildDeps({ failNotion: false });

  const result = await runDailyPipeline(deps, { date: DATE, window: WINDOW, timezone: "Asia/Seoul", dryRun: false });

  assert.equal(result.status, "SUCCESS");
  assert.equal(result.context.artifact?.id, `art_daily_brief_${DATE}`);
  assert.equal(result.context.artifact?.revision, 1);
  assert.equal(result.context.artifact?.visibility, "PRIVATE");
  assert.equal(result.context.errors.length, 0);
  assert.equal(result.context.publications.every((record) => record.status === "SUCCEEDED"), true);

  const head = await deps.artifactStore.head("DAILY_BRIEF", DATE);
  assert.deepEqual(head, { type: "DAILY_BRIEF", targetKey: DATE, revision: 1 });
});
