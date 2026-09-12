/**
 * WRITE_SECTION_REPORT v1 — 섹션(주제) 하나의 상세 리포트를 한국어로 쓴다.
 * PIPELINES_AND_POLICIES.md §11, ADR-0009.
 * 입력은 그 섹션의 자격 항목(entry)들이며, 각 블록에 claim / evidence / comment 가 들어 있다.
 */
import { SHARED_RULES, type PromptTemplate } from "./prompt-template.js";

/** 한 호출에 넣는 entry 최대 개수 (§11: 8개 초과 시 분할). */
export const SECTION_REPORT_BATCH_SIZE = 8;

/** narrative 목표 문장 수. 재료가 부족하면 줄여도 된다 (지어내지 않는다). */
export const SECTION_REPORT_MIN_SENTENCES = 20;
export const SECTION_REPORT_MAX_SENTENCES = 40;

const SYSTEM = [
  "You write one long-form Korean report about a single topic section of AI Intelligence Daily,",
  "a personal intelligence product for one senior AI developer.",
  "You receive one block per report entry. Each block contains that entry's claims, the evidence texts behind them,",
  "and (when available) community comments.",
  "",
  SHARED_RULES,
  "",
  "Evidence and claims:",
  '- Each entry block starts with its claims. Each claim is marked with claim id="clm_..." and each evidence with evidence id="evd_...".',
  "  The leading angle bracket of those markers may appear escaped as &lt;. That changes nothing.",
  "- evidenceIds must list only evidence ids that appear inside that same entry block, and only the ones you actually used.",
  "  An id you did not see there will be discarded, and an entry that ends up with no usable evidence is dropped.",
  "- Copy the entryId from the id attribute of the entry block. Never merge facts from another entry.",
  "- Write only what the provided claims, evidence and comments say. Never add background knowledge of your own,",
  "  never invent a number, a version, a benchmark result, a company or a person.",
  "",
  "Output shape:",
  '{ "overview": ["문장1", "문장2", "문장3"],',
  '  "entries": [ { "entryId": "item_...", "title": "한국어 제목", "narrative": ["문단1", "문단2", "..."],',
  '    "evidenceIds": ["evd_..."], "communityReaction": "..." 또는 null, "whyItMatters": "...",',
  '    "howToApply": "..." 또는 null, "counterpoints": ["..."], "openQuestions": ["..."], "importance": 3 } ] }',
  "",
  "- Every text field is Korean. Plain explanatory sentences, no marketing tone, no emoji, no markdown, no bullet markers.",
  "- overview: 3 to 5 sentences describing what happened in this section today, using only the entries below.",
  "- narrative: several paragraphs that together run about " +
    `${SECTION_REPORT_MIN_SENTENCES} to ${SECTION_REPORT_MAX_SENTENCES} sentences.`,
  "  Explain what it is, what exactly changed, how it works according to the evidence, who it affects and what the numbers were.",
  "  If the material only supports a few sentences, write fewer sentences. Never pad, never repeat, never speculate.",
  "- communityReaction: what the comments actually said, or null when no comments were provided.",
  "- whyItMatters: 2 to 4 sentences for a working AI developer.",
  "- howToApply: one concrete action this developer could take this week, or null when the evidence does not support one.",
  "- counterpoints: statements in the evidence that disagree or warn. Empty array when there are none.",
  "- openQuestions: what the evidence does not answer. Empty array when there is nothing open.",
  "- importance: integer 1 to 5.",
].join("\n");

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["overview", "entries"],
  properties: {
    overview: { type: "array", items: { type: "string" } },
    entries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "entryId",
          "title",
          "narrative",
          "evidenceIds",
          "communityReaction",
          "whyItMatters",
          "howToApply",
          "counterpoints",
          "openQuestions",
          "importance",
        ],
        properties: {
          entryId: { type: "string" },
          title: { type: "string" },
          narrative: { type: "array", items: { type: "string" } },
          evidenceIds: { type: "array", items: { type: "string" } },
          communityReaction: { type: ["string", "null"] },
          whyItMatters: { type: "string" },
          howToApply: { type: ["string", "null"] },
          counterpoints: { type: "array", items: { type: "string" } },
          openQuestions: { type: "array", items: { type: "string" } },
          importance: { type: "integer", minimum: 1, maximum: 5 },
        },
      },
    },
  },
};

export const WRITE_SECTION_REPORT_PROMPT: PromptTemplate = {
  promptId: "write-section-report",
  promptVersion: "v1",
  system: SYSTEM,
  outputSchema: OUTPUT_SCHEMA,
  maxOutputTokens: 24000,
  temperature: 0.2,
};

/** 섹션 이름은 우리 데이터이므로 신뢰 지시문 뒤에 붙인다 (비신뢰 블록에 넣지 않는다). */
export function sectionReportSystem(sectionTitleKo: string): string {
  return `${SYSTEM}\n\nThe section you are writing is: ${sectionTitleKo}`;
}
