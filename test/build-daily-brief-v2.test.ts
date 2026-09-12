/** BuildDailyBrief v2 (ADR-0009): 리포트 항목에서 Daily 를 만들고 섹션/목록 링크를 단다. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FakeLlmProvider } from "../src/adapters/llm/fake/index.js";
import { BuildDailyBrief } from "../src/application/briefing/build-daily-brief.js";
import type { ReportEntryIndex } from "../src/application/reporting/build-section-reports.js";
import { cultureRankingPolicyV1 } from "../src/policies/culture/v1.js";
import { practicalRankingPolicyV1 } from "../src/policies/practical/v1.js";
import type { ArtifactLink, BriefSectionKind } from "../src/domain/artifacts/daily-brief.js";
import type { ReportEntry, SectionReportBody } from "../src/domain/artifacts/section-report.js";
import type { Claim } from "../src/domain/evidence/claim.js";
import { FakeClock } from "./helpers/fake-intel-stores.js";

const COVERAGE = { sourcesAttempted: ["hackernews"], sourcesFailed: [], partial: false, note: null };

function entry(id: string, documentId: string, claimIds: string[], howToApply: string | null = "적용해 본다."): ReportEntry {
  return {
    id,
    title: `리포트 항목 ${id}`,
    importance: 4,
    narrative: ["첫 문단이다.", "둘째 문단이다."],
    evidenceQuotes: [
      { evidenceId: "evd_1", documentId, text: "근거 문장", kind: "excerpt", url: "https://example.com/a", author: null },
    ],
    claims: claimIds.map((claimId) => ({
      claimId,
      type: "FACT" as const,
      statement: `${claimId} 문장`,
      sentiment: "NEUTRAL" as const,
      confidence: 0.8,
    })),
    communityReaction: null,
    entities: [{ entityId: "ent_1", name: "Tool", type: "TOOL" }],
    whyItMatters: "리포트가 설명한 중요성이다.",
    howToApply,
    counterpoints: [],
    openQuestions: [],
    sourceRefs: [
      { documentId, title: "원문", url: "https://example.com/a", sourceId: "hackernews", publishedAt: "2026-09-12T03:00:00.000Z" },
    ],
    evidenceLevel: "FULL",
  };
}

function report(section: BriefSectionKind, entries: ReportEntry[]): SectionReportBody {
  return {
    bodySchemaVersion: 1,
    date: "2026-09-12",
    section,
    title: `${section} 리포트`,
    overview: [`${section} 개요 문장이다.`, "두 번째 문장."],
    entries,
    sources: entries.flatMap((item) => item.sourceRefs),
    excluded: [],
    coverage: COVERAGE,
  };
}

function claim(id: string): Claim {
  return {
    schemaVersion: 1,
    id,
    type: "FACT",
    statement: `${id} 문장`,
    statementLanguage: "ko",
    subjectEntityIds: [],
    evidenceIds: ["evd_1"],
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

function writer(options: { skip?: (itemId: string) => boolean } = {}): FakeLlmProvider {
  return new FakeLlmProvider({
    WRITE_BRIEF_KO: (req) => ({
      items: req.untrusted
        .filter((block) => !options.skip?.(block.id))
        .map((block, index) => ({
          itemId: block.id,
          title: `짧은 제목 ${index + 1}`,
          whatChanged: "무엇이 바뀌었는지 두 문장으로 적는다. 두 번째 문장이다.",
          whyItMatters: "왜 중요한지 두 문장으로 적는다. 두 번째 문장이다.",
          howDevelopersUseIt: "이렇게 쓴다.",
          // v2 는 howToApply 를 리포트 항목에서 복사하므로 LLM 이 주는 값은 무시된다.
          howToApply: "LLM 이 만든 적용법",
          importance: 5,
          claimIds: [...block.text.matchAll(/claim id="(clm_[^"]+)"/g)].map((match) => match[1]!),
        })),
    }),
  });
}

const ENTRY_A = entry("item_a", "doc_a", ["clm_a1", "clm_a2"]);
const ENTRY_B = entry("item_b", "doc_b", ["clm_b1"], null);

function baseInput(overrides: Record<string, unknown> = {}) {
  const entryIndex: ReportEntryIndex = new Map([
    ["item_a", { sections: ["AI_CODING" as BriefSectionKind, "CULTURE" as BriefSectionKind], entry: ENTRY_A }],
    ["item_b", { sections: ["CULTURE" as BriefSectionKind], entry: ENTRY_B }],
  ]);
  const reportLinks = new Map<BriefSectionKind, ArtifactLink>([
    ["AI_CODING", { artifactId: "art_section_report_2026-09-12:AI_CODING", externalUrl: "https://notion.so/ai-coding" }],
    ["CULTURE", { artifactId: "art_section_report_2026-09-12:CULTURE", externalUrl: null }],
  ]);
  return {
    date: "2026-09-12",
    window: { start: "2026-09-11T15:00:00.000Z", end: "2026-09-12T15:00:00.000Z" },
    timezone: "Asia/Seoul",
    runId: "run_1",
    clusters: [],
    classifications: [],
    claimsByDocument: { doc_a: [claim("clm_a1"), claim("clm_a2")], doc_b: [claim("clm_b1")] } as Record<string, Claim[]>,
    entities: [],
    coverage: COVERAGE,
    sectionReports: [report("AI_CODING", [ENTRY_A]), report("CULTURE", [ENTRY_A, ENTRY_B])],
    entryIndex,
    reportLinks,
    digestLink: { artifactId: "art_daily_digest_2026-09-12", externalUrl: "https://notion.so/digest" } as ArtifactLink,
    ...overrides,
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

describe("BuildDailyBrief v2 (리포트 기반)", () => {
  test("item 은 리포트 항목의 id 를 그대로 쓰고 한 섹션에만 들어간다", async () => {
    const llm = writer();
    const result = await new BuildDailyBrief(deps(llm)).execute(baseInput());
    const ids = result.body.sections.flatMap((section) => section.items.map((item) => item.id));
    assert.deepEqual(ids.sort(), ["item_a", "item_b"]);
    assert.equal(new Set(ids).size, ids.length, "같은 항목이 두 섹션에 중복되지 않는다");

    const aiCoding = result.body.sections.find((section) => section.kind === "AI_CODING")!;
    assert.deepEqual(aiCoding.items.map((item) => item.id), ["item_a"], "primary 섹션(sections[0])에 실린다");
    const culture = result.body.sections.find((section) => section.kind === "CULTURE")!;
    assert.deepEqual(culture.items.map((item) => item.id), ["item_b"]);
  });

  test("WRITE_BRIEF_KO v2 를 1회 호출하고 narrative 를 입력으로 준다", async () => {
    const llm = writer();
    await new BuildDailyBrief(deps(llm)).execute(baseInput());
    const calls = llm.callsFor("WRITE_BRIEF_KO");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.req.promptVersion, "v3");
    assert.ok(calls[0]!.req.untrusted[0]!.text.includes("<narrative>"));
    assert.ok(calls[0]!.req.untrusted[0]!.text.includes("첫 문단이다."));
  });

  test("섹션 리포트 링크와 목록 링크가 본문에 들어간다", async () => {
    const result = await new BuildDailyBrief(deps(writer())).execute(baseInput());
    const aiCoding = result.body.sections.find((section) => section.kind === "AI_CODING")!;
    assert.deepEqual(aiCoding.report, {
      artifactId: "art_section_report_2026-09-12:AI_CODING",
      externalUrl: "https://notion.so/ai-coding",
    });
    const culture = result.body.sections.find((section) => section.kind === "CULTURE")!;
    assert.equal(culture.report!.externalUrl, null, "dry-run 등으로 URL 이 없으면 null 이다");
    assert.deepEqual(result.body.digest, { artifactId: "art_daily_digest_2026-09-12", externalUrl: "https://notion.so/digest" });
  });

  test("howToApply 는 리포트 항목에서 복사하고 oneMinuteSummary 는 overview 에서 만든다", async () => {
    const result = await new BuildDailyBrief(deps(writer())).execute(baseInput());
    const itemA = result.body.sections.flatMap((s) => s.items).find((item) => item.id === "item_a")!;
    assert.equal(itemA.howToApply, "적용해 본다.");
    const itemB = result.body.sections.flatMap((s) => s.items).find((item) => item.id === "item_b")!;
    assert.equal(itemB.howToApply, null);
    assert.deepEqual(result.body.oneMinuteSummary, ["AI_CODING 개요 문장이다.", "CULTURE 개요 문장이다."]);
    assert.deepEqual(result.body.applyCandidates.map((candidate) => candidate.itemId), ["item_a"]);
  });

  test("항목이 없는 섹션은 생략한다", async () => {
    const entryIndex: ReportEntryIndex = new Map([
      ["item_a", { sections: ["AI_CODING" as BriefSectionKind], entry: ENTRY_A }],
    ]);
    const result = await new BuildDailyBrief(deps(writer())).execute(
      baseInput({ entryIndex, sectionReports: [report("AI_CODING", [ENTRY_A]), report("CULTURE", [ENTRY_A])] }),
    );
    assert.deepEqual(result.body.sections.map((section) => section.kind), ["AI_CODING"]);
    assert.ok(result.notes.some((note) => note.includes("CULTURE")));
  });

  test("LLM 이 항목을 건너뛰어도 리포트 문장으로 남긴다", async () => {
    const result = await new BuildDailyBrief(deps(writer({ skip: (id) => id === "item_b" }))).execute(baseInput());
    const itemB = result.body.sections.flatMap((s) => s.items).find((item) => item.id === "item_b")!;
    assert.equal(itemB.whatChanged, "첫 문단이다.");
    assert.equal(itemB.whyItMatters, "리포트가 설명한 중요성이다.");
    assert.equal(itemB.claimIds.length, 1);
  });

  test("리포트가 없으면 기존 랭킹 경로를 그대로 쓴다", async () => {
    const llm = writer();
    const result = await new BuildDailyBrief(deps(llm)).execute(
      baseInput({ sectionReports: [], entryIndex: undefined, reportLinks: undefined, digestLink: null }),
    );
    assert.deepEqual(result.body.sections, []);
    assert.equal(result.body.digest, null);
    assert.equal(llm.callCount, 0, "cluster 가 없으면 LLM 을 부르지 않는다");
  });
});
