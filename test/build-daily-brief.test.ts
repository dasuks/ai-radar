/** BuildDailyBrief: 섹션 배정, LLM 미작성 item 제거, claimId 검증, learnOneThing/sources, 불변 조건. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FakeLlmProvider } from "../src/adapters/llm/fake/index.js";
import { BuildDailyBrief, type BriefCluster } from "../src/application/briefing/build-daily-brief.js";
import { cultureRankingPolicyV1 } from "../src/policies/culture/v1.js";
import { practicalRankingPolicyV1 } from "../src/policies/practical/v1.js";
import { makeEvidence, type Evidence } from "../src/domain/evidence/evidence.js";
import type { Claim, ClaimType } from "../src/domain/evidence/claim.js";
import type { Classification } from "../src/domain/evidence/analysis.js";
import type { NormalizedDocument } from "../src/domain/documents/normalized-document.js";
import { ContractValidationError } from "../src/domain/shared/validation.js";
import type { LlmRequest } from "../src/ports/llm/llm-provider.js";
import { FakeClock, makeDocument } from "./helpers/fake-intel-stores.js";

const PRACTICAL_DOC = makeDocument({
  id: "doc_practical",
  sourceId: "hackernews",
  title: "에이전트 CLI 실사용기",
  canonicalUrl: "https://github.com/anthropics/claude-code",
  tags: ["code"],
  content: "```bash\nnpm install -g tool\n```\n\n실제로 써 보니 리뷰 시간이 줄었다.",
  publishedAt: "2026-09-12T03:00:00.000Z",
});

const CULTURE_DOC = makeDocument({
  id: "doc_culture",
  sourceId: "hackernews",
  title: "새 모델 공식 발표",
  canonicalUrl: "https://openai.com/index/new-model",
  content: "회사가 새 모델을 발표했다.\n\n반응은 엇갈린다.",
  publishedAt: "2026-09-12T06:00:00.000Z",
  metrics: [{ key: "hn.points", value: 450, observedAt: "2026-09-12T07:00:00.000Z" }],
});

const CULTURE_MIRROR = makeDocument({
  id: "doc_culture_mirror",
  sourceId: "reddit",
  title: "새 모델 발표 정리",
  canonicalUrl: "https://www.reddit.com/r/ai/x",
  publishedAt: "2026-09-12T07:00:00.000Z",
});

const WEAK_DOC = makeDocument({
  id: "doc_weak",
  sourceId: "rss",
  title: "잡담",
  content: "특별할 것 없는 글.",
  canonicalUrl: "https://example.org/weak",
  publishedAt: "2026-09-11T00:00:00.000Z",
});

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
    sentiment: type === "USER_EXPERIENCE" ? "POSITIVE" : "MIXED",
    visibility: "PRIVATE",
    status: "ACTIVE",
    supersededById: null,
    analysisId: "ana_1",
    provenance: { method: "LLM", runId: "run_1", createdAt: "2026-09-12T08:00:00.000Z" },
  };
}

function evidenceFor(documentId: string): Evidence {
  return makeEvidence({
    documentId,
    observationId: `obs_${documentId}`,
    locator: { kind: "excerpt", start: 0, end: 10, text: `${documentId} 근거 문장` },
    capturedAt: "2026-09-12T08:00:00.000Z",
    publishedAt: "2026-09-12T03:00:00.000Z",
  });
}

function classification(documentId: string, categories: Classification["categories"]): Classification {
  return {
    documentId,
    categories,
    audience: "PRACTITIONER",
    provenance: { method: "LLM", runId: "run_1", createdAt: "2026-09-12T08:00:00.000Z" },
  };
}

const CLAIMS = {
  practicalExperience: claim("clm_p1", "doc_practical", "USER_EXPERIENCE", "글쓴이는 리뷰 시간이 줄었다고 보고한다.", [
    "ent_repo",
  ]),
  practicalFact: claim("clm_p2", "doc_practical", "FACT", "도구가 공개되었다.", ["ent_repo"]),
  cultureOfficial: claim("clm_c1", "doc_culture", "OFFICIAL_CLAIM", "회사가 새 모델을 발표했다."),
  cultureOpinion: claim("clm_c2", "doc_culture", "OPINION", "반응은 엇갈린다."),
};

function baseInput(overrides: Partial<Parameters<BuildDailyBrief["execute"]>[0]> = {}) {
  const clusters: BriefCluster[] = [
    { representative: PRACTICAL_DOC, members: [PRACTICAL_DOC] },
    { representative: CULTURE_DOC, members: [CULTURE_DOC, CULTURE_MIRROR] },
    { representative: WEAK_DOC, members: [WEAK_DOC] },
  ];
  return {
    date: "2026-09-12",
    window: { start: "2026-09-11T15:00:00.000Z", end: "2026-09-12T15:00:00.000Z" },
    timezone: "Asia/Seoul",
    runId: "run_1",
    clusters,
    classifications: [
      classification("doc_practical", [{ category: "AI_CODING", confidence: 0.9 }]),
      classification("doc_culture", [{ category: "CULTURE", confidence: 0.95 }]),
    ],
    claimsByDocument: {
      doc_practical: [CLAIMS.practicalExperience, CLAIMS.practicalFact],
      doc_culture: [CLAIMS.cultureOfficial, CLAIMS.cultureOpinion],
    } as Record<string, Claim[]>,
    entities: [
      {
        schemaVersion: 1 as const,
        id: "ent_repo",
        type: "REPOSITORY" as const,
        canonicalName: "anthropics/claude-code",
        aliases: [],
        officialUrl: null,
        repositoryUrl: "https://github.com/anthropics/claude-code",
        ecosystem: null,
        parentEntityId: null,
        versionLabel: null,
        identityConfidence: 1,
        status: "ACTIVE" as const,
        mergedIntoId: null,
        createdAt: "2026-09-12T00:00:00.000Z",
        updatedAt: "2026-09-12T00:00:00.000Z",
      },
    ],
    evidence: [evidenceFor("doc_practical"), evidenceFor("doc_culture")],
    coverage: { sourcesAttempted: ["hackernews", "reddit", "rss"], sourcesFailed: [], partial: false, note: null },
    ...overrides,
  };
}

function claimIdsIn(req: LlmRequest, itemId: string): string[] {
  const block = req.untrusted.find((item) => item.id === itemId);
  if (!block) return [];
  return [...block.text.matchAll(/claim id="(clm_[^"]+)"/g)].map((match) => match[1]!);
}

function deps(llm: FakeLlmProvider) {
  return {
    llm,
    model: "gpt-test",
    policies: [cultureRankingPolicyV1, practicalRankingPolicyV1],
    clock: new FakeClock(),
  };
}

function writerReturningAll(extra: { bogusClaimId?: boolean; bogusItemId?: boolean; only?: number } = {}) {
  return new FakeLlmProvider({
    WRITE_BRIEF_KO: (req) => {
      const blocks = extra.only === undefined ? req.untrusted : req.untrusted.slice(0, extra.only);
      const items = blocks.map((block, index) => ({
        itemId: block.id,
        title: `제목 ${index + 1}`,
        whatChanged: "무엇이 바뀌었는지 한국어로 적는다.",
        whyItMatters: "왜 중요한지 한국어로 적는다.",
        howDevelopersUseIt: index === 0 ? "개발자는 이렇게 쓴다." : null,
        howToApply: index === 0 ? "오늘 이 도구를 설치해 본다." : null,
        importance: 4,
        claimIds: extra.bogusClaimId
          ? [...claimIdsIn(req, block.id), "clm_hallucinated"]
          : claimIdsIn(req, block.id),
      }));
      if (extra.bogusItemId) {
        items.push({
          itemId: "item_hallucinated",
          title: "없는 항목",
          whatChanged: "x",
          whyItMatters: "y",
          howDevelopersUseIt: null,
          howToApply: null,
          importance: 3,
          claimIds: ["clm_p1"],
        });
      }
      return { items, oneMinuteSummary: ["첫 문장.", "둘째 문장.", "셋째 문장."] };
    },
  });
}

describe("BuildDailyBrief", () => {
  test("임계 미달 문서는 빠지고 빈 섹션은 만들지 않는다", async () => {
    const llm = writerReturningAll();
    const result = await new BuildDailyBrief(deps(llm)).execute(baseInput());

    assert.deepEqual(
      result.body.sections.map((section) => section.kind),
      ["CULTURE", "AI_CODING"],
    );
    for (const section of result.body.sections) assert.ok(section.items.length > 0);
    const documentIds = result.body.sections.flatMap((section) =>
      section.items.flatMap((item) => item.sourceRefs.map((source) => source.documentId)),
    );
    assert.equal(documentIds.includes("doc_weak"), false);
    assert.equal(llm.callCount, 1);
    assert.equal(llm.calls[0]?.req.task, "WRITE_BRIEF_KO");
    // cluster 의 모든 문서가 sourceRefs 에 들어간다.
    const culture = result.body.sections[0]?.items[0];
    assert.deepEqual(culture?.sourceRefs.map((source) => source.documentId), ["doc_culture", "doc_culture_mirror"]);
    assert.equal(culture?.rankingTrace.policyId, "ranking.culture");
    assert.ok((culture?.rankingTrace.reasons.length ?? 0) > 0);
  });

  test("LLM 이 쓰지 않은 item 은 brief 에서 빠진다", async () => {
    const llm = writerReturningAll({ only: 1 });
    const result = await new BuildDailyBrief(deps(llm)).execute(baseInput());

    assert.equal(result.body.sections.length, 1);
    assert.equal(result.body.sections[0]?.items.length, 1);
    assert.ok(result.notes.some((note) => note.includes("no written body")));
  });

  test("모르는 claimId 는 버리고 모르는 itemId 는 항목째 거부한다", async () => {
    const llm = writerReturningAll({ bogusClaimId: true, bogusItemId: true });
    const result = await new BuildDailyBrief(deps(llm)).execute(baseInput());

    const allClaimIds = result.body.sections.flatMap((section) => section.items.flatMap((item) => item.claimIds));
    assert.equal(allClaimIds.includes("clm_hallucinated"), false);
    assert.ok(allClaimIds.includes("clm_p1"));
    assert.equal(result.rejectedItems, 1);
    assert.equal(
      result.body.sections.flatMap((section) => section.items).some((item) => item.id === "item_hallucinated"),
      false,
    );
  });

  test("learnOneThing 은 PRACTICAL 최고점, applyCandidates 는 howToApply 가 있는 item 이다", async () => {
    const llm = writerReturningAll();
    const result = await new BuildDailyBrief(deps(llm)).execute(baseInput());

    const learn = result.body.learnOneThing;
    assert.ok(learn);
    assert.equal(learn.rankingTrace.policyId, "ranking.practical");
    assert.equal(learn.knowledgeType, "tool");
    // applyCandidates 는 howToApply 가 있는 item 만 (fake writer 는 첫 item 에만 채운다).
    const withApply = result.body.sections
      .flatMap((section) => section.items)
      .filter((item) => item.howToApply !== null);
    assert.equal(withApply.length, 1);
    assert.deepEqual(
      result.body.applyCandidates.map((candidate) => candidate.itemId),
      withApply.map((item) => item.id),
    );
    assert.equal(result.body.applyCandidates[0]?.action, "오늘 이 도구를 설치해 본다.");
    assert.equal(result.body.applyCandidates[0]?.effort, "M");
    // sources 는 publishedAt 내림차순 합집합이다.
    assert.deepEqual(
      result.body.sources.map((source) => source.documentId),
      ["doc_culture_mirror", "doc_culture", "doc_practical"],
    );
    assert.equal(result.body.oneMinuteSummary.length, 3);
    assert.equal(result.body.title, "AI Intelligence Daily");
    assert.deepEqual(result.inputs.rankingPolicies, [
      { id: "ranking.culture", version: "1.0.1" },
      { id: "ranking.practical", version: "1.0.1" },
    ]);
    assert.deepEqual(result.inputs.claimIds, ["clm_c1", "clm_c2", "clm_p1", "clm_p2"]);
    assert.equal(result.inputs.runId, "run_1");
  });

  test("불변 조건을 어기면 던진다", async () => {
    const llm = writerReturningAll();
    await assert.rejects(
      () => new BuildDailyBrief(deps(llm)).execute(baseInput({ date: "2026-13-45" })),
      (error: unknown) => error instanceof ContractValidationError && /date must be YYYY-MM-DD/.test(error.message),
    );
  });

  test("항목이 하나도 없으면 빈 brief 를 돌려주고 LLM 을 부르지 않는다", async () => {
    const llm = writerReturningAll();
    const weakOnly: BriefCluster[] = [{ representative: WEAK_DOC, members: [WEAK_DOC] }];
    const result = await new BuildDailyBrief(deps(llm)).execute(
      baseInput({ clusters: weakOnly, classifications: [], claimsByDocument: {} as Record<string, Claim[]> }),
    );

    assert.equal(llm.callCount, 0);
    assert.deepEqual(result.body.sections, []);
    assert.equal(result.body.learnOneThing, null);
    assert.deepEqual(result.body.sources, []);
    assert.deepEqual(result.usage, []);
  });
});

describe("BuildDailyBrief 입력 문서", () => {
  test("cluster 대표의 제목은 LLM 출력 전 뼈대에만 쓰이고 최종 title 은 LLM 이 정한다", async () => {
    const llm = writerReturningAll();
    const result = await new BuildDailyBrief(deps(llm)).execute(baseInput());
    const titles = result.body.sections.flatMap((section) => section.items.map((item) => item.title));
    for (const title of titles) assert.match(title, /^제목 \d$/);
    const documents: NormalizedDocument[] = [PRACTICAL_DOC, CULTURE_DOC];
    for (const document of documents) assert.equal(titles.includes(document.title), false);
  });
});
