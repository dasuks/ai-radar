/** Ranking / visibility 정책: 점수 경계, reasons, 임계값, 섹션 매핑. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Classification } from "../src/domain/evidence/analysis.js";
import type { Claim, ClaimType, Sentiment } from "../src/domain/evidence/claim.js";
import type { Entity, EntityType } from "../src/domain/entities/entity.js";
import { RANKING_THRESHOLDS, type RankingInput } from "../src/policies/ranking.js";
import { cultureRankingPolicyV1, rankCulture } from "../src/policies/culture/v1.js";
import { practicalRankingPolicyV1, practicalSectionOf, rankPractical } from "../src/policies/practical/v1.js";
import { decideVisibility, isPublicHost } from "../src/policies/classification/visibility.js";
import { makeDocument } from "./helpers/fake-intel-stores.js";

function claim(type: ClaimType, sentiment: Sentiment = "NEUTRAL", statement = "테스트 주장이다."): Claim {
  return {
    schemaVersion: 1,
    id: `clm_${type}_${sentiment}_${statement.length}`,
    type,
    statement,
    statementLanguage: "ko",
    subjectEntityIds: [],
    evidenceIds: ["evd_1"],
    signalRefs: [],
    confidence: 0.8,
    sentiment,
    visibility: "PRIVATE",
    status: "ACTIVE",
    supersededById: null,
    analysisId: "ana_1",
    provenance: { method: "LLM", runId: "run_1", createdAt: "2026-09-12T00:00:00.000Z" },
  };
}

function entity(type: EntityType): Entity {
  return {
    schemaVersion: 1,
    id: `ent_${type}`,
    type,
    canonicalName: type.toLowerCase(),
    aliases: [],
    officialUrl: null,
    repositoryUrl: null,
    ecosystem: null,
    parentEntityId: null,
    versionLabel: null,
    identityConfidence: 1,
    status: "ACTIVE",
    mergedIntoId: null,
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
  };
}

function classification(categories: Classification["categories"]): Classification {
  return {
    documentId: "doc_a",
    categories,
    audience: "PRACTITIONER",
    provenance: { method: "LLM", runId: "run_1", createdAt: "2026-09-12T00:00:00.000Z" },
  };
}

function input(overrides: Partial<RankingInput> = {}): RankingInput {
  const document = overrides.document ?? makeDocument({ id: "doc_a" });
  return {
    document,
    cluster: overrides.cluster ?? [document],
    classification: overrides.classification ?? null,
    claims: overrides.claims ?? [],
    signals: overrides.signals ?? [],
    entities: overrides.entities ?? [],
  };
}

describe("ranking 공통 계약", () => {
  test("임계값은 v1.0.1 가설대로 0.3 다", () => {
    assert.equal(RANKING_THRESHOLDS["ranking.culture"], 0.3);
    assert.equal(RANKING_THRESHOLDS["ranking.practical"], 0.3);
    assert.equal(cultureRankingPolicyV1.threshold, 0.3);
    assert.equal(practicalRankingPolicyV1.threshold, 0.3);
    assert.equal(cultureRankingPolicyV1.version, "1.0.1");
    assert.equal(practicalRankingPolicyV1.version, "1.0.1");
  });

  test("신호가 없어도 reasons 는 비지 않고 점수는 0 이다", () => {
    for (const policy of [cultureRankingPolicyV1, practicalRankingPolicyV1]) {
      const output = policy.rank(input());
      assert.equal(output.score, 0);
      assert.ok(output.reasons.length > 0, `${policy.id} reasons`);
    }
  });

  test("점수는 어떤 입력에서도 0..1 안에 있다", () => {
    const document = makeDocument({
      id: "doc_a",
      canonicalUrl: "https://github.com/o/r",
      tags: ["code", "github"],
      content: "```bash\nnpm install\n```",
      metrics: [
        { key: "hn.points", value: 99_999, observedAt: "2026-09-12T00:00:00.000Z" },
        { key: "hn.comments", value: 99_999, observedAt: "2026-09-12T00:00:00.000Z" },
      ],
    });
    const loaded = input({
      document,
      cluster: [document, makeDocument({ id: "doc_b", sourceId: "reddit" }), makeDocument({ id: "doc_c", sourceId: "rss" })],
      classification: classification([
        { category: "CULTURE", confidence: 1 },
        { category: "AI_CODING", confidence: 1 },
      ]),
      claims: [
        claim("OFFICIAL_CLAIM", "MIXED"),
        claim("FACT", "MIXED"),
        claim("USER_EXPERIENCE", "POSITIVE"),
      ],
      entities: [entity("COMPANY"), entity("REPOSITORY"), entity("TOOL")],
    });
    for (const policy of [cultureRankingPolicyV1, practicalRankingPolicyV1]) {
      const output = policy.rank(loaded);
      assert.ok(output.score >= 0 && output.score <= 1, `${policy.id} score ${output.score}`);
      assert.ok(output.score > 0.5, `${policy.id} should clear the threshold`);
    }
  });
});

describe("CULTURE ranking v1", () => {
  test("공식 발표 + 반응 + 다중 소스는 임계를 넘고 CULTURE 섹션이다", () => {
    const document = makeDocument({
      id: "doc_a",
      metrics: [{ key: "hn.points", value: 400, observedAt: "2026-09-12T00:00:00.000Z" }],
    });
    const output = rankCulture(
      input({
        document,
        cluster: [document, makeDocument({ id: "doc_b", sourceId: "reddit" })],
        classification: classification([{ category: "CULTURE", confidence: 0.9 }]),
        claims: [claim("OFFICIAL_CLAIM"), claim("FACT", "MIXED"), claim("OPINION", "MIXED")],
        entities: [entity("COMPANY")],
      }),
    );
    assert.equal(output.category, "CULTURE");
    assert.ok(output.score >= cultureRankingPolicyV1.threshold, `score ${output.score}`);
    assert.ok(output.reasons.some((reason) => reason.includes("공식 발표")));
  });

  test("TITLE_ONLY 와 단일 소스 RUMOR 는 감점된다", () => {
    const base = input({
      document: makeDocument({
        id: "doc_a",
        contentCompleteness: "TITLE_ONLY",
        content: null,
        metrics: [{ key: "hn.points", value: 400, observedAt: "2026-09-12T00:00:00.000Z" }],
      }),
      claims: [claim("RUMOR")],
    });
    const penalized = rankCulture(base);
    const clean = rankCulture(
      input({
        document: makeDocument({
          id: "doc_a",
          metrics: [{ key: "hn.points", value: 400, observedAt: "2026-09-12T00:00:00.000Z" }],
        }),
        claims: [claim("FACT")],
      }),
    );
    assert.ok(penalized.score < clean.score, `${penalized.score} < ${clean.score}`);
    assert.ok(penalized.reasons.some((reason) => reason.includes("감점")));
    assert.ok(penalized.score >= 0);
  });
});

describe("PRACTICAL ranking v1", () => {
  test("경험 + 사실 + repo + how-to 분류는 임계를 넘고 섹션은 분류가 정한다", () => {
    const document = makeDocument({
      id: "doc_a",
      canonicalUrl: "https://github.com/anthropics/claude-code",
      tags: ["code"],
      content: "```bash\nnpm install -g x\n```",
    });
    const output = rankPractical(
      input({
        document,
        classification: classification([{ category: "AI_CODING", confidence: 0.9 }]),
        claims: [claim("USER_EXPERIENCE", "POSITIVE"), claim("FACT")],
        entities: [entity("REPOSITORY")],
      }),
    );
    assert.equal(output.category, "AI_CODING");
    assert.ok(output.score >= practicalRankingPolicyV1.threshold, `score ${output.score}`);
    assert.ok(output.reasons.length >= 3);
  });

  test("OTHER/CULTURE 분류만 있으면 PRACTICAL 섹션이 없다", () => {
    assert.equal(practicalSectionOf(classification([{ category: "OTHER", confidence: 1 }])), null);
    assert.equal(practicalSectionOf(classification([{ category: "CULTURE", confidence: 1 }])), null);
    assert.equal(practicalSectionOf(null), null);
    assert.equal(
      practicalSectionOf(
        classification([
          { category: "LLM", confidence: 0.3 },
          { category: "AGENT_ENGINEERING", confidence: 0.8 },
        ]),
      ),
      "AGENT_ENGINEERING",
    );
    const output = rankPractical(input({ classification: classification([{ category: "OTHER", confidence: 1 }]) }));
    assert.equal(output.category, null);
  });

  test("의견만 있는 문서는 감점되고 점수가 0 아래로 내려가지 않는다", () => {
    const output = rankPractical(
      input({
        classification: classification([{ category: "AI_CODING", confidence: 0.2 }]),
        claims: [claim("OPINION"), claim("FORECAST")],
      }),
    );
    assert.ok(output.score >= 0 && output.score < practicalRankingPolicyV1.threshold);
    assert.ok(output.reasons.some((reason) => reason.includes("감점")));
  });
});

describe("visibility 정책", () => {
  test("기본은 PRIVATE 다", () => {
    assert.equal(decideVisibility({ documentUrl: null, claimType: "FACT" }), "PRIVATE");
    assert.equal(decideVisibility({ documentUrl: "https://news.ycombinator.com/item?id=1", claimType: "FACT" }), "PRIVATE");
  });

  test("허용 호스트 + FACT/OFFICIAL_CLAIM 만 PUBLIC_OK 다", () => {
    assert.equal(decideVisibility({ documentUrl: "https://openai.com/index/x", claimType: "FACT" }), "PUBLIC_OK");
    assert.equal(decideVisibility({ documentUrl: "https://github.com/o/r", claimType: "OFFICIAL_CLAIM" }), "PUBLIC_OK");
    assert.equal(decideVisibility({ documentUrl: "https://openai.com/index/x", claimType: "OPINION" }), "PRIVATE");
    assert.equal(decideVisibility({ documentUrl: "https://openai.com/index/x", claimType: "RUMOR" }), "PRIVATE");
  });

  test("하위 도메인은 허용하고 유사 도메인은 막는다", () => {
    assert.equal(isPublicHost("www.openai.com"), true);
    assert.equal(isPublicHost("blog.openai.com"), true);
    assert.equal(isPublicHost("openai.com.evil.example"), false);
    assert.equal(isPublicHost("notopenai.com"), false);
  });
});
