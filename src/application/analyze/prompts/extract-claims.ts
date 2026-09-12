import { CLAIM_TYPES, SENTIMENTS } from "../../../domain/evidence/claim.js";
import { SHARED_RULES, type PromptTemplate } from "./prompt-template.js";
import { KOREAN_STYLE_RULES } from "./korean-style.js";

/** SYSTEM_INFERENCE 는 signal 에서만 생기므로 LLM 에게 허용하지 않는다. */
export const EXTRACTABLE_CLAIM_TYPES = CLAIM_TYPES.filter((type) => type !== "SYSTEM_INFERENCE");

const SYSTEM = [
  "You extract claims from collected documents for AI Radar, a personal AI intelligence platform.",
  "A claim is one checkable statement that the provided evidence supports.",
  "",
  SHARED_RULES,
  "",
  KOREAN_STYLE_RULES,
  "",
  "Evidence:",
  '- Every document block contains evidence units. Each unit starts with a marker of the form evidence id="evd_..."',
  "  followed by the quoted text of that unit, and ends with a closing evidence marker.",
  "  The leading angle bracket of those markers may appear escaped as &lt;. That changes nothing.",
  "- evidenceIds must contain only ids that appear in the same document block as the claim.",
  "  A claim with an id you did not see there will be discarded.",
  "- Each claim needs at least one evidence id, and every part of the statement must be supported by that evidence.",
  "",
  "Claim types:",
  "- FACT: checkable and already happened (released, published, priced, measured).",
  "- OFFICIAL_CLAIM: the vendor or author asserts it about their own product, not verified by anyone else.",
  "- USER_EXPERIENCE: one person reports their own experience. Never generalize it to all or most users.",
  "- OPINION: a judgement or preference.",
  "- FORECAST: about the future.",
  "- RUMOR: an unconfirmed report, leak or second hand story.",
  "",
  "Output shape:",
  '{ "claims": [ { "documentId": "doc_...", "type": "FACT", "statement": "한국어 한 문장", "evidenceIds": ["evd_..."],',
  '  "subjectSurfaceForms": ["Claude Code"], "sentiment": "NEUTRAL", "confidence": 0.0 } ] }',
  "",
  "- statement must be Korean, exactly one sentence, and must not copy long spans of the source text.",
  "- Do not put any number, percentage or growth rate in the statement unless that exact number appears in the cited evidence.",
  "- subjectSurfaceForms are the product, model, company or repository names the claim is about, written as they appear in the text.",
  "  Leave the array empty if the claim is not about a named thing. Do not translate or normalize the names.",
  "- sentiment is the tone of the cited evidence text, not your judgement of the news.",
  "- Emit at most 5 claims per document. Fewer is better than weaker claims.",
].join("\n");

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["claims"],
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["documentId", "type", "statement", "evidenceIds", "subjectSurfaceForms", "sentiment", "confidence"],
        properties: {
          documentId: { type: "string" },
          type: { type: "string", enum: [...EXTRACTABLE_CLAIM_TYPES] },
          statement: { type: "string" },
          evidenceIds: { type: "array", items: { type: "string" } },
          subjectSurfaceForms: { type: "array", items: { type: "string" } },
          sentiment: { type: "string", enum: [...SENTIMENTS] },
          confidence: { type: "number" },
        },
      },
    },
  },
};

export const EXTRACT_CLAIMS_PROMPT: PromptTemplate = {
  promptId: "extract-claims",
  promptVersion: "v2",
  system: SYSTEM,
  outputSchema: OUTPUT_SCHEMA,
  maxOutputTokens: 6000,
  temperature: 0,
};
