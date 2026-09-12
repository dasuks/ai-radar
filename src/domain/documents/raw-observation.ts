import { Issues, isRecord, requireBoolean, requireEnum, requireString, optionalString } from "../shared/validation.js";
import { isValidIsoDateTime } from "../shared/time.js";

export const CONTENT_COMPLETENESS = ["FULL", "EXCERPT", "TITLE_ONLY", "MISSING"] as const;
export type ContentCompleteness = (typeof CONTENT_COMPLETENESS)[number];

export const SOURCE_KINDS = ["API", "RSS", "SCRAPE", "EXTERNAL_TOOL", "MANUAL"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export type PayloadRef =
  | { kind: "inline"; json: unknown }
  | { kind: "file"; path: string; bytes: number; encoding: "json" | "html" | "text" };

export type RawMetadataValue = string | number | boolean | null;

/** CONTRACTS_AND_DATA.md §1.1 */
export interface RawObservation {
  schemaVersion: 1;
  id: string;
  sourceId: string;
  sourceKind: SourceKind;
  externalId: string;
  originalUrl: string | null;
  observedAt: string;
  observedAtIsFetchedAt: boolean;
  fetchedAt: string;
  runId: string;
  payloadHash: string;
  payloadRef: PayloadRef;
  completeness: ContentCompleteness;
  rawMetadata: Record<string, RawMetadataValue>;
}

export const RAW_OBSERVATION_SCHEMA_VERSION = 1 as const;

const FORBIDDEN_METADATA_KEYS = /(token|secret|cookie|authorization|password|api[-_]?key)/i;

export function validateRawObservation(value: unknown): RawObservation {
  const issues = new Issues("RawObservation");
  if (!isRecord(value)) {
    issues.push("root must be an object");
    issues.throwIfAny();
  }
  const obj = value as Record<string, unknown>;
  const path = "RawObservation";
  if (obj.schemaVersion !== 1) issues.push(`${path}.schemaVersion must be 1`);
  const id = requireString(obj, "id", path, issues);
  if (id && !id.startsWith("obs_")) issues.push(`${path}.id must start with obs_`);
  const sourceId = requireString(obj, "sourceId", path, issues);
  const sourceKind = requireEnum(obj, "sourceKind", SOURCE_KINDS, path, issues);
  const externalId = requireString(obj, "externalId", path, issues);
  const originalUrl = optionalString(obj, "originalUrl", path, issues);
  const observedAt = requireString(obj, "observedAt", path, issues);
  const observedAtIsFetchedAt = requireBoolean(obj, "observedAtIsFetchedAt", path, issues);
  const fetchedAt = requireString(obj, "fetchedAt", path, issues);
  if (observedAt && !isValidIsoDateTime(observedAt)) issues.push(`${path}.observedAt must be ISO 8601`);
  if (fetchedAt && !isValidIsoDateTime(fetchedAt)) issues.push(`${path}.fetchedAt must be ISO 8601`);
  const runIdValue = requireString(obj, "runId", path, issues);
  const payloadHash = requireString(obj, "payloadHash", path, issues);
  const completeness = requireEnum(obj, "completeness", CONTENT_COMPLETENESS, path, issues);
  const payloadRef = obj.payloadRef;
  if (!isRecord(payloadRef) || (payloadRef.kind !== "inline" && payloadRef.kind !== "file")) {
    issues.push(`${path}.payloadRef must be inline or file`);
  }
  const rawMetadata = obj.rawMetadata;
  const metadata: Record<string, RawMetadataValue> = {};
  if (!isRecord(rawMetadata)) {
    issues.push(`${path}.rawMetadata must be an object`);
  } else {
    for (const [key, v] of Object.entries(rawMetadata)) {
      if (FORBIDDEN_METADATA_KEYS.test(key)) issues.push(`${path}.rawMetadata.${key} looks like a secret`);
      if (v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
        issues.push(`${path}.rawMetadata.${key} must be a primitive`);
      } else {
        metadata[key] = v as RawMetadataValue;
      }
    }
  }
  issues.throwIfAny();
  return {
    schemaVersion: 1,
    id,
    sourceId,
    sourceKind,
    externalId,
    originalUrl,
    observedAt,
    observedAtIsFetchedAt,
    fetchedAt,
    runId: runIdValue,
    payloadHash,
    payloadRef: payloadRef as PayloadRef,
    completeness,
    rawMetadata: metadata,
  };
}
