import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isV1Briefing,
  parseDailyBriefingV1,
  upcastV1ToDailyBriefBody,
} from "../src/domain/artifacts/daily-brief-v1.js";
import { artifactId } from "../src/domain/shared/ids.js";
import { ContractValidationError } from "../src/domain/shared/validation.js";
import { readJsonFile } from "../src/adapters/storage/json-files/json-file.js";

const v1Input = {
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

test("v1 Daily Brief 를 검증하고 DailyBriefBody v2 로 upcast 한다", () => {
  assert.equal(isV1Briefing(v1Input), true);
  const v1 = parseDailyBriefingV1(v1Input);
  const body = upcastV1ToDailyBriefBody(v1, artifactId("DAILY_BRIEF", v1.date));

  assert.equal(body.bodySchemaVersion, 2);
  assert.equal(body.date, "2026-09-12");
  assert.deepEqual(body.oneMinuteSummary, ["핵심 요약"]);
  assert.equal(body.sections.length, 1);
  assert.equal(body.sections[0]?.kind, "AI_CODING");

  const item = body.sections[0]?.items[0];
  assert.ok(item);
  assert.match(item.id, /^item_[0-9a-f]{16}$/);
  assert.equal(item.knowledgeType, "pattern");
  assert.equal(item.importance, 5);
  assert.equal(item.rankingTrace.policyId, "manual");
  assert.deepEqual(item.claimIds, []);
  assert.match(item.sourceRefs[0]?.documentId ?? "", /^doc_[0-9a-f]{24}$/);
  assert.equal(item.sourceRefs[0]?.sourceId, "manual-json");

  assert.equal(body.learnOneThing?.id, item.id);
  assert.equal(body.applyCandidates.length, 1);
  assert.deepEqual(body.coverage, {
    sourcesAttempted: ["manual-json"],
    sourcesFailed: [],
    partial: false,
    note: null,
  });
});

test("실제로 존재하지 않는 날짜를 거부한다", () => {
  assert.throws(
    () => parseDailyBriefingV1({ date: "2026-02-30", topics: [] }),
    (error: unknown) =>
      error instanceof ContractValidationError &&
      error.message.includes("root.date must be a valid date"),
  );
});

test("malformed JSON 이면 파일 경로가 포함된 명확한 오류를 낸다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-radar-input-"));
  const inputPath = join(directory, "daily-brief.json");
  await writeFile(inputPath, '{ "date": ', "utf8");

  await assert.rejects(
    readJsonFile(inputPath),
    /Daily Brief contains malformed JSON.*daily-brief\.json/,
  );
});
