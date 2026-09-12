import type { Artifact } from "../../src/domain/artifacts/artifact.js";
import { contentHashOf } from "../../src/domain/artifacts/artifact.js";
import {
  DAILY_BRIEF_TITLE,
  type BriefItem,
  type DailyBriefBody,
} from "../../src/domain/artifacts/daily-brief.js";

export function briefItem(overrides: Partial<BriefItem> = {}): BriefItem {
  return {
    id: "item_0000000000000001",
    title: "Verification Loop",
    importance: 5,
    whatChanged: "검증 루프가 실무 패턴으로 자리 잡았다.",
    whyItMatters: "회귀를 빠르게 발견한다.",
    howDevelopersUseIt: "구현과 검토를 분리한다.",
    howToApply: "완료 조건에 테스트를 추가한다.",
    claimIds: [],
    entityIds: [],
    trend: null,
    sourceRefs: [
      {
        documentId: "doc_000000000000000000000001",
        title: "Source",
        url: "https://example.com",
        sourceId: "manual-json",
        publishedAt: null,
      },
    ],
    rankingTrace: { policyId: "manual", policyVersion: "0", score: 5, reasons: ["manual input"] },
    knowledgeType: "pattern",
    related: ["Harness Engineering", "Independent Review"],
    ...overrides,
  };
}

export function dailyBriefBody(overrides: Partial<DailyBriefBody> = {}): DailyBriefBody {
  const items = overrides.sections?.flatMap((section) => section.items) ?? [briefItem()];
  const first = items[0] ?? null;
  return {
    bodySchemaVersion: 2,
    date: "2026-09-12",
    title: DAILY_BRIEF_TITLE,
    oneMinuteSummary: ["핵심 요약"],
    sections: [{ kind: "AI_CODING", items }],
    learnOneThing: first,
    applyCandidates: first?.howToApply
      ? [{ itemId: first.id, action: first.howToApply, effort: "M", prerequisites: [] }]
      : [],
    sources: items.flatMap((item) => item.sourceRefs),
    coverage: { sourcesAttempted: ["manual-json"], sourcesFailed: [], partial: false, note: null },
    ...overrides,
  };
}

export function dailyArtifact(
  body: DailyBriefBody = dailyBriefBody(),
  overrides: Partial<Artifact<DailyBriefBody>> = {},
): Artifact<DailyBriefBody> {
  return {
    schemaVersion: 1,
    id: `art_daily_brief_${body.date}`,
    type: "DAILY_BRIEF",
    targetKey: body.date,
    revision: 1,
    contentHash: contentHashOf(body),
    status: "FINAL",
    timezone: "Asia/Seoul",
    window: { start: "2026-09-11T00:00:00.000Z", end: "2026-09-12T00:00:00.000Z" },
    body,
    inputs: {
      claimIds: [],
      documentIds: body.sources.map((source) => source.documentId),
      signalRefs: [],
      rankingPolicies: [{ id: "manual", version: "0" }],
      runId: "run_TEST",
    },
    visibility: "PRIVATE",
    createdAt: "2026-09-12T00:00:00.000Z",
    ...overrides,
  };
}
