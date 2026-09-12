import assert from "node:assert/strict";
import test from "node:test";
import { ObsidianDailyPublisher } from "../src/adapters/obsidian/daily-publisher.js";
import { MarkdownDailyRenderer } from "../src/adapters/rendering/markdown/daily-renderer.js";
import { findRegion } from "../src/domain/shared/markers.js";
import { MemoryVault, silentLogger } from "./helpers/memory-vault.js";
import { dailyArtifact } from "./helpers/daily-brief-fixture.js";

const DAILY_FOLDER = "99 Daily";

function publisher(vault: MemoryVault): ObsidianDailyPublisher {
  return new ObsidianDailyPublisher({ vault, dailyFolder: DAILY_FOLDER, logger: silentLogger() });
}

async function publish(vault: MemoryVault, existingExternalId: string | null = null) {
  const artifact = dailyArtifact();
  const rendered = new MarkdownDailyRenderer().render(artifact);
  return publisher(vault).publish({
    artifactId: artifact.id,
    revision: artifact.revision,
    rendered,
    existingExternalId,
    dryRun: false,
  });
}

test("노트가 없으면 <date> <title>.md 를 만들고 관리 영역으로 감싼다", async () => {
  const vault = new MemoryVault();
  const outcome = await publish(vault);

  assert.equal(outcome.action, "created");
  assert.equal(outcome.externalId, "99 Daily/2026-09-12 AI Intelligence Daily.md");

  const contents = vault.files.get(outcome.externalId!) ?? "";
  assert.match(contents, /^# 2026-09-12 AI Intelligence Daily\n/);
  const region = findRegion(contents, "daily");
  assert.ok(region);
  assert.equal(region.legacy, false);
  assert.match(region.inner, /## 오늘 1분 요약/);
  // 렌더된 H1 은 노트의 H1 과 중복되지 않는다.
  assert.equal(contents.match(/^# /gm)?.length, 1);
});

test("마커가 없는 레거시 Daily Note 는 본문만 교체하고 Knowledge Updates 를 보존한다", async () => {
  const legacy = [
    "# 2026-09-12 AI Coding Daily Brief",
    "",
    "## 오늘 이것만 알면 됨",
    "",
    "- 예전 요약",
    "",
    "## Verification Loop",
    "",
    "예전 본문",
    "",
    "## Knowledge Updates",
    "",
    "<!-- ai-coding-radar:knowledge-updates:start -->",
    "- [[Verification Loop]]",
    "<!-- ai-coding-radar:knowledge-updates:end -->",
    "",
  ].join("\n");
  const path = "99 Daily/2026-09-12 AI Coding Daily Brief.md";
  const vault = new MemoryVault({ [path]: legacy });

  const outcome = await publish(vault);

  assert.equal(outcome.action, "updated");
  assert.equal(outcome.externalId, path);
  const contents = vault.files.get(path) ?? "";
  assert.match(contents, /^# 2026-09-12 AI Coding Daily Brief/);
  assert.equal(contents.includes("예전 본문"), false);
  assert.equal(contents.includes("## 오늘 이것만 알면 됨"), false);
  assert.match(contents, /## Knowledge Updates/);
  assert.match(contents, /ai-coding-radar:knowledge-updates:start/);
  assert.ok(findRegion(contents, "daily"));
});

test("관리 영역 밖 사용자 메모는 재실행해도 남는다", async () => {
  const vault = new MemoryVault();
  const first = await publish(vault);
  const path = first.externalId!;

  vault.files.set(path, `${vault.files.get(path)}\n\n## 내 메모\n\n직접 쓴 문장\n`);
  const second = await publish(vault, path);

  assert.equal(second.action, "updated");
  const contents = vault.files.get(path) ?? "";
  assert.match(contents, /## 내 메모/);
  assert.match(contents, /직접 쓴 문장/);
  assert.equal(contents.match(/ai-radar:daily:start/g)?.length, 1);
  assert.equal(vault.files.size, 1);
});
