import assert from "node:assert/strict";
import test from "node:test";
import { runLibrarian, selectKnowledgeItems } from "../src/application/librarian/run-librarian.js";
import { normalizeKnowledgeTitle, sanitizeKnowledgeFilename } from "../src/application/librarian/titles.js";
import type { KnowledgeType } from "../src/domain/artifacts/daily-brief.js";
import { findRegion } from "../src/domain/shared/markers.js";
import { MemoryVault, silentLogger } from "./helpers/memory-vault.js";
import { briefItem, dailyBriefBody } from "./helpers/daily-brief-fixture.js";

const DAILY_PATH = "99 Daily/2026-09-12 AI Intelligence Daily.md";
const DAILY_NOTE = "# 2026-09-12 AI Intelligence Daily\n";

function run(vault: MemoryVault, body = dailyBriefBody(), maxNotesPerRun = 20) {
  return runLibrarian({
    body,
    vault,
    dailyNotePath: DAILY_PATH,
    maxNotesPerRun,
    dryRun: false,
    logger: silentLogger(),
  });
}

test("type 에 맞는 Knowledge Note 를 만들고 Daily Note 에 양방향 링크를 추가한다", async () => {
  const vault = new MemoryVault({ [DAILY_PATH]: DAILY_NOTE });
  const result = await run(vault);

  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.created, ["02 Patterns/Verification Loop.md"]);

  const knowledge = vault.files.get("02 Patterns/Verification Loop.md") ?? "";
  assert.match(knowledge, /## Summary/);
  assert.match(knowledge, /\[\[Harness Engineering\]\]/);
  assert.match(knowledge, /\[\[2026-09-12 AI Intelligence Daily\]\]/);
  assert.ok(findRegion(knowledge, "content"));
  assert.ok(findRegion(knowledge, "evidence:2026-09-12"));

  const daily = vault.files.get(DAILY_PATH) ?? "";
  assert.match(daily, /## Knowledge Updates/);
  assert.match(daily, /\[\[Verification Loop\]\]/);
  assert.match(daily, /\[\[Independent Review\]\]/);
  assert.ok(findRegion(daily, "knowledge-updates"));
});

test("정규화된 기존 제목을 찾아 갱신하고 같은 날짜 Evidence 를 하나만 유지하며 사용자 메모를 보존한다", async () => {
  const existingPath = "01 Concepts/verification_loop.md";
  const vault = new MemoryVault({
    [DAILY_PATH]: DAILY_NOTE,
    [existingPath]: "# verification-loop\n\n사용자 메모\n",
  });
  const body = dailyBriefBody({
    sections: [{ kind: "AI_CODING", items: [briefItem({ title: " Verification   Loop ", knowledgeType: "concept" })], report: null }],
  });

  await run(vault, body);
  const second = await run(vault, body);
  const contents = vault.files.get(existingPath) ?? "";

  assert.deepEqual(second.updated, [existingPath]);
  assert.deepEqual(second.created, []);
  assert.equal([...vault.files.keys()].filter((path) => path.startsWith("01 Concepts/")).length, 1);
  assert.match(contents, /사용자 메모/);
  assert.equal(contents.match(/^### 2026-09-12$/gm)?.length, 1);
  assert.equal(contents.match(/ai-radar:evidence:2026-09-12:start/g)?.length, 1);
});

test("매핑되지 않은 종류는 Inbox 로 보내고 파일명 충돌 시 기존 파일을 보존한다", async () => {
  const vault = new MemoryVault({
    [DAILY_PATH]: DAILY_NOTE,
    "00 Inbox/Agent Review.md": "# Different Note\n",
  });
  const body = dailyBriefBody({
    sections: [
      {
        kind: "AI_CODING",
        report: null,
        items: [briefItem({ title: "Agent: Review?", knowledgeType: "skill" as KnowledgeType, related: [] })],
      },
    ],
  });

  const result = await run(vault, body);

  assert.deepEqual(result.created, ["00 Inbox/Agent Review (2).md"]);
  assert.equal(vault.files.get("00 Inbox/Agent Review.md"), "# Different Note\n");
  // knowledgeType 이 없거나 중요도가 낮은 item 은 애초에 승격되지 않는다.
  assert.deepEqual(
    selectKnowledgeItems(
      dailyBriefBody({
        sections: [
          { kind: "AI_CODING", items: [briefItem({ knowledgeType: null }), briefItem({ id: "item_2", importance: 3 })], report: null },
        ],
      }),
    ),
    [],
  );
});

test("제목 정규화와 Windows 파일명 sanitization 을 적용한다", () => {
  assert.equal(normalizeKnowledgeTitle("  Verification__Loop--Pattern  "), "verification loop pattern");
  assert.equal(sanitizeKnowledgeFilename("Agent: Review?*"), "Agent Review");
  assert.equal(sanitizeKnowledgeFilename("CON"), "_CON");
});

test("레거시 ai-coding-radar 마커를 읽고 새 ai-radar 마커로 다시 쓴다", async () => {
  const existingPath = "02 Patterns/Verification Loop.md";
  const legacy = [
    "# Verification Loop",
    "",
    "<!-- ai-coding-radar:content:start -->",
    "## Summary",
    "예전 요약",
    "<!-- ai-coding-radar:content:end -->",
    "",
    "## Notes",
    "",
    "사용자가 쓴 메모",
    "",
    "## Evidence",
    "",
    "<!-- ai-coding-radar:evidence:2026-09-11:start -->",
    "### 2026-09-11",
    "<!-- ai-coding-radar:evidence:2026-09-11:end -->",
    "",
  ].join("\n");
  const vault = new MemoryVault({ [DAILY_PATH]: DAILY_NOTE, [existingPath]: legacy });

  const result = await run(vault);
  const contents = vault.files.get(existingPath) ?? "";

  assert.deepEqual(result.updated, [existingPath]);
  assert.equal(contents.includes("ai-coding-radar:content"), false);
  assert.equal(contents.match(/ai-radar:content:start/g)?.length, 1);
  assert.equal(contents.includes("예전 요약"), false);
  assert.match(contents, /사용자가 쓴 메모/);
  // 예전 날짜의 레거시 evidence 는 그대로 두고 오늘 날짜 블록만 추가한다.
  assert.match(contents, /ai-coding-radar:evidence:2026-09-11:start/);
  assert.match(contents, /ai-radar:evidence:2026-09-12:start/);
});
