import assert from "node:assert/strict";
import test from "node:test";
import {
  RICH_TEXT_LIMIT,
  bookmarkBlock,
  linkParagraph,
  linkedListItem,
  revisionCallout,
  safeLinkUrl,
  splitText,
  textBlocks,
  titleRichText,
  truncateWithoutBreakingSurrogate,
} from "../src/adapters/rendering/notion-blocks/blocks.js";
import { NotionBlocksRenderer } from "../src/adapters/rendering/notion-blocks/daily-renderer.js";
import { dailyArtifact, dailyBriefBody } from "./helpers/daily-brief-fixture.js";

/** 블록 트리 안의 모든 rich text content 길이 */
export function contentLengths(value: unknown): number[] {
  if (typeof value === "string") return [];
  if (Array.isArray(value)) return value.flatMap(contentLengths);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const own = typeof record.content === "string" ? [record.content.length] : [];
  return own.concat(Object.values(record).flatMap(contentLengths));
}

function blockTypes(blocks: readonly unknown[]): string[] {
  return blocks.map((block) => String((block as { type?: unknown }).type));
}

// ---------------------------------------------------------------------------
// 공용 헬퍼 (blocks.ts)
// ---------------------------------------------------------------------------

test("splitText 는 2000자로 나누고 surrogate pair 를 쪼개지 않는다", () => {
  const chunks = splitText("가".repeat(5_000));
  assert.deepEqual(chunks.map((chunk) => chunk.length), [2_000, 2_000, 1_000]);

  // "\u{1F600}" 는 code unit 2개. limit 경계에서 잘리면 안 된다.
  const emoji = "a".repeat(RICH_TEXT_LIMIT - 1) + "\u{1F600}" + "b";
  const emojiChunks = splitText(emoji);
  assert.equal(emojiChunks[0]?.length, RICH_TEXT_LIMIT - 1);
  assert.equal(emojiChunks[1]?.startsWith("\u{1F600}"), true);
  assert.equal(emojiChunks.join(""), emoji);
});

test("splitText 는 빈 문자열을 대체 문구로 바꾼다", () => {
  assert.deepEqual(splitText(""), ["내용 없음"]);
});

test("truncateWithoutBreakingSurrogate 는 경계에서 한 글자 앞으로 물러난다", () => {
  assert.equal(truncateWithoutBreakingSurrogate("abc", 10), "abc");
  assert.equal(truncateWithoutBreakingSurrogate("ab\u{1F600}", 3), "ab");
});

test("textBlocks 는 첫 블록만 지정 타입이고 나머지는 paragraph 로 이어진다", () => {
  const blocks = textBlocks("heading_2", "가".repeat(4_001));
  assert.deepEqual(blockTypes(blocks), ["heading_2", "paragraph", "paragraph"]);
  assert.ok(contentLengths(blocks).every((length) => length <= RICH_TEXT_LIMIT));
});

test("textBlocks 는 url 이 있을 때만 link 를 넣는다", () => {
  assert.match(JSON.stringify(textBlocks("paragraph", "상세 리포트 →", "https://example.com")), /"link":\{"url":"https:\/\/example\.com"\}/);
  assert.equal(/"link"/.test(JSON.stringify(textBlocks("paragraph", "상세 리포트 →"))), false);
});

test("linkParagraph 는 링크가 없으면 null, 있으면 구분자로 이어 붙인다", () => {
  assert.equal(linkParagraph([]), null);
  const paragraph = linkParagraph([
    { label: "HN 토론 →", url: "https://news.ycombinator.com/item?id=1" },
    { label: "상세 리포트 →", url: "https://www.notion.so/abc" },
  ]);
  const json = JSON.stringify(paragraph);
  assert.equal((paragraph as { type: string }).type, "paragraph");
  assert.match(json, /HN 토론/);
  assert.match(json, /상세 리포트/);
  assert.match(json, / · /);
});

test("bookmarkBlock 은 Notion bookmark 블록을 만든다", () => {
  assert.deepEqual(bookmarkBlock("https://example.com"), {
    object: "block",
    type: "bookmark",
    bookmark: { url: "https://example.com" },
  });
});

test("safeLinkUrl 은 없거나 2000자를 넘는 URL 을 버린다", () => {
  assert.equal(safeLinkUrl(null), undefined);
  assert.equal(safeLinkUrl(undefined), undefined);
  assert.equal(safeLinkUrl(""), undefined);
  assert.equal(safeLinkUrl("https://example.com"), "https://example.com");
  assert.equal(safeLinkUrl(`https://example.com/${"a".repeat(RICH_TEXT_LIMIT)}`), undefined);
});

test("linkedListItem 은 긴 URL 을 link 대신 본문으로 남긴다", () => {
  const short = linkedListItem("제목", "https://example.com");
  assert.deepEqual(blockTypes(short), ["bulleted_list_item"]);
  assert.match(JSON.stringify(short), /"link"/);

  const longUrl = `https://example.com/${"a".repeat(RICH_TEXT_LIMIT)}`;
  const long = linkedListItem("제목", longUrl);
  assert.deepEqual(blockTypes(long), ["bulleted_list_item", "paragraph", "paragraph"]);
  assert.equal(/"link"/.test(JSON.stringify(long)), false);
  assert.ok(contentLengths(long).every((length) => length <= RICH_TEXT_LIMIT));
});

test("revisionCallout 은 ai-radar:revision 마커를 담는다", () => {
  assert.match(JSON.stringify(revisionCallout(7)), /ai-radar:revision:7/);
});

test("titleRichText 는 Notion rich text 조각 수 제한을 넘으면 거부한다", () => {
  assert.throws(() => titleRichText("가".repeat(RICH_TEXT_LIMIT * 101)), /exceeds/);
});

// ---------------------------------------------------------------------------
// Daily (Notion)
// ---------------------------------------------------------------------------

test("Daily 항목은 짧게 렌더하고 리포트로 옮긴 절은 넣지 않는다", () => {
  const rendered = new NotionBlocksRenderer().render(dailyArtifact());
  const payload = rendered.payload as { properties: Record<string, unknown>; blocks: unknown[] };
  const json = JSON.stringify(payload.blocks);

  assert.equal(rendered.channel, "notion");
  assert.match(json, /무엇이 바뀌었나/);
  assert.match(json, /왜 중요한가/);
  assert.equal(/실제 개발자들은/.test(json), false);
  assert.equal(/바로 적용하려면/.test(json), false);
  assert.equal(/관련 개념/.test(json), false);
  // 유지되는 절
  assert.match(json, /오늘 하나만 배운다면/);
  assert.match(json, /내 환경에 적용할 후보/);
  assert.ok(contentLengths(payload.blocks).every((length) => length <= RICH_TEXT_LIMIT));
});

test("Daily 는 섹션 리포트/전체 목록 URL 이 있을 때만 링크 문단을 넣는다", () => {
  const withoutLinks = new NotionBlocksRenderer().render(dailyArtifact());
  assert.equal(/상세 리포트/.test(JSON.stringify(withoutLinks.payload)), false);
  assert.equal(/전체 목록/.test(JSON.stringify(withoutLinks.payload)), false);

  const base = dailyBriefBody();
  const linked = dailyBriefBody({
    sections: base.sections.map((section) => ({
      ...section,
      report: { artifactId: "art_section_report_2026-09-12:AI_CODING", externalUrl: "https://www.notion.so/report" },
    })),
    digest: { artifactId: "art_daily_digest_2026-09-12", externalUrl: "https://www.notion.so/digest" },
  });
  const rendered = new NotionBlocksRenderer().render(dailyArtifact(linked));
  const json = JSON.stringify(rendered.payload);
  assert.match(json, /"상세 리포트 →"/);
  assert.match(json, /https:\/\/www\.notion\.so\/report/);
  assert.match(json, /"오늘 들어온 이야기 전체 목록 →"/);
  assert.match(json, /https:\/\/www\.notion\.so\/digest/);
});

test("Daily 블록 순서는 callout → 1분 요약 → 섹션 → 마무리 절이다", () => {
  const rendered = new NotionBlocksRenderer().render(dailyArtifact());
  const blocks = (rendered.payload as { blocks: unknown[] }).blocks;
  assert.equal(blockTypes(blocks)[0], "callout");

  const headings = blocks
    .filter((block) => (block as { type?: string }).type === "heading_1")
    .map((block) => JSON.stringify(block));
  assert.match(headings[0] ?? "", /오늘 1분 요약/);
  assert.match(headings[1] ?? "", /AI Coding/);
  assert.match(headings[2] ?? "", /오늘 하나만 배운다면/);
  assert.match(headings[3] ?? "", /내 환경에 적용할 후보/);
  assert.match(headings[4] ?? "", /Sources/);
});
