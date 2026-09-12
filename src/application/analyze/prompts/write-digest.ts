/**
 * WRITE_DIGEST v1 — 오늘 들어온 이야기 전부의 한 줄 제목 + 1~3줄 사실 요약.
 * 버려지는 이야기가 없어야 하므로, 모델이 빠뜨린 story 는 호출자가 결정적 fallback 으로 채운다.
 */
import { SHARED_RULES, type PromptTemplate } from "./prompt-template.js";
import { KOREAN_STYLE_RULES } from "./korean-style.js";

/** 한 호출에 넣는 story 최대 개수. */
export const DIGEST_BATCH_SIZE = 20;

const SYSTEM = [
  "You write the Korean one-line index of AI Intelligence Daily: every story collected today, in one short entry each.",
  "You receive one block per story. A block contains the original title, the source, and whatever text was collected",
  "(sometimes the full article, sometimes only the title, sometimes a few extracted claims).",
  "",
  SHARED_RULES,
  "",
  KOREAN_STYLE_RULES,
  "",
  "Ids:",
  '- Copy the documentId from the id attribute of the story block. Emit one output entry for every block you were given.',
  "- Never merge two stories into one entry and never split one story into two.",
  "",
  "Output shape:",
  '{ "stories": [ { "documentId": "doc_...", "titleKo": "한국어 한 줄 제목", "summary": "1~3문장 사실 요약", "importance": 3 } ] }',
  "",
  "- titleKo: Korean, one line, 15 words or fewer. Keep product, model and company names in their original spelling.",
  "- summary: 1 to 3 Korean sentences stating only what the provided text says.",
  '  When the block has nothing but a title, write exactly "제목만 수집됨. 원문을 확인해야 내용을 알 수 있습니다."',
  "- importance: integer 1 to 5, how much this matters to a working AI developer today.",
  "- No marketing tone, no emoji, no markdown.",
].join("\n");

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["stories"],
  properties: {
    stories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["documentId", "titleKo", "summary", "importance"],
        properties: {
          documentId: { type: "string" },
          titleKo: { type: "string" },
          summary: { type: "string" },
          importance: { type: "integer", minimum: 1, maximum: 5 },
        },
      },
    },
  },
};

export const WRITE_DIGEST_PROMPT: PromptTemplate = {
  promptId: "write-digest",
  promptVersion: "v2",
  system: SYSTEM,
  outputSchema: OUTPUT_SCHEMA,
  maxOutputTokens: 8000,
  temperature: 0.1,
};

/** LLM 이 빠뜨렸을 때 쓰는 고정 문구. */
export const DIGEST_TITLE_ONLY_SUMMARY = "제목만 수집됨. 원문을 확인해야 내용을 알 수 있습니다.";
