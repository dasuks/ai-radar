import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** JSON 파일을 읽는다. 없으면 null. */
export async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return JSON.parse(contents) as T;
}

/** 원자적에 가깝게 쓴다 (temp → rename). 같은 디렉터리 안에서만 rename 하므로 볼륨 경계 문제가 없다. */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, filePath);
}

export async function appendLine(filePath: string, line: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${line}\n`, { encoding: "utf8", flag: "a" });
}

/** 파일 이름에 쓸 수 없는 문자를 제거한다 (targetKey, artifactId 등은 보통 이미 안전하다). */
export function safeSegment(value: string): string {
  const cleaned = value
    .split("")
    .map((ch) => (/[<>:"/\\|?*]/.test(ch) || ch.charCodeAt(0) < 0x20 ? "_" : ch))
    .join("")
    .replace(/[. ]+$/g, "");
  return cleaned || "_";
}

export function segmentsToPath(root: string, ...segments: string[]): string {
  return join(root, ...segments.map(safeSegment));
}

/**
 * 수동 입력 JSON 을 읽는다. 오류 메시지에 파일 경로를 포함한다 (레거시 briefing-loader 규칙).
 * `RunDailyPipeline` 의 manual BriefSource 가 주입받는 reader 구현이다.
 */
export async function readJsonFile(filePath: string): Promise<unknown> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Daily Brief file could not be read (${filePath}): ${message}`);
  }
  try {
    return JSON.parse(contents) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Daily Brief contains malformed JSON (${filePath}): ${message}`);
  }
}
