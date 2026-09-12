import type { DerivedSignalRef } from "../metrics/derived-signal.js";
import type { Provenance } from "./provenance.js";

export const CLAIM_TYPES = [
  "FACT",
  "OFFICIAL_CLAIM",
  "USER_EXPERIENCE",
  "OPINION",
  "FORECAST",
  "RUMOR",
  "SYSTEM_INFERENCE",
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

export const SENTIMENTS = ["POSITIVE", "NEGATIVE", "MIXED", "NEUTRAL", "UNKNOWN"] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export type Visibility = "PRIVATE" | "PUBLIC_OK";

/** CONTRACTS_AND_DATA.md §4.2 */
export interface Claim {
  schemaVersion: 1;
  id: string;
  type: ClaimType;
  statement: string;
  statementLanguage: string;
  subjectEntityIds: string[];
  evidenceIds: string[];
  signalRefs: DerivedSignalRef[];
  confidence: number;
  sentiment: Sentiment;
  visibility: Visibility;
  status: "ACTIVE" | "SUPERSEDED" | "RETRACTED";
  supersededById: string | null;
  analysisId: string;
  provenance: Provenance;
}

const GENERALIZATION = /(모든|대부분의|대다수|전체 사용자|누구나|all users|most users|everyone)/i;

/**
 * Claim 불변 조건 (§4.2). 위반 목록을 돌려준다. 빈 배열이면 통과.
 * `knownEvidenceIds` 는 이 분석에 입력된 evidence 집합이다 (LLM 출력 검증).
 */
export function claimViolations(claim: Claim, knownEvidenceIds: ReadonlySet<string>, computedSignals: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  if (!claim.statement.trim()) out.push("statement is empty");
  if (claim.confidence < 0 || claim.confidence > 1) out.push("confidence must be within 0..1");
  if (claim.type === "SYSTEM_INFERENCE") {
    if (claim.signalRefs.length === 0) out.push("SYSTEM_INFERENCE requires signalRefs");
    for (const ref of claim.signalRefs) {
      const key = `${ref.subjectId}|${ref.key}|${ref.window.start}|${ref.window.end}`;
      if (!computedSignals.has(key)) out.push(`signal ${key} is not COMPUTED`);
    }
  } else {
    if (claim.evidenceIds.length === 0) out.push(`${claim.type} requires at least one evidence`);
    for (const id of claim.evidenceIds) {
      if (!knownEvidenceIds.has(id)) out.push(`evidence ${id} is not in the analysis input set`);
    }
  }
  if (claim.type === "USER_EXPERIENCE" && GENERALIZATION.test(claim.statement)) {
    out.push("USER_EXPERIENCE statement generalizes to all users");
  }
  return out;
}

/** 숫자·증가율이 들어간 문장은 metric evidence 또는 signal 참조가 있어야 한다 (PIPELINES §5.2 3). */
export function statementHasUnbackedNumbers(statement: string, hasMetricEvidence: boolean, hasSignal: boolean): boolean {
  const hasPercent = /\d+(\.\d+)?\s*(%|퍼센트|배)/.test(statement);
  const hasGrowth = /(증가|급증|감소|성장|delta|velocity)/i.test(statement) && /\d/.test(statement);
  return (hasPercent || hasGrowth) && !hasMetricEvidence && !hasSignal;
}
