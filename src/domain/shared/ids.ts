import { createHash, randomBytes } from "node:crypto";

/** CONTRACTS_AND_DATA.md §0.2 — 구분자 U+001F */
export const ID_SEPARATOR = "";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function hashParts(...parts: string[]): string {
  return sha256Hex(parts.join(ID_SEPARATOR));
}

/** Canonical JSON: 키를 정렬해 직렬화한다. payloadHash 계산에 쓴다. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function payloadHashOf(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}

function normalizeSourceId(sourceId: string): string {
  return sourceId.trim().toLowerCase();
}

export function observationId(sourceId: string, externalId: string, payloadHash: string): string {
  return `obs_${hashParts(normalizeSourceId(sourceId), externalId.trim(), payloadHash).slice(0, 24)}`;
}

export function documentId(sourceId: string, externalId: string): string {
  return `doc_${hashParts(normalizeSourceId(sourceId), externalId.trim()).slice(0, 24)}`;
}

export function evidenceId(docId: string, locatorKey: string): string {
  return `evd_${hashParts(docId, locatorKey).slice(0, 24)}`;
}

export function artifactId(type: string, targetKey: string): string {
  return `art_${type.toLowerCase()}_${targetKey}`;
}

export function briefItemId(artifactIdValue: string, key: string): string {
  return `item_${hashParts(artifactIdValue, key).slice(0, 16)}`;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID. Clock과 random source를 인자로 받아 테스트 결정성을 확보한다. */
export function ulid(nowMs: number, random: (bytes: number) => Uint8Array = (n) => randomBytes(n)): string {
  let time = nowMs;
  let timePart = "";
  for (let i = 0; i < 10; i += 1) {
    timePart = CROCKFORD[time % 32] + timePart;
    time = Math.floor(time / 32);
  }
  const bytes = random(16);
  let randomPart = "";
  for (let i = 0; i < 16; i += 1) {
    randomPart += CROCKFORD[(bytes[i] ?? 0) % 32];
  }
  return timePart + randomPart;
}

export function runId(nowMs: number, random?: (bytes: number) => Uint8Array): string {
  return `run_${ulid(nowMs, random)}`;
}

export function claimId(nowMs: number, random?: (bytes: number) => Uint8Array): string {
  return `clm_${ulid(nowMs, random)}`;
}

export function entityId(nowMs: number, random?: (bytes: number) => Uint8Array): string {
  return `ent_${ulid(nowMs, random)}`;
}

export function analysisId(nowMs: number, random?: (bytes: number) => Uint8Array): string {
  return `ana_${ulid(nowMs, random)}`;
}
