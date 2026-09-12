/** analyze Use Case 공용 순수 헬퍼. */
import type { NormalizedDocument } from "../../domain/documents/normalized-document.js";
import type { AnalysisTask } from "../../domain/evidence/analysis.js";
import type { Claim } from "../../domain/evidence/claim.js";
import type { Provenance } from "../../domain/evidence/provenance.js";
import { hashParts } from "../../domain/shared/ids.js";
import type { LlmResponse } from "../../ports/llm/llm-provider.js";
import type { AnalyzeUsageEntry } from "./analyze-summary.js";
import type { ExtractClaimsResult } from "./extract-claims.js";

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  const step = Math.max(1, size);
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

/** PIPELINES §5.4 — (task, promptVersion, model, hash(input)) */
export function analysisCacheKey(task: AnalysisTask, promptVersion: string, model: string, inputHash: string): string {
  return hashParts(task, promptVersion, model, inputHash);
}

/** 입력 문서 집합의 해시. 같은 문서라도 새 관측(latestObservationId)이면 다시 분석한다. */
export function documentInputHash(documents: readonly NormalizedDocument[], extra: readonly string[] = []): string {
  const parts: string[] = [];
  for (const document of documents) parts.push(document.id, document.latestObservationId);
  for (const value of extra) parts.push(value);
  return hashParts(...parts);
}

export function llmProvenance(input: {
  promptId: string;
  promptVersion: string;
  model: string;
  provider: string;
  runId: string;
  createdAt: string;
}): Provenance {
  return {
    method: "LLM",
    promptId: input.promptId,
    promptVersion: input.promptVersion,
    model: input.model,
    provider: input.provider,
    runId: input.runId,
    createdAt: input.createdAt,
  };
}

export function rulePolicyProvenance(input: {
  policyId: string;
  policyVersion: string;
  runId: string;
  createdAt: string;
}): Provenance {
  return {
    method: "RULE",
    policyId: input.policyId,
    policyVersion: input.policyVersion,
    runId: input.runId,
    createdAt: input.createdAt,
  };
}

export function usageEntry(response: LlmResponse): AnalyzeUsageEntry {
  return {
    provider: response.provider,
    model: response.model,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    costUsd: response.usage.costUsd,
  };
}

/** LLM 에 보여줄 문서 요약 블록 (비신뢰 텍스트). */
export function documentDigest(document: NormalizedDocument, maxContentChars: number): string {
  const lines = [`title: ${document.title}`, `source: ${document.sourceId}`];
  if (document.tags.length > 0) lines.push(`tags: ${document.tags.slice(0, 8).join(", ")}`);
  if (document.publishedAt) lines.push(`publishedAt: ${document.publishedAt}`);
  lines.push(`completeness: ${document.contentCompleteness}`);
  if (document.content) lines.push("", truncate(document.content, maxContentChars));
  return lines.join("\n");
}

/** 오류 메시지에서 비신뢰 본문이 새지 않도록 앞부분만 남긴다. */
export function errorSummary(error: unknown): string {
  if (error instanceof Error) return truncate(`${error.name}: ${error.message}`, 200);
  return "unknown error";
}

export function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * ExtractClaims 결과를 documentId → Claim[] 로 뒤집는다.
 *
 * 한 claim 은 (a) 그 문서에서 확정된 subject entity 를 가졌거나
 * (b) 그 문서의 evidence 를 인용했을 때 해당 문서에 붙는다.
 */
export function claimsByDocument(result: ExtractClaimsResult): Record<string, Claim[]> {
  const byDocument: Record<string, Claim[]> = {};
  for (const claim of result.claims) {
    const documentIds = new Set<string>();
    for (const [documentId, entityIds] of Object.entries(result.entityIdsByDocument)) {
      if (entityIds.some((id) => claim.subjectEntityIds.includes(id))) documentIds.add(documentId);
    }
    const evidenceDocuments = result.evidence
      .filter((item) => claim.evidenceIds.includes(item.id))
      .map((item) => item.documentId);
    for (const documentId of [...documentIds, ...evidenceDocuments]) (byDocument[documentId] ??= []).push(claim);
  }
  return byDocument;
}
