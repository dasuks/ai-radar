import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatDailyMarkdown } from "../src/formatters/daily-markdown.js";
import { loadBriefing } from "../src/loaders/briefing-loader.js";
import { BriefingValidationError, parseBriefing } from "../src/schemas/briefing.js";
import { writeObsidianDailyNote } from "../src/writers/obsidian-writer.js";

const validBriefing = {
  date: "2026-09-12",
  title: "AI Coding Daily Brief",
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

test("정상 JSON을 검증하고 Markdown으로 변환한다", () => {
  const briefing = parseBriefing(validBriefing);
  const markdown = formatDailyMarkdown(briefing);

  assert.match(markdown, /^# 2026-09-12 AI Coding Daily Brief/m);
  assert.match(markdown, /\*\*중요도:\*\* 5\/5/);
  assert.match(markdown, /\[\[Independent Review\]\]/);
  assert.match(markdown, /\[Source\]\(https:\/\/example\.com\)/);
});

test("topics가 없으면 기본 안내를 출력한다", () => {
  const briefing = parseBriefing({ date: "2026-09-12", topics: [] });
  assert.equal(briefing.title, "AI Coding Daily Brief");
  assert.deepEqual(briefing.summary, []);
  assert.match(formatDailyMarkdown(briefing), /오늘 등록된 주제가 없습니다\./);
});

test("malformed JSON이면 파일 경로가 포함된 명확한 오류를 낸다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "briefing-loader-"));
  const inputPath = join(directory, "daily-brief.json");
  await writeFile(inputPath, '{ "date": ', "utf8");

  await assert.rejects(
    loadBriefing(inputPath),
    /Daily Brief contains malformed JSON.*daily-brief\.json/,
  );
});

test("실제로 존재하지 않는 날짜를 거부한다", () => {
  assert.throws(
    () => parseBriefing({ date: "2026-02-30" }),
    (error: unknown) =>
      error instanceof BriefingValidationError &&
      error.message.includes("root.date must be a valid date"),
  );
});

test("기존 Daily Note를 별도 백업 없이 같은 경로에 갱신한다", async () => {
  const vaultRoot = await mkdtemp(join(tmpdir(), "briefing-vault-"));
  const dailyDirectory = join(vaultRoot, "99 Daily");
  const briefing = parseBriefing(validBriefing);
  const first = await writeObsidianDailyNote(briefing, "old", {
    vaultRoot,
    dailyDirectory,
  });
  const second = await writeObsidianDailyNote(briefing, "new", {
    vaultRoot,
    dailyDirectory,
  });

  assert.equal(second.outputPath, first.outputPath);
  assert.equal(await readFile(first.outputPath, "utf8"), "new");
  assert.deepEqual(await readdir(dailyDirectory), [
    "2026-09-12 AI Coding Daily Brief.md",
  ]);
});
