import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { MarkdownDailyRenderer } from "../src/adapters/rendering/markdown/daily-renderer.js";
import { dailyArtifact, dailyBriefBody } from "./helpers/daily-brief-fixture.js";

test("Daily Note 본문을 섹션 구조로 렌더하고 hash 를 계산한다", () => {
  const artifact = dailyArtifact();
  const rendered = new MarkdownDailyRenderer().render(artifact);
  const payload = rendered.payload as { markdown: string; date: string; title: string };

  assert.equal(rendered.channel, "obsidian");
  assert.equal(payload.date, "2026-09-12");
  assert.equal(payload.title, "AI Intelligence Daily");
  assert.equal(rendered.hash, createHash("sha256").update(payload.markdown, "utf8").digest("hex"));

  const markdown = payload.markdown;
  assert.match(markdown, /^# 2026-09-12 AI Intelligence Daily/m);
  assert.match(markdown, /^## 오늘 1분 요약$/m);
  assert.match(markdown, /^## AI Coding$/m);
  assert.match(markdown, /^### Verification Loop$/m);
  assert.match(markdown, /\*\*중요도:\*\* 5\/5/);
  assert.match(markdown, /#### 무엇이 바뀌었나/);
  assert.match(markdown, /\[\[Independent Review\]\]/);
  assert.match(markdown, /\[Source\]\(https:\/\/example\.com\)/);
  assert.match(markdown, /^## 오늘 하나만 배운다면$/m);
  assert.match(markdown, /^## 내 환경에 적용할 후보$/m);
  assert.match(markdown, /^## Sources$/m);
  assert.equal(/수집 실패/.test(markdown), false);
});

test("수집 실패가 있으면 coverage 줄을 표시한다", () => {
  const body = dailyBriefBody({
    coverage: { sourcesAttempted: ["hackernews", "rss:latent-space"], sourcesFailed: ["rss:latent-space"], partial: true, note: null },
  });
  const rendered = new MarkdownDailyRenderer().render(dailyArtifact(body));
  const markdown = (rendered.payload as { markdown: string }).markdown;

  assert.match(markdown, /^> 수집 실패: rss:latent-space$/m);
});
