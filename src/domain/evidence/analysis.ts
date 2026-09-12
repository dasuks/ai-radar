import type { Provenance } from "./provenance.js";

export const ANALYSIS_TASKS = [
  "CLASSIFY",
  "EXTRACT_ENTITIES",
  "EXTRACT_CLAIMS",
  "LINK_STORIES",
  "SYNTHESIZE",
  "WRITE_BRIEF_KO",
  "PROPOSE_KNOWLEDGE",
] as const;
export type AnalysisTask = (typeof ANALYSIS_TASKS)[number];

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs: number;
}

/** CONTRACTS_AND_DATA.md §4.3 */
export interface AnalysisRecord {
  schemaVersion: 1;
  id: string;
  task: AnalysisTask;
  inputDocumentIds: string[];
  inputEvidenceIds: string[];
  provenance: Provenance;
  usage: LlmUsage | null;
  outputHash: string;
  validation: { schemaOk: boolean; evidenceOk: boolean; rejectedItems: number; notes: string[] };
  status: "SUCCEEDED" | "FAILED" | "PARTIAL";
  /** 캐시 키: (task, promptVersion, model, hash(input)) */
  cacheKey: string;
}

export const EDITORIAL_CATEGORIES = [
  "CULTURE",
  "AI_CODING",
  "LLM",
  "AGENT_ENGINEERING",
  "EVALS_RELIABILITY",
  "AI_ECONOMICS",
  "OTHER",
] as const;
export type EditorialCategory = (typeof EDITORIAL_CATEGORIES)[number];

export interface Classification {
  documentId: string;
  categories: { category: EditorialCategory; confidence: number }[];
  audience: "PRACTITIONER" | "GENERAL" | "RESEARCH";
  provenance: Provenance;
}
