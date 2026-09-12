import { EDITORIAL_CATEGORIES } from "../../../domain/evidence/analysis.js";
import { SHARED_RULES, type PromptTemplate } from "./prompt-template.js";

export const CLASSIFY_AUDIENCES = ["PRACTITIONER", "GENERAL", "RESEARCH"] as const;

const SYSTEM = [
  "You are the editorial classifier of AI Radar, a personal AI intelligence platform.",
  "For every document block you receive, decide which editorial categories it belongs to and who the audience is.",
  "",
  SHARED_RULES,
  "",
  "Category meaning:",
  "- CULTURE: industry news, people, companies, funding, discourse, policy.",
  "- AI_CODING: coding assistants, IDE and CLI agents, code generation practice.",
  "- LLM: models, model releases, capabilities, training, inference.",
  "- AGENT_ENGINEERING: agent architectures, tool use, MCP, orchestration, memory.",
  "- EVALS_RELIABILITY: evaluation, benchmarks, testing, guardrails, safety engineering.",
  "- AI_ECONOMICS: pricing, cost, market and business impact of AI.",
  "- OTHER: none of the above.",
  "",
  "Output shape:",
  '{ "items": [ { "documentId": "doc_...", "categories": [ { "category": "AI_CODING", "confidence": 0.0 } ], "audience": "PRACTITIONER" } ] }',
  "",
  "- documentId must be copied exactly from the id attribute of the document block.",
  "- Emit at most one item per document and at most 3 categories per item, most relevant first.",
  "- confidence is your own certainty between 0 and 1. Do not derive it from numbers in the text.",
  "- Any free text you produce must be Korean, but this task has no free text fields.",
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
        required: ["documentId", "categories", "audience"],
        properties: {
          documentId: { type: "string" },
          categories: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["category", "confidence"],
              properties: {
                category: { type: "string", enum: [...EDITORIAL_CATEGORIES] },
                confidence: { type: "number" },
              },
            },
          },
          audience: { type: "string", enum: [...CLASSIFY_AUDIENCES] },
        },
      },
    },
  },
};

export const CLASSIFY_PROMPT: PromptTemplate = {
  promptId: "classify",
  promptVersion: "v1",
  system: SYSTEM,
  outputSchema: OUTPUT_SCHEMA,
  maxOutputTokens: 4000,
  temperature: 0,
};

/** `putClassification(classification, policyVersion)` 에 쓰는 값. */
export const CLASSIFY_POLICY_VERSION = `${CLASSIFY_PROMPT.promptId}.${CLASSIFY_PROMPT.promptVersion}`;
