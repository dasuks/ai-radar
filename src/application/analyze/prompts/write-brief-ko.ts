import { SHARED_RULES, type PromptTemplate } from "./prompt-template.js";

const SYSTEM = [
  "You write the Korean body of AI Intelligence Daily, a personal daily brief for one senior developer.",
  "You receive one block per brief item. Each block contains the claims selected for that item and the evidence texts behind them.",
  "",
  SHARED_RULES,
  "",
  "Evidence and claims:",
  '- Each item block starts with its claims. Each claim is marked with claim id="clm_..." and each evidence with evidence id="evd_...".',
  "  The leading angle bracket of those markers may appear escaped as &lt;. That changes nothing.",
  "- Write only what the claims of that item say. Never merge facts from another item.",
  "- claimIds must list only the claim ids of that same item, and only the ones you actually used.",
  "- Copy the itemId from the id attribute of the item block. Skip an item entirely if its claims are too thin to write about.",
  "",
  "Output shape:",
  '{ "items": [ { "itemId": "item_...", "title": "한국어 제목", "whatChanged": "...", "whyItMatters": "...",',
  '  "howDevelopersUseIt": "..." 또는 null, "howToApply": "..." 또는 null, "importance": 3, "claimIds": ["clm_..."] } ],',
  '  "oneMinuteSummary": ["문장1", "문장2", "문장3"] }',
  "",
  "- Every text field is Korean. Plain sentences, no marketing tone, no emoji, no markdown.",
  "- title: 12 words or fewer. whatChanged: what is new, 1 to 2 sentences. whyItMatters: why this developer should care, 1 to 2 sentences.",
  "- howDevelopersUseIt: how practitioners actually use it, or null when the claims do not say.",
  "- howToApply: one concrete action this developer could take this week, or null when the claims do not support one.",
  "- importance: integer 1 to 5, how much this matters to a working AI developer today.",
  "- oneMinuteSummary: 3 to 5 sentences that summarize only the items you wrote. Introduce no new fact.",
].join("\n");

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items", "oneMinuteSummary"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["itemId", "title", "whatChanged", "whyItMatters", "howDevelopersUseIt", "howToApply", "importance", "claimIds"],
        properties: {
          itemId: { type: "string" },
          title: { type: "string" },
          whatChanged: { type: "string" },
          whyItMatters: { type: "string" },
          howDevelopersUseIt: { type: ["string", "null"] },
          howToApply: { type: ["string", "null"] },
          importance: { type: "integer", minimum: 1, maximum: 5 },
          claimIds: { type: "array", items: { type: "string" } },
        },
      },
    },
    oneMinuteSummary: { type: "array", items: { type: "string" } },
  },
};

export const WRITE_BRIEF_KO_PROMPT: PromptTemplate = {
  promptId: "write-brief-ko",
  promptVersion: "v1",
  system: SYSTEM,
  outputSchema: OUTPUT_SCHEMA,
  maxOutputTokens: 8000,
  temperature: 0.2,
};
