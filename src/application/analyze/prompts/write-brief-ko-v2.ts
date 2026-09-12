/**
 * WRITE_BRIEF_KO v2 — Daily 는 섹션 리포트 위의 짧은 층이다.
 * 입력은 raw claim 이 아니라 이미 작성된 리포트 항목의 narrative 다 (같은 claim 을 두 번 요약하지 않는다).
 * oneMinuteSummary 는 섹션 overview 에서 결정적으로 만들므로 이 prompt 의 출력이 아니다.
 */
import { SHARED_RULES, type PromptTemplate } from "./prompt-template.js";

const SYSTEM = [
  "You write the short Korean layer of AI Intelligence Daily for one senior AI developer.",
  "Each block is one report entry that has already been written in long form. It contains that entry's narrative,",
  "why it matters, and the claim ids the narrative was built from.",
  "Your job is to compress it, not to research it.",
  "",
  SHARED_RULES,
  "",
  "Ids:",
  '- Copy the itemId from the id attribute of the entry block. Each claim is marked with claim id="clm_...".',
  "- claimIds must list only claim ids from that same block. Skip an entry only when its block is empty.",
  "",
  "Output shape:",
  '{ "items": [ { "itemId": "item_...", "title": "한국어 제목", "whatChanged": "...", "whyItMatters": "...",',
  '  "howDevelopersUseIt": "..." 또는 null, "importance": 3, "claimIds": ["clm_..."] } ] }',
  "",
  "- Every text field is Korean. Plain sentences, no marketing tone, no emoji, no markdown.",
  "- title: 12 words or fewer.",
  "- whatChanged: 2 to 3 sentences. Only what the narrative already says.",
  "- whyItMatters: 2 to 3 sentences, addressed to a working AI developer.",
  "- howDevelopersUseIt: how practitioners actually use it, or null when the narrative does not say.",
  "- importance: integer 1 to 5.",
  "- Introduce no fact that is not already in the block.",
].join("\n");

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["itemId", "title", "whatChanged", "whyItMatters", "howDevelopersUseIt", "importance", "claimIds"],
        properties: {
          itemId: { type: "string" },
          title: { type: "string" },
          whatChanged: { type: "string" },
          whyItMatters: { type: "string" },
          howDevelopersUseIt: { type: ["string", "null"] },
          importance: { type: "integer", minimum: 1, maximum: 5 },
          claimIds: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

export const WRITE_BRIEF_KO_V2_PROMPT: PromptTemplate = {
  promptId: "write-brief-ko",
  promptVersion: "v2",
  system: SYSTEM,
  outputSchema: OUTPUT_SCHEMA,
  maxOutputTokens: 12000,
  temperature: 0.2,
};
