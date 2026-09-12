/** BuildSectionReports: 다중 섹션 배정, 자격 미달 → excluded, 모르는 evidenceId 제거, 빈 섹션 생략. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FakeLlmProvider } from "../src/adapters/llm/fake/index.js";
import { BuildSectionReports, EXCLUDED_REASONS } from "../src/application/reporting/build-section-reports.js";
import type { BriefCluster } from "../src/application/briefing/build-daily-brief.js";
import { cultureRankingPolicyV1 } from "../src/policies/culture/v1.js";
import { practicalRankingPolicyV1 } from "../src/policies/practical/v1.js";
import { makeEvidence, type Evidence } from "../src/domain/evidence/evidence.js";
import type { Claim, ClaimType } from "../src/domain/evidence/claim.js";
import type { Classification } from "../src/domain/evidence/analysis.js";
import type { Entity } from "../src/domain/entities/entity.js";
import type { LlmRequest } from "../src/ports/llm/llm-provider.js";
import { FakeClock, makeDocument } from "./helpers/fake-intel-stores.js";

const DATE = "2026-09-12";
const WINDOW = { start: "2026-09-11T15:00:00.000Z", end: "2026-09-12T15:00:00.000Z" };

/** CULTURE 와 PRACTICAL(AI_CODING) 임계값을 동시에 넘는 문서. */
const BOTH_DOC = makeDocument({
  id: "doc_both",
  sourceId: "hackernews",
  title: "새 코딩 에이전트 공개",
  canonicalUrl: "https://github.com/anthropics/claude-code",
  tags: ["code"],
  content: "```bash\nnpm install -g tool\n```\n\n회사가 공식 발표했고 실사용 후기가 이어졌다.",
  publishedAt: "2026-09-12T03:00:00.000Z",
  metrics: [{ key: "hn.points", value: 450, observedAt: "2026-09-12T04:00:00.000Z" }],
  comments: [{ externalId: "c1", author: "hn_user", content: "빌드가 빨라졌다.", score: 3, publishedAt: null, parentExternalId: null }],
});

/** 같은 이야기의 cross-post (source diversity 가산). */
const BOTH_MIRROR = makeDocument({
  id: "doc_both_mirror",
  sourceId: "rss",
  title: "코딩 에이전트 공개 정리",
  canonicalUrl: "https://example.com/mirror",
  publishedAt: "2026-09-12T04:00:00.000Z",
});

/** LLM 섹션만 넘는 문서. */
const LLM_DOC = makeDocument({
  id: "doc_llm",
  sourceId: "rss",
  title: "모델 컨텍스트 확장",
  canonicalUrl: "https://example.com/llm",
  content: "컨텍스트 길이가 늘었다는 설명과 실사용 후기가 있다.",
  publishedAt: "2026-09-12T05:00:00.000Z",
});

/** 제목만 수집돼 상세 자격이 없는 문서. */
const THIN_DOC = makeDocument({
  id: "doc_thin",
  sourceId: "hackernews",
  title: "짧은 링크 글",
  content: null,
  contentCompleteness: "TITLE_ONLY",
  canonicalUrl: "https://example.com/thin",
  publishedAt: "2026-09-12T06:00:00.000Z",
});

function evidenceFor(documentId: string, suffix = "a"): Evidence {
  return makeEvidence({
    documentId,
    observationId: `obs_${documentId}`,
    locator: { kind: "excerpt", start: 0, end: 10, text: `${documentId} ${suffix} 근거 문장` },
    capturedAt: "2026-09-12T08:00:00.000Z",
    publishedAt: "2026-09-12T03:00:00.000Z",
  });
}

function commentEvidence(documentId: string, commentExternalId: string): Evidence {
  return makeEvidence({
    documentId,
    observationId: `obs_${documentId}`,
    locator: { kind: "comment", commentExternalId, text: "빌드가 빨라졌다." },
    capturedAt: "2026-09-12T08:00:00.000Z",
    publishedAt: null,
  });
}

function claim(id: string, documentId: string, type: ClaimType, statement: string, entityIds: string[] = []): Claim {
  return {
    schemaVersion: 1,
    id,
    type,
    statement,
    statementLanguage: "ko",
    subjectEntityIds: entityIds,
    evidenceIds: [evidenceFor(documentId).id],
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

function classification(documentId: string, categories: Classification["categories"]): Classification {
  return {
    documentId,
    categories,
    audience: "PRACTITIONER",
    provenance: { method: "LLM", runId: "run_1", createdAt: "2026-09-12T08:00:00.000Z" },
  };
}

const REPO_ENTITY: Entity = {
  schemaVersion: 1,
  id: "ent_repo",
  type: "REPOSITORY",
  canonicalName: "anthropics/claude-code",
  aliases: [],
  officialUrl: null,
  repositoryUrl: "https://github.com/anthropics/claude-code",
  ecosystem: null,
  parentEntityId: null,
  versionLabel: null,
  identityConfidence: 1,
  status: "ACTIVE",
  mergedIntoId: null,
  createdAt: "2026-09-12T00:00:00.000Z",
  updatedAt: "2026-09-12T00:00:00.000Z",
};

const CLAIMS = {
  bothOfficial: claim("clm_b1", "doc_both", "OFFICIAL_CLAIM", "회사가 도구를 공개했다.", ["ent_repo"]),
  bothExperience: claim("clm_b2", "doc_both", "USER_EXPERIENCE", "글쓴이는 리뷰 시간이 줄었다고 말한다.", ["ent_repo"]),
  bothFact: claim("clm_b3", "doc_both", "FACT", "도구는 CLI 로 배포된다.", ["ent_repo"]),
  llmExperience: claim("clm_l1", "doc_llm", "USER_EXPERIENCE", "글쓴이는 긴 문서를 한 번에 넣었다고 말한다."),
  llmFact: claim("clm_l2", "doc_llm", "FACT", "컨텍스트 길이가 늘었다."),
  thin: claim("clm_t1", "doc_thin", "FACT", "링크가 공유되었다."),
};

function baseInput() {
  const clusters: BriefCluster[] = [
    { representative: BOTH_DOC, members: [BOTH_DOC, BOTH_MIRROR] },
    { representative: LLM_DOC, members: [LLM_DOC] },
    { representative: THIN_DOC, members: [THIN_DOC] },
  ];
  return {
    date: DATE,
    window: WINDOW,
    timezone: "Asia/Seoul",
    runId: "run_1",
    clusters,
    classifications: [
      classification("doc_both", [
        { category: "AI_CODING" as const, confidence: 0.9 },
        { category: "CULTURE" as const, confidence: 0.9 },
      ]),
      classification("doc_llm", [{ category: "LLM" as const, confidence: 0.9 }]),
      classification("doc_thin", [{ category: "OTHER" as const, confidence: 0.9 }]),
    ],
    claimsByDocument: {
      doc_both: [CLAIMS.bothOfficial, CLAIMS.bothExperience, CLAIMS.bothFact],
      doc_llm: [CLAIMS.llmExperience, CLAIMS.llmFact],
      doc_thin: [CLAIMS.thin],
    } as Record<string, Claim[]>,
    evidence: [
      evidenceFor("doc_both"),
      commentEvidence("doc_both", "c1"),
      evidenceFor("doc_llm"),
      evidenceFor("doc_thin"),
    ],
    entities: [REPO_ENTITY],
    documents: [BOTH_DOC, BOTH_MIRROR, LLM_DOC, THIN_DOC],
    coverage: { sourcesAttempted: ["hackernews", "rss"], sourcesFailed: [], partial: false, note: null },
  };
}

function deps(llm: FakeLlmProvider) {
  return {
    llm,
    model: "gpt-test",
    policies: [cultureRankingPolicyV1, practicalRankingPolicyV1],
    clock: new FakeClock(),
  };
}

function evidenceIdsIn(req: LlmRequest, entryId: string): string[] {
  const block = req.untrusted.find((item) => item.id === entryId);
  if (!block) return [];
  return [...block.text.matchAll(/evidence id="(evd_[^"]+)"/g)].map((match) => match[1]!);
}

interface WriterOptions {
  /** 이 entryId 들에는 존재하지 않는 evidenceId 만 돌려준다 */
  bogusEvidenceFor?: (entryId: string) => boolean;
  /** 이 entryId 는 아예 출력하지 않는다 */
  skip?: (entryId: string) => boolean;
  extraUnknownEvidence?: boolean;
}

function writer(options: WriterOptions = {}): FakeLlmProvider {
  return new FakeLlmProvider({
    WRITE_SECTION_REPORT: (req) => ({
      overview: ["오늘 이 분야의 흐름을 요약한다.", "두 번째 문장.", "세 번째 문장."],
      entries: req.untrusted
        .filter((block) => !options.skip?.(block.id))
        .map((block, index) => {
          const known = evidenceIdsIn(req, block.id);
          const evidenceIds = options.bogusEvidenceFor?.(block.id)
            ? ["evd_does_not_exist"]
            : options.extraUnknownEvidence
              ? ["evd_does_not_exist", ...known]
              : known;
          return {
            entryId: block.id,
            title: `리포트 항목 ${index + 1}`,
            narrative: ["첫 문단이다.", "둘째 문단이다."],
            evidenceIds,
            communityReaction: "댓글은 긍정적이다.",
            whyItMatters: "이 개발자에게 중요한 이유다.",
            howToApply: "이번 주에 적용해 볼 수 있다.",
            counterpoints: ["반론이 있다."],
            openQuestions: ["남은 질문이 있다."],
            importance: 4,
          };
        }),
    }),
  });
}

describe("BuildSectionReports", () => {
  test("한 항목이 임계값을 넘는 모든 섹션에 실린다", async () => {
    const llm = writer();
    const result = await new BuildSectionReports(deps(llm)).execute(baseInput());

    const sections = result.reports.map((report) => report.section).sort();
    assert.deepEqual(sections, ["AI_CODING", "CULTURE", "LLM"]);

    const inAiCoding = result.reports.find((r) => r.section === "AI_CODING")!.entries.map((e) => e.id);
    const inCulture = result.reports.find((r) => r.section === "CULTURE")!.entries.map((e) => e.id);
    assert.equal(inAiCoding.length, 1);
    assert.deepEqual(inAiCoding, inCulture, "같은 항목이 두 섹션에 실린다");

    const indexed = result.entryIndex.get(inAiCoding[0]!);
    assert.ok(indexed);
    assert.deepEqual([...indexed.sections].sort(), ["AI_CODING", "CULTURE"]);
    assert.equal(indexed.sections[0], "AI_CODING", "sections[0] 은 점수가 가장 높은 섹션이다");
  });

  test("리포트 항목은 claim/evidence/entity/sourceRefs 를 그대로 싣는다", async () => {
    const result = await new BuildSectionReports(deps(writer())).execute(baseInput());
    const entry = result.reports.find((r) => r.section === "AI_CODING")!.entries[0]!;

    assert.deepEqual(
      entry.claims.map((claim) => claim.claimId).sort(),
      ["clm_b1", "clm_b2", "clm_b3"],
    );
    assert.ok(entry.evidenceQuotes.length >= 1);
    assert.deepEqual(entry.entities.map((e) => e.name), ["anthropics/claude-code"]);
    assert.deepEqual(entry.sourceRefs.map((s) => s.documentId), ["doc_both", "doc_both_mirror"]);
    assert.equal(entry.evidenceLevel, "FULL");
    assert.equal(entry.howToApply, "이번 주에 적용해 볼 수 있다.");

    const comment = entry.evidenceQuotes.find((quote) => quote.kind === "comment");
    assert.ok(comment, "댓글 evidence 도 인용에 포함된다");
    assert.equal(comment.author, "hn_user");
  });

  test("자격이 없는 이야기는 excluded 에 사유와 함께 남는다", async () => {
    const result = await new BuildSectionReports(deps(writer())).execute(baseInput());
    const excluded = result.reports[0]!.excluded;
    const thin = excluded.find((story) => story.documentId === "doc_thin");
    assert.ok(thin, "TITLE_ONLY 문서는 excluded 에 있다");
    assert.equal(thin.reason, EXCLUDED_REASONS.titleOnly);
    assert.ok(!result.entryIndex.has("doc_thin"));
    assert.ok(
      result.reports.every((report) => report.entries.every((entry) => entry.id !== "doc_thin")),
    );
  });

  test("모르는 evidenceId 는 버리고 나머지 인용으로 항목을 만든다", async () => {
    const result = await new BuildSectionReports(deps(writer({ extraUnknownEvidence: true }))).execute(baseInput());
    const entry = result.reports.find((r) => r.section === "LLM")!.entries[0]!;
    assert.ok(entry.evidenceQuotes.every((quote) => quote.evidenceId !== "evd_does_not_exist"));
    assert.ok(entry.evidenceQuotes.length > 0);
    assert.ok(result.notes.some((note) => note.includes("unknown evidenceId")));
  });

  test("유효한 항목이 하나도 없는 섹션은 생략된다", async () => {
    const llm = writer({ bogusEvidenceFor: (entryId) => entryId.length > 0 && true });
    const result = await new BuildSectionReports(deps(llm)).execute({
      ...baseInput(),
      clusters: [{ representative: LLM_DOC, members: [LLM_DOC] }],
    });
    assert.deepEqual(result.reports, []);
    assert.equal(result.entryIndex.size, 0);
    assert.ok(result.notes.some((note) => note.includes("no valid entries")));
  });

  test("LLM 이 쓰지 않은 항목은 버려지고 note 로 남는다", async () => {
    const llm = writer({ skip: () => true });
    const result = await new BuildSectionReports(deps(llm)).execute(baseInput());
    assert.deepEqual(result.reports, []);
    assert.ok(result.notes.some((note) => note.includes("no written body")));
  });

  test("LLM 호출 상한을 넘으면 남은 섹션을 쓰지 않는다", async () => {
    const llm = writer();
    const result = await new BuildSectionReports(deps(llm)).execute({ ...baseInput(), maxCallsPerRun: 1 });
    assert.equal(llm.callsFor("WRITE_SECTION_REPORT").length, 1);
    assert.equal(result.reports.length, 1);
  });
});
