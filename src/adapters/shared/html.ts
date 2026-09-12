/**
 * HTML → 텍스트 변환 (결정적, 의존성 없음).
 * PIPELINES_AND_POLICIES.md §3.1: 본문 변환에 LLM을 쓰지 않는다.
 *
 * adapters/<a> 는 다른 adapter 디렉터리를 import 하지 않으므로 (AGENTS.md §3)
 * 공통 유틸은 adapters/shared/ 에 둔다 (외부 SDK 미포함).
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

/** `&amp;` `&#39;` `&#x27;` 를 문자로 되돌린다. 알 수 없는 엔티티는 그대로 둔다. */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** 태그를 제거하고 블록 경계를 줄바꿈으로 바꾼 텍스트. */
export function stripHtml(input: string): string {
  const withoutScripts = input.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ");
  const withBreaks = withoutScripts
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre)\s*>/gi, "\n");
  const withoutTags = withBreaks.replace(/<[^>]*>/g, " ");
  return decodeEntities(withoutTags)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const HREF_PATTERN = /<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))/gi;

/** 본문 HTML 안의 링크 (CONTRACTS_AND_DATA.md §1.2 `urls`). 순서 유지, 중복 제거. */
export function extractHrefs(html: string, limit = 50): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(HREF_PATTERN)) {
    const raw = match[2] ?? match[3] ?? match[4] ?? "";
    const href = decodeEntities(raw).trim();
    if (!href || !/^https?:\/\//i.test(href)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    out.push(href);
    if (out.length >= limit) break;
  }
  return out;
}
