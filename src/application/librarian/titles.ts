/**
 * Knowledge Note 제목·파일명 순수 헬퍼.
 * Vault 상대 경로는 항상 "/" 구분자를 쓰므로 node:path 를 쓰지 않는다.
 */

const ILLEGAL_FILENAME_CHARS = new Set(["<", ">", ":", '"', "/", "?", "*", "|", String.fromCharCode(92)]);
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function displayTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim() || "Untitled";
}

/** 대소문자·앞뒤 공백·하이픈·underscore·연속 공백을 무시한 비교 키. */
export function normalizeKnowledgeTitle(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ");
}

export function sanitizeKnowledgeFilename(value: string): string {
  let filename = displayTitle(value)
    .split("")
    .filter((ch) => !ILLEGAL_FILENAME_CHARS.has(ch) && ch.charCodeAt(0) >= 0x20)
    .join("")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!filename) filename = "Untitled";
  if (RESERVED_WINDOWS_NAMES.test(filename)) filename = `_${filename}`;
  return filename;
}

export function cleanWikiText(value: string): string {
  return displayTitle(value).replaceAll("[[", "").replaceAll("]]", "").replaceAll("|", "-");
}

export function wikiLink(title: string, target = sanitizeKnowledgeFilename(title)): string {
  const display = cleanWikiText(title);
  return display === target ? `[[${target}]]` : `[[${target}|${display}]]`;
}

/** vault 상대 경로에서 확장자를 뺀 파일명. */
export function noteStem(relativePath: string): string {
  const segments = relativePath.split("/");
  const last = segments[segments.length - 1] ?? relativePath;
  return last.replace(/\.md$/i, "");
}

export function joinVaultPath(...segments: string[]): string {
  return segments
    .map((segment) => segment.replace(/^\/+|\/+$/g, ""))
    .filter((segment) => segment.length > 0)
    .join("/");
}

/** H1 이 있으면 그 제목, 없으면 파일명. */
export function noteTitle(contents: string, relativePath: string): string {
  const heading = contents.match(/^#\s+(.+?)\s*$/m)?.[1];
  return displayTitle(heading ?? noteStem(relativePath));
}

export function escapeLinkLabel(value: string): string {
  return value.replaceAll("[", "\\[").replaceAll("]", "\\]");
}
