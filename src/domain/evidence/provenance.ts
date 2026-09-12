/** CONTRACTS_AND_DATA.md §0.3 */
export interface Provenance {
  method: "RULE" | "LLM" | "HUMAN" | "DERIVED";
  policyId?: string;
  policyVersion?: string;
  promptId?: string;
  promptVersion?: string;
  model?: string;
  provider?: string;
  runId: string;
  createdAt: string;
}
