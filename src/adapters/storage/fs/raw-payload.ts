import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PayloadRef, RawObservation } from "../../../domain/documents/raw-observation.js";
import { canonicalJson } from "../../../domain/shared/ids.js";
import { monthBucket, sanitizeSegment } from "./paths.js";

/** CONTRACTS_AND_DATA.md §7.2 — `<root>/raw/<sourceId>/<yyyy-mm>/<obsId>.json` */
export function rawPayloadPath(root: string, observation: RawObservation): string {
  return path.resolve(
    root,
    "raw",
    sanitizeSegment(observation.sourceId),
    monthBucket(observation.fetchedAt),
    `${sanitizeSegment(observation.id)}.json`,
  );
}

export interface WrittenPayload {
  path: string;
  bytes: number;
  /** 같은 id 파일이 이미 있어 새로 쓰지 않았으면 false */
  created: boolean;
}

/**
 * Raw payload 를 파일로 쓴다. observation id 는 payload hash 를 포함하므로
 * 같은 id 의 파일은 같은 내용이다. 따라서 이미 있으면 덮어쓰지 않고 그대로 쓴다.
 */
export async function writeRawPayload(
  root: string,
  observation: RawObservation,
  payload: unknown,
): Promise<WrittenPayload> {
  const target = rawPayloadPath(root, observation);
  const existing = await statOrNull(target);
  if (existing !== null) return { path: target, bytes: existing, created: false };
  const text = canonicalJson(payload);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
  return { path: target, bytes: Buffer.byteLength(text, "utf8"), created: true };
}

export async function readRawPayload(filePath: string): Promise<unknown> {
  const text = await readFile(filePath, "utf8");
  return JSON.parse(text) as unknown;
}

/** 기본 inline 한계 (CONTRACTS_AND_DATA.md §1.1: 32KB) */
export const DEFAULT_INLINE_LIMIT_BYTES = 32_768;

/**
 * payload 크기를 보고 inline 또는 file PayloadRef 를 만든다.
 * inline/file 결정은 호출자의 한계값이 정하며, 이 함수는 파일 쓰기만 책임진다.
 */
export async function toPayloadRef(
  root: string,
  observation: RawObservation,
  payload: unknown,
  inlineLimitBytes: number = DEFAULT_INLINE_LIMIT_BYTES,
): Promise<PayloadRef> {
  const text = canonicalJson(payload);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= inlineLimitBytes) return { kind: "inline", json: payload };
  const written = await writeRawPayload(root, observation, payload);
  return { kind: "file", path: written.path, bytes: written.bytes, encoding: "json" };
}

async function statOrNull(target: string): Promise<number | null> {
  try {
    const info = await stat(target);
    return info.size;
  } catch {
    return null;
  }
}
