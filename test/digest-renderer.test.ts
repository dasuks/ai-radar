import assert from "node:assert/strict";
import test from "node:test";
import type { Artifact } from "../src/domain/artifacts/artifact.js";
import { contentHashOf } from "../src/domain/artifacts/artifact.js";
import { canonicalJson, sha256Hex } from "../src/domain/shared/ids.js";
import type { DailyDigestBody, DigestStory } from "../src/domain/artifacts/section-report.js";
import { NotionDigestRenderer } from "../src/adapters/rendering/notion-blocks/digest-renderer.js";

const RICH_TEXT_LIMIT = 2_000;

function contentLengths(value: unknown): number[] {
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

function story(overrides: Partial<DigestStory> = {}): DigestStory {
  return {
    documentId: "doc_1",
    titleKo: "검증 루프가 표준이 되다",
    originalTitle: "Verification loops are the new default",
    summary: "여러 팀이 검증 루프를 기본 워크플로우로 채택했다.",
    section: "AI_CODING",
    evidenceLevel: "FULL",
    url: "https://example.com/story",
    discussionUrl: "https://news.ycombinator.com/item?id=1",
    sourceId: "hackernews",
    metrics: { points: 42, comments: 7 },
    importance: 4,
    reportEntryId: "item_0000000000000001",
    publishedAt: null,
    ...overrides,
  };
}

function digestBody(overrides: Partial<DailyDigestBody> = {}): DailyDigestBody {
  return {
    bodySchemaVersion: 1,
    date: "2026-09-12",
    title: "전체 목록",
    stories: [story()],
    coverage: { sourcesAttempted: ["hackernews"], sourcesFailed: [], partial: false, note: null },
    ...overrides,
  };
}

function digestArtifact(body: DailyDigestBody = digestBody(), revision = 1): Artifact<DailyDigestBody> {
  return {
    schemaVersion: 1,
    id: `art_daily_digest_${body.date}`,
    type: "DAILY_DIGEST",
    targetKey: body.date,
    revision,
    contentHash: contentHashOf(body),
    status: "FINAL",
    timezone: "Asia/Seoul",
    window: { start: "2026-09-11T00:00:00.000Z", end: "2026-09-12T00:00:00.000Z" },
    body,
    inputs: { claimIds: [], documentIds: [], signalRefs: [], rankingPolicies: [], runId: "run_TEST" },
    visibility: "PRIVATE",
    createdAt: "2026-09-12T00:00:00.000Z",
  };
}

test("digest payload 는 kind/properties/blocks 이고 hash 는 canonical JSON 의 sha256 이다", () => {
  const rendered = new NotionDigestRenderer().render(digestArtifact());
  const payload = rendered.payload as { kind: string; properties: Record<string, unknown>; blocks: unknown[] };

  assert.equal(rendered.channel, "notion");
  assert.equal(payload.kind, "digest");
  assert.equal(rendered.hash, sha256Hex(canonicalJson(payload)));
  assert.deepEqual(payload.properties.Date, { date: { start: "2026-09-12" } });
  assert.deepEqual(payload.properties.Section, { select: { name: "전체 목록" } });
  assert.deepEqual(payload.properties.Items, { number: 1 });
  assert.deepEqual(payload.properties.Importance, { number: 4 });
  assert.match(JSON.stringify(payload.properties.Name), /2026-09-12 · 전체 목록/);
});

test("블록 순서는 callout → 안내 문단 → 섹션 H2 → 이야기(H3/요약/태그/bookmark/링크) 이다", () => {
  const rendered = new NotionDigestRenderer().render(digestArtifact());
  const blocks = (rendered.payload as { blocks: unknown[] }).blocks;

  assert.deepEqual(blockTypes(blocks), [
    "callout",
    "paragraph", // 오늘 들어온 이야기 N개 · 상세 리포트 M개
    "heading_2", // AI Coding
    "heading_3", // titleKo
    "paragraph", // summary
    "paragraph", // tags
    "bookmark",
    "paragraph", // 링크 줄
  ]);
  assert.ok(contentLengths(blocks).every((length) => length <= RICH_TEXT_LIMIT));

  const json = JSON.stringify(blocks);
  assert.match(json, /ai-radar:revision:1/);
  assert.match(json, /오늘 들어온 이야기 1개 · 상세 리포트 1개/);
  assert.match(json, /AI Coding/);
  assert.match(json, /검증 루프가 표준이 되다/);
});

test("bookmark 블록이 story url 로 만들어진다", () => {
  const blocks = (new NotionDigestRenderer().render(digestArtifact()).payload as { blocks: unknown[] }).blocks;
  const bookmark = blocks.find((block) => (block as { type?: string }).type === "bookmark");
  assert.deepEqual(bookmark, { object: "block", type: "bookmark", bookmark: { url: "https://example.com/story" } });
});

test("태그 줄은 값이 있는 항목만 담는다", () => {
  const full = JSON.stringify(new NotionDigestRenderer().render(digestArtifact()).payload);
  assert.match(full, /\[본문 있음\] · \[hackernews\] · HN 42점 · 댓글 7/);

  const sparse = digestBody({
    stories: [story({ evidenceLevel: "TITLE_ONLY", metrics: { points: null, comments: null } })],
  });
  const json = JSON.stringify(new NotionDigestRenderer().render(digestArtifact(sparse)).payload);
  assert.match(json, /\[제목만\] · \[hackernews\]/);
  assert.equal(/HN \d+점/.test(json), false);
  assert.equal(/댓글 \d+/.test(json), false);
});

test("링크는 URL 이 있을 때만 넣는다 (HN 토론 / 상세 리포트)", () => {
  const noLinks = digestBody({
    stories: [story({ discussionUrl: null, reportEntryId: null })],
  });
  const plain = new NotionDigestRenderer().render(digestArtifact(noLinks));
  assert.equal(/HN 토론/.test(JSON.stringify(plain.payload)), false);
  assert.equal(/상세 리포트 →/.test(JSON.stringify(plain.payload)), false);
  assert.deepEqual(blockTypes((plain.payload as { blocks: unknown[] }).blocks), [
    "callout",
    "paragraph",
    "heading_2",
    "heading_3",
    "paragraph",
    "paragraph",
    "bookmark",
  ]);

  // reportUrlFor 를 주지 않으면 상세 리포트 링크는 없다
  const withoutOption = new NotionDigestRenderer().render(digestArtifact());
  assert.match(JSON.stringify(withoutOption.payload), /HN 토론 →/);
  assert.equal(/상세 리포트 →/.test(JSON.stringify(withoutOption.payload)), false);

  const withOption = new NotionDigestRenderer({
    reportUrlFor: (item) => (item.reportEntryId ? "https://www.notion.so/report" : null),
  }).render(digestArtifact());
  const json = JSON.stringify(withOption.payload);
  assert.match(json, /HN 토론 →/);
  assert.match(json, /상세 리포트 →/);
  assert.match(json, /https:\/\/www\.notion\.so\/report/);
});

test("섹션 분류 순서를 따르고 분류 없는 이야기는 마지막에 모은다", () => {
  const body = digestBody({
    stories: [
      story({ documentId: "d1", section: null, titleKo: "분류 없음 글" }),
      story({ documentId: "d2", section: "LLM", titleKo: "LLM 글" }),
      story({ documentId: "d3", section: "CULTURE", titleKo: "교양 글" }),
      story({ documentId: "d4", section: "LLM", titleKo: "LLM 글 2" }),
    ],
  });
  const blocks = (new NotionDigestRenderer().render(digestArtifact(body)).payload as { blocks: unknown[] }).blocks;
  const headings = blocks
    .filter((block) => (block as { type?: string }).type === "heading_2")
    .map((block) => JSON.stringify(block));

  assert.equal(headings.length, 3);
  assert.match(headings[0] ?? "", /AI 교양/);
  assert.match(headings[1] ?? "", /LLM/);
  assert.match(headings[2] ?? "", /분류 없음/);
});

test("이야기가 없으면 안내 문단만 남는다", () => {
  const rendered = new NotionDigestRenderer().render(digestArtifact(digestBody({ stories: [] })));
  const payload = rendered.payload as { properties: Record<string, unknown>; blocks: unknown[] };
  assert.deepEqual(payload.properties.Items, { number: 0 });
  assert.deepEqual(payload.properties.Importance, { number: 0 });
  assert.match(JSON.stringify(payload.blocks), /오늘 들어온 이야기가 없습니다/);
});
