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
  assert.match(markdown, /#### 왜 중요한가/);
  assert.match(markdown, /\[Source\]\(https:\/\/example\.com\)/);
  assert.match(markdown, /^## 오늘 하나만 배운다면$/m);
  assert.match(markdown, /^## 내 환경에 적용할 후보$/m);
  assert.match(markdown, /^## Sources$/m);
  assert.equal(/수집 실패/.test(markdown), false);
});

test("리포트로 옮긴 절은 Daily Note 에 남기지 않는다", () => {
  const markdown = (new MarkdownDailyRenderer().render(dailyArtifact()).payload as { markdown: string }).markdown;

  assert.equal(/실제 개발자들은/.test(markdown), false);
  assert.equal(/바로 적용하려면/.test(markdown), false);
  assert.equal(/관련 개념/.test(markdown), false);
  assert.equal(/\[\[Independent Review\]\]/.test(markdown), false);
});

test("섹션 리포트·전체 목록 URL 이 있을 때만 링크 줄을 넣는다", () => {
  const plain = (new MarkdownDailyRenderer().render(dailyArtifact()).payload as { markdown: string }).markdown;
  assert.equal(/상세 리포트/.test(plain), false);
  assert.equal(/전체 목록/.test(plain), false);

  const base = dailyBriefBody();
  const linked = dailyBriefBody({
    sections: base.sections.map((section) => ({
      ...section,
      report: { artifactId: "art_section_report_2026-09-12:AI_CODING", externalUrl: "https://www.notion.so/report" },
    })),
    digest: { artifactId: "art_daily_digest_2026-09-12", externalUrl: "https://www.notion.so/digest" },
  });
  const markdown = (new MarkdownDailyRenderer().render(dailyArtifact(linked)).payload as { markdown: string }).markdown;

  assert.match(markdown, /^\[상세 리포트 →\]\(https:\/\/www\.notion\.so\/report\)$/m);
  assert.match(markdown, /^\[오늘 들어온 이야기 전체 목록 →\]\(https:\/\/www\.notion\.so\/digest\)$/m);
  // 전체 목록 링크는 Sources 바로 앞에 온다
  assert.ok(markdown.indexOf("전체 목록 →") < markdown.indexOf("\n## Sources"));
});

test("수집 실패가 있으면 coverage 줄을 표시한다", () => {
  const body = dailyBriefBody({
    coverage: { sourcesAttempted: ["hackernews", "rss:latent-space"], sourcesFailed: ["rss:latent-space"], partial: true, note: null },
  });
  const rendered = new MarkdownDailyRenderer().render(dailyArtifact(body));
  const markdown = (rendered.payload as { markdown: string }).markdown;

  assert.match(markdown, /^> 수집 실패: rss:latent-space$/m);
});
