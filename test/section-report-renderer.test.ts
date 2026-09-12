import assert from "node:assert/strict";
import test from "node:test";
import type { Artifact } from "../src/domain/artifacts/artifact.js";
import { contentHashOf } from "../src/domain/artifacts/artifact.js";
import { canonicalJson, sha256Hex } from "../src/domain/shared/ids.js";
import type { ReportEntry, SectionReportBody } from "../src/domain/artifacts/section-report.js";
import { NotionSectionReportRenderer } from "../src/adapters/rendering/notion-blocks/section-report-renderer.js";

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

function reportEntry(overrides: Partial<ReportEntry> = {}): ReportEntry {
  return {
    id: "item_0000000000000001",
    title: "Verification Loop",
    importance: 4,
    narrative: ["첫 문단.", "둘째 문단."],
    evidenceQuotes: [
      {
        evidenceId: "evd_1",
        documentId: "doc_1",
        text: "we ship faster with a verification loop",
        kind: "comment",
        url: "https://news.ycombinator.com/item?id=1",
        author: "tptacek",
      },
      {
        evidenceId: "evd_2",
        documentId: "doc_1",
        text: "본문 발췌",
        kind: "excerpt",
        url: null,
        author: null,
      },
    ],
    claims: [
      { claimId: "clm_1", type: "FACT", statement: "릴리스가 나왔다.", sentiment: "NEUTRAL", confidence: 0.9 },
      { claimId: "clm_2", type: "USER_EXPERIENCE", statement: "빨라졌다고 느꼈다.", sentiment: "POSITIVE", confidence: 0.5 },
    ],
    communityReaction: "댓글은 대체로 긍정적이다.",
    entities: [
      { entityId: "ent_1", name: "Claude Code", type: "TOOL" },
      { entityId: null, name: "Unknown Inc", type: null },
    ],
    whyItMatters: "회귀를 빠르게 발견한다.",
    howToApply: "완료 조건에 테스트를 추가한다.",
    counterpoints: ["표본이 작다."],
    openQuestions: ["장기 효과는?"],
    sourceRefs: [
      {
        documentId: "doc_1",
        title: "Source",
        url: "https://example.com",
        sourceId: "hackernews",
        publishedAt: null,
      },
    ],
    evidenceLevel: "FULL",
    ...overrides,
  };
}

function sectionReportBody(overrides: Partial<SectionReportBody> = {}): SectionReportBody {
  return {
    bodySchemaVersion: 1,
    date: "2026-09-12",
    section: "AI_CODING",
    title: "AI Coding 상세",
    overview: ["오늘의 흐름 1", "오늘의 흐름 2"],
    entries: [reportEntry()],
    sources: [
      {
        documentId: "doc_1",
        title: "Source",
        url: "https://example.com",
        sourceId: "hackernews",
        publishedAt: null,
      },
    ],
    excluded: [],
    coverage: { sourcesAttempted: ["hackernews"], sourcesFailed: [], partial: false, note: null },
    ...overrides,
  };
}

function sectionArtifact(body: SectionReportBody = sectionReportBody(), revision = 1): Artifact<SectionReportBody> {
  return {
    schemaVersion: 1,
    id: `art_section_report_${body.date}:${body.section}`,
    type: "SECTION_REPORT",
    targetKey: `${body.date}:${body.section}`,
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

test("섹션 리포트 payload 는 kind/properties/blocks 이고 hash 는 canonical JSON 의 sha256 이다", () => {
  const rendered = new NotionSectionReportRenderer().render(sectionArtifact());
  const payload = rendered.payload as { kind: string; properties: Record<string, unknown>; blocks: unknown[] };

  assert.equal(rendered.channel, "notion");
  assert.equal(payload.kind, "section-report");
  assert.equal(rendered.hash, sha256Hex(canonicalJson(payload)));
  assert.deepEqual(payload.properties.Date, { date: { start: "2026-09-12" } });
  assert.deepEqual(payload.properties.Section, { select: { name: "AI Coding" } });
  assert.deepEqual(payload.properties.Items, { number: 1 });
  assert.deepEqual(payload.properties.Importance, { number: 4 });
  assert.match(JSON.stringify(payload.properties.Name), /2026-09-12 · AI Coding 상세/);
});

test("Importance 는 항목 중 최댓값, Items 는 항목 수다", () => {
  const body = sectionReportBody({
    entries: [reportEntry({ id: "a", importance: 2 }), reportEntry({ id: "b", importance: 5 })],
  });
  const payload = new NotionSectionReportRenderer().render(sectionArtifact(body)).payload as {
    properties: Record<string, unknown>;
  };
  assert.deepEqual(payload.properties.Items, { number: 2 });
  assert.deepEqual(payload.properties.Importance, { number: 5 });
});

test("블록 순서는 callout → 한눈에 → 항목(divider/H2/...) → 이 분야 출처 이다", () => {
  const rendered = new NotionSectionReportRenderer().render(sectionArtifact());
  const blocks = (rendered.payload as { blocks: unknown[] }).blocks;
  const types = blockTypes(blocks);

  assert.equal(types[0], "callout");
  assert.equal(types[1], "heading_1");
  assert.equal(types[2], "bulleted_list_item");
  assert.equal(types[3], "bulleted_list_item");
  assert.equal(types[4], "divider");
  assert.equal(types[5], "heading_2");
  assert.equal(types[6], "paragraph");
  assert.ok(types.includes("quote"));
  assert.ok(contentLengths(blocks).every((length) => length <= RICH_TEXT_LIMIT));

  const json = JSON.stringify(blocks);
  assert.match(json, /ai-radar:revision:1/);
  assert.match(json, /오늘 이 분야 한눈에/);
  assert.match(json, /무슨 일이 있었나/);
  assert.match(json, /근거 인용/);
  assert.match(json, /주장 구분/);
  assert.match(json, /커뮤니티 반응/);
  assert.match(json, /관련 회사·도구/);
  assert.match(json, /왜 중요한가/);
  assert.match(json, /내 환경에 적용하려면/);
  assert.match(json, /반론과 불확실한 점/);
  assert.match(json, /이 분야 출처/);
  assert.equal(/상세로 다루지 못한 이야기/.test(json), false);
});

test("중요도·근거 수준·주장 구분·엔티티는 한국어 라벨로 표기한다", () => {
  const json = JSON.stringify(new NotionSectionReportRenderer().render(sectionArtifact()).payload);
  assert.match(json, /중요도 4\/5 · 근거 수준 본문 있음/);
  assert.match(json, /\[사실\] 릴리스가 나왔다\./);
  assert.match(json, /\[사용자 경험\] 빨라졌다고 느꼈다\./);
  assert.match(json, /Claude Code \(TOOL\)/);
  assert.match(json, /"Unknown Inc"/);
});

test("근거 수준 라벨은 completeness 별로 다르다", () => {
  const labels: Array<[SectionReportBody["entries"][number]["evidenceLevel"], string]> = [
    ["FULL", "본문 있음"],
    ["EXCERPT", "요약문"],
    ["TITLE_ONLY", "제목만"],
    ["MISSING", "본문 없음"],
  ];
  for (const [level, label] of labels) {
    const body = sectionReportBody({ entries: [reportEntry({ evidenceLevel: level })] });
    const json = JSON.stringify(new NotionSectionReportRenderer().render(sectionArtifact(body)).payload);
    assert.match(json, new RegExp(`근거 수준 ${label}`));
  }
});

test("인용은 quote 블록이고 url 이 있을 때만 원문 링크 문단이 붙는다", () => {
  const blocks = (new NotionSectionReportRenderer().render(sectionArtifact()).payload as { blocks: unknown[] }).blocks;
  const quoteIndexes = blockTypes(blocks)
    .map((type, index) => (type === "quote" ? index : -1))
    .filter((index) => index >= 0);
  assert.equal(quoteIndexes.length, 2);

  const first = quoteIndexes[0]!;
  assert.match(JSON.stringify(blocks[first]), /\\"we ship faster with a verification loop\\" — tptacek/);
  assert.equal(blockTypes([blocks[first + 1]])[0], "paragraph");
  assert.match(JSON.stringify(blocks[first + 1]), /news\.ycombinator\.com/);

  // author 가 없으면 "출처", url 이 없으면 링크 문단이 없다
  const second = quoteIndexes[1]!;
  assert.match(JSON.stringify(blocks[second]), /\\"본문 발췌\\" — 출처/);
  assert.equal(/"link"/.test(JSON.stringify(blocks[second + 1])), false);
});

test("excluded 가 있으면 마지막에 '상세로 다루지 못한 이야기' 를 붙인다", () => {
  const body = sectionReportBody({
    excluded: [{ documentId: "doc_9", title: "제목만 있는 글", url: "https://example.com/x", reason: "본문 없음" }],
  });
  const json = JSON.stringify(new NotionSectionReportRenderer().render(sectionArtifact(body)).payload);
  assert.match(json, /상세로 다루지 못한 이야기/);
  assert.match(json, /제목만 있는 글 — 본문 없음/);
  assert.match(json, /https:\/\/example\.com\/x/);
});

test("수집 실패는 callout 다음 문단으로 표시한다", () => {
  const body = sectionReportBody({
    coverage: { sourcesAttempted: ["hackernews", "rss"], sourcesFailed: ["rss"], partial: true, note: null },
  });
  const json = JSON.stringify(new NotionSectionReportRenderer().render(sectionArtifact(body)).payload);
  assert.match(json, /수집 실패: rss/);
});
