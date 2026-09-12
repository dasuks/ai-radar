import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  normalizeKnowledgeTitle,
  runObsidianLibrarian,
  sanitizeKnowledgeFilename,
} from "../src/librarian/obsidian-librarian.js";
import type { BriefingTopic, DailyBriefing } from "../src/schemas/briefing.js";

const topic: BriefingTopic = {
  id: "verification-loop",
  title: "Verification Loop",
  type: "pattern",
  importance: 5,
  whatChanged: "검증 루프가 실무 패턴으로 자리 잡았다.",
  whyItMatters: "회귀를 빠르게 발견한다.",
  howDevelopersUseIt: "구현과 검토를 분리한다.",
  howToApply: "완료 조건에 테스트를 추가한다.",
  related: ["Harness Engineering", "Independent Review"],
  sources: [{ title: "Source", url: "https://example.com" }],
};

function briefing(overrides: Partial<DailyBriefing> = {}): DailyBriefing {
  return {
    date: "2026-09-12",
    title: "AI Coding Daily Brief",
    summary: ["핵심 요약"],
    topics: [topic],
    ...overrides,
  };
}

async function testVault() {
  const vaultRoot = await mkdtemp(join(tmpdir(), "librarian-vault-"));
  const dailyDirectory = join(vaultRoot, "99 Daily");
  await mkdir(dailyDirectory, { recursive: true });
  const dailyNotePath = join(
    dailyDirectory,
    "2026-09-12 AI Coding Daily Brief.md",
  );
  await writeFile(dailyNotePath, "# 2026-09-12 AI Coding Daily Brief\n", "utf8");
  return { vaultRoot, dailyNotePath };
}

test("type에 맞는 Knowledge Note를 만들고 Daily Note에 양방향 링크를 추가한다", async () => {
  const paths = await testVault();
  const result = await runObsidianLibrarian(briefing(), paths);
  const knowledgePath = join(paths.vaultRoot, "02 Patterns", "Verification Loop.md");
  const knowledge = await readFile(knowledgePath, "utf8");
  const daily = await readFile(paths.dailyNotePath, "utf8");

  assert.deepEqual(result.failures, []);
  assert.equal(result.created.length, 1);
  assert.match(knowledge, /## Summary/);
  assert.match(knowledge, /\[\[Harness Engineering\]\]/);
  assert.match(knowledge, /\[\[2026-09-12 AI Coding Daily Brief\]\]/);
  assert.match(daily, /## Knowledge Updates/);
  assert.match(daily, /\[\[Verification Loop\]\]/);
  assert.match(daily, /\[\[Independent Review\]\]/);
});

test("정규화된 기존 제목을 찾아 갱신하고 같은 날짜 Evidence를 하나만 유지한다", async () => {
  const paths = await testVault();
  const concepts = join(paths.vaultRoot, "01 Concepts");
  await mkdir(concepts, { recursive: true });
  const existingPath = join(concepts, "verification_loop.md");
  await writeFile(existingPath, "# verification-loop\n\n사용자 메모\n", "utf8");
  const normalizedTopic = { ...topic, title: " Verification   Loop ", type: "concept" };
  const input = briefing({ topics: [normalizedTopic] });

  await runObsidianLibrarian(input, paths);
  const second = await runObsidianLibrarian(input, paths);
  const contents = await readFile(existingPath, "utf8");

  assert.equal(second.updated.length, 1);
  assert.deepEqual(await readdir(concepts), ["verification_loop.md"]);
  assert.match(contents, /사용자 메모/);
  assert.equal(contents.match(/^### 2026-09-12$/gm)?.length, 1);
});

test("알 수 없는 type은 Inbox로 보내고 파일명 충돌 시 기존 파일을 보존한다", async () => {
  const paths = await testVault();
  const inbox = join(paths.vaultRoot, "00 Inbox");
  await mkdir(inbox, { recursive: true });
  await writeFile(join(inbox, "Agent Review.md"), "# Different Note\n", "utf8");
  const unsafeTopic = { ...topic, title: "Agent: Review?", type: "unknown" };

  await runObsidianLibrarian(briefing({ topics: [unsafeTopic] }), paths);

  assert.deepEqual((await readdir(inbox)).sort(), [
    "Agent Review (2).md",
    "Agent Review.md",
  ]);
});

test("제목 정규화와 Windows 파일명 sanitization을 적용한다", () => {
  assert.equal(
    normalizeKnowledgeTitle("  Verification__Loop--Pattern  "),
    "verification loop pattern",
  );
  assert.equal(sanitizeKnowledgeFilename('Agent: Review?*'), "Agent Review");
  assert.equal(sanitizeKnowledgeFilename("CON"), "_CON");
});
