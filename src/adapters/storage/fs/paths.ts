/**
 * 파일 경로 세그먼트 정규화.
 * 저장소 경로에 외부에서 온 문자열(sourceId, targetKey)이 들어가므로
 * 디렉터리 탈출과 Windows 금지 문자를 제거한다.
 */

const WINDOWS_RESERVED = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

/** 한 경로 세그먼트를 안전한 형태로 바꾼다. `..` 와 구분자, `:` 는 `_` 가 된다. */
export function sanitizeSegment(value: string): string {
  let out = "";
  for (const char of value.normalize("NFKC")) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      out += "_";
      continue;
    }
    if (char === "/" || char === "\\" || char === ":" || char === "*" || char === "?") {
      out += "_";
      continue;
    }
    if (char === '"' || char === "<" || char === ">" || char === "|") {
      out += "_";
      continue;
    }
    out += char;
  }
  out = out.trim().replace(/[. ]+$/u, "");
  if (out === "" || out === "." || out === "..") return "_";
  if (WINDOWS_RESERVED.has(out.toLowerCase())) return `${out}_`;
  return out;
}

/** ISO 시각에서 `yyyy-mm` 버킷을 만든다. 파싱 실패는 `unknown` 버킷. */
export function monthBucket(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "unknown";
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
