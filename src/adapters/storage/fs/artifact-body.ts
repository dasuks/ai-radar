import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../../../domain/shared/ids.js";
import { sanitizeSegment } from "./paths.js";

/**
 * Artifact body 파일 경로 (CONTRACTS_AND_DATA.md §7.2).
 * 반환값은 store dir 기준 상대 경로이며 `artifacts.body_ref` 컬럼에 들어간다.
 */
export function artifactBodyRef(type: string, targetKey: string, revision: number): string {
  return ["artifacts", sanitizeSegment(type), sanitizeSegment(targetKey), `r${revision}.json`].join("/");
}

export async function writeArtifactBody(dir: string, bodyRef: string, body: unknown): Promise<void> {
  const target = path.resolve(dir, bodyRef);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, canonicalJson(body), "utf8");
}

export async function readArtifactBody(dir: string, bodyRef: string): Promise<unknown> {
  const target = path.isAbsolute(bodyRef) ? bodyRef : path.resolve(dir, bodyRef);
  const text = await readFile(target, "utf8");
  return JSON.parse(text) as unknown;
}
