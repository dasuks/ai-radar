/** BuildDailyDigest: 이야기를 절대 버리지 않고, LLM 이 빠뜨리면 결정적 fallback 으로 채운다. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FakeLlmProvider } from "../src/adapters/llm/fake/index.js";
import { BuildDailyDigest } from "../src/application/reporting/build-daily-digest.js";
import type { ReportEntryIndex } from "../src/application/reporting/build-section-reports.js";
import { DIGEST_TITLE_ONLY_SUMMARY } from "../src/application/analyze/prompts/write-digest.js";
import type { BriefCluster } from "../src/application/briefing/build-daily-brief.js";
import type { Claim } from "../src/domain/evidence/claim.js";
import type { Classification } from "../src/domain/evidence/analysis.js";
import type { ReportEntry } from "../src/domain/artifacts/section-report.js";
import { FakeClock, makeDocument } from "./helpers/fake-intel-stores.js";

const COVERAGE = { sourcesAttempted: ["hackernews", "rss"], sourcesFailed: [], partial: false, note: null };

function documents(count: number) {
  return Array.from({ length: count }, (_, index) =>
    makeDocument({
      id: `doc_${String(index).padStart(4, "0")}`,
      sourceId: index % 2 === 0 ? "hackernews" : "rss",
      title: `문서 ${index}`,
      content: `문서 ${index} 본문.`,
      canonicalUrl: `https://example.com/${index}`,
      publishedAt: "2026-09-12T03:00:00.000Z",
    }),
  );
}

const HN_DOC = makeDocument({
  id: "doc_hn",
  sourceId: "hackernews",
  title: "링크만 있는 글",
  content: null,
  contentCompleteness: "TITLE_ONLY",
  canonicalUrl: "https://example.com/link",
  metrics: [
    { key: "hn.points", value: 120, observedAt: "2026-09-12T04:00:00.000Z" },
    { key: "hn.comments", value: 30, observedAt: "2026-09-12T04:00:00.000Z" },
  ],
});
// HackerNews 문서의 externalId 는 makeDocument 가 id 에서 뽑는다 (doc_ 제거) → 숫자가 아니므로 토론 URL 은 urls 에서 온다.
const HN_NUMERIC = makeDocument({
  id: "doc_42",
  sourceId: "hackernews",
  title: "숫자 외부 id",
  content: null,
  contentCompleteness: "TITLE_ONLY",
  canonicalUrl: "https://example.com/42",
});

function clustersOf(docs: ReturnType<typeof documents>): BriefCluster[] {
  return docs.map((document) => ({ representative: document, members: [document] }));
}

function claim(id: string, statement: string): Claim {
  return {
    schemaVersion: 1,
    id,
    type: "FACT",
    statement,
    statementLanguage: "ko",
    subjectEntityIds: [],
    evidenceIds: ["evd_x"],
    signalRefs: [],
    confidence: 0.8,
    sentiment: "NEUTRAL",
    visibility: "PRIVATE",
    status: "ACTIVE",
    supersededById: null,
    analysisId: "ana_1",
    provenance: { method: "LLM", runId: "run_1", createdAt: "2026-09-12T08:00:00.000Z" },
  };
}

function classification(documentId: string, category: Classification["categories"][number]["category"]): Classification {
  return {
    documentId,
    categories: [{ category, confidence: 0.9 }],
    audience: "PRACTITIONER",
    provenance: { method: "LLM", runId: "run_1", createdAt: "2026-09-12T08:00:00.000Z" },
  };
}

function writer(options: { omit?: (documentId: string) => boolean } = {}): FakeLlmProvider {
  return new FakeLlmProvider({
    WRITE_DIGEST: (req) => ({
      stories: req.untrusted
        .filter((block) => !options.omit?.(block.id))
        .map((block) => ({
          documentId: block.id,
          titleKo: `한국어 제목 ${block.id}`,
          summary: "한 줄 사실 요약이다.",
          importance: 3,
        })),
    }),
  });
}

function deps(llm: FakeLlmProvider) {
  return { llm, model: "gpt-test", clock: new FakeClock() };
}

function baseInput(clusters: BriefCluster[], entryIndex: ReportEntryIndex = new Map()) {
  return {
    date: "2026-09-12",
    runId: "run_1",
    clusters,
    classifications: [],
    claimsByDocument: {} as Record<string, Claim[]>,
    entryIndex,
    coverage: COVERAGE,
  };
}

describe("BuildDailyDigest", () => {
  test("클러스터 대표 전부가 목록에 실리고 20개씩 나눠 호출한다", async () => {
    const llm = writer();
    const docs = documents(45);
    const result = await new BuildDailyDigest(deps(llm)).execute(baseInput(clustersOf(docs)));
    assert.equal(result.body.stories.length, 45);
    assert.equal(llm.callsFor("WRITE_DIGEST").length, 3);
    assert.deepEqual(
      result.body.stories.map((story) => story.documentId).sort(),
      docs.map((document) => document.id).sort(),
    );
  });

  test("LLM 이 빠뜨린 이야기도 결정적 요약으로 남는다", async () => {
    const docs = documents(3);
    const llm = writer({ omit: (id) => id === docs[1]!.id });
    const result = await new BuildDailyDigest(deps(llm)).execute({
      ...baseInput(clustersOf(docs)),
      claimsByDocument: { [docs[1]!.id]: [claim("clm_1", "첫 claim 문장이다.")] },
    });
    assert.equal(result.body.stories.length, 3);
    const missing = result.body.stories.find((story) => story.documentId === docs[1]!.id)!;
    assert.equal(missing.summary, "첫 claim 문장이다.");
    assert.equal(missing.titleKo, docs[1]!.title, "제목은 원문 제목으로 남는다");
    assert.ok(result.notes.some((note) => note.includes("deterministic fallback")));
  });

  test("본문도 claim 도 없으면 제목만 수집됨으로 채운다", async () => {
    const llm = writer({ omit: () => true });
    const result = await new BuildDailyDigest(deps(llm)).execute(baseInput(clustersOf([HN_DOC])));
    assert.equal(result.body.stories[0]!.summary, DIGEST_TITLE_ONLY_SUMMARY);
    assert.equal(result.body.stories[0]!.evidenceLevel, "TITLE_ONLY");
    assert.deepEqual(result.body.stories[0]!.metrics, { points: 120, comments: 30 });
  });

  test("LLM 배치가 실패해도 이야기를 잃지 않는다", async () => {
    const llm = new FakeLlmProvider({
      WRITE_DIGEST: () => {
        throw new Error("codex is down");
      },
    });
    const result = await new BuildDailyDigest(deps(llm)).execute(baseInput(clustersOf(documents(2))));
    assert.equal(result.body.stories.length, 2);
    assert.ok(result.notes.some((note) => note.includes("digest batch failed")));
  });

  test("리포트에 실린 이야기는 항목 id 와 섹션을 가리킨다", async () => {
    const docs = documents(2);
    const entry: ReportEntry = {
      id: "item_abc",
      title: "리포트 항목",
      importance: 4,
      narrative: ["문단"],
      evidenceQuotes: [],
      claims: [],
      communityReaction: null,
      entities: [],
      whyItMatters: "이유",
      howToApply: null,
      counterpoints: [],
      openQuestions: [],
      sourceRefs: [
        { documentId: docs[0]!.id, title: docs[0]!.title, url: "https://example.com/0", sourceId: "hackernews", publishedAt: null },
      ],
      evidenceLevel: "FULL",
    };
    const entryIndex: ReportEntryIndex = new Map([["item_abc", { sections: ["AI_CODING", "CULTURE"], entry }]]);
    const result = await new BuildDailyDigest(deps(writer())).execute({
      ...baseInput(clustersOf(docs), entryIndex),
      classifications: [classification(docs[1]!.id, "LLM")],
    });
    const linked = result.body.stories.find((story) => story.documentId === docs[0]!.id)!;
    assert.equal(linked.reportEntryId, "item_abc");
    assert.equal(linked.section, "AI_CODING");
    const unlinked = result.body.stories.find((story) => story.documentId === docs[1]!.id)!;
    assert.equal(unlinked.reportEntryId, null);
    assert.equal(unlinked.section, "LLM", "리포트가 없으면 classification 이 섹션을 정한다");
  });

  test("섹션 순서 → importance 내림차순으로 정렬한다", async () => {
    const docs = documents(3);
    const llm = new FakeLlmProvider({
      WRITE_DIGEST: (req) => ({
        stories: req.untrusted.map((block, index) => ({
          documentId: block.id,
          titleKo: `제목 ${index}`,
          summary: "요약",
          importance: index + 1,
        })),
      }),
    });
    const result = await new BuildDailyDigest(deps(llm)).execute({
      ...baseInput(clustersOf(docs)),
      classifications: [
        classification(docs[0]!.id, "LLM"),
        classification(docs[1]!.id, "CULTURE"),
        classification(docs[2]!.id, "CULTURE"),
      ],
    });
    assert.deepEqual(
      result.body.stories.map((story) => story.section),
      ["CULTURE", "CULTURE", "LLM"],
    );
    assert.deepEqual(result.body.stories.map((story) => story.importance), [3, 2, 1]);
  });

  test("HackerNews 숫자 externalId 는 토론 URL 을 만든다", async () => {
    const result = await new BuildDailyDigest(deps(writer())).execute(baseInput(clustersOf([HN_NUMERIC])));
    assert.equal(result.body.stories[0]!.discussionUrl, "https://news.ycombinator.com/item?id=42");
  });
});
