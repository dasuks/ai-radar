/**
 * Obsidian 관리 영역 마커 (PIPELINES_AND_POLICIES.md §8, MIGRATION §3.3).
 * 쓰기는 항상 `ai-radar:`, 읽기는 레거시 `ai-coding-radar:` 도 인식한다. 순수 함수만 둔다.
 */
export type ManagedRegion = "daily" | "content" | "status" | "knowledge-updates" | `evidence:${string}`;

const PREFIXES = ["ai-radar", "ai-coding-radar"] as const;

export function startMarker(region: ManagedRegion): string {
  return `<!-- ai-radar:${region}:start -->`;
}

export function endMarker(region: ManagedRegion): string {
  return `<!-- ai-radar:${region}:end -->`;
}

export function wrapRegion(region: ManagedRegion, body: string): string {
  return `${startMarker(region)}\n${body.trim()}\n${endMarker(region)}`;
}

export interface RegionMatch {
  start: number; // index of start marker
  end: number; // index just after end marker
  inner: string;
  legacy: boolean;
}

/** 새 마커를 먼저 찾고 없으면 레거시 마커를 찾는다. */
export function findRegion(contents: string, region: ManagedRegion): RegionMatch | undefined {
  for (const prefix of PREFIXES) {
    const s = `<!-- ${prefix}:${region}:start -->`;
    const e = `<!-- ${prefix}:${region}:end -->`;
    const start = contents.indexOf(s);
    if (start < 0) continue;
    const endIdx = contents.indexOf(e, start + s.length);
    if (endIdx < 0) continue;
    return {
      start,
      end: endIdx + e.length,
      inner: contents.slice(start + s.length, endIdx),
      legacy: prefix !== "ai-radar",
    };
  }
  return undefined;
}

/** 관리 영역이 있으면 새 마커로 교체하고, 없으면 undefined. */
export function replaceRegion(contents: string, region: ManagedRegion, body: string): string | undefined {
  const match = findRegion(contents, region);
  if (!match) return undefined;
  return `${contents.slice(0, match.start)}${wrapRegion(region, body)}${contents.slice(match.end)}`;
}

/** H1 바로 뒤에 관리 영역을 삽입한다. H1이 없으면 파일 앞에 둔다. */
export function insertRegionAfterHeading(contents: string, region: ManagedRegion, body: string): string {
  const heading = contents.match(/^#\s+.+$/m);
  const block = wrapRegion(region, body);
  if (!heading || heading.index === undefined) {
    return `${block}\n\n${contents.trim()}`.trim() + "\n";
  }
  const insertAt = heading.index + heading[0].length;
  return `${contents.slice(0, insertAt)}\n\n${block}${contents.slice(insertAt)}`;
}

export function upsertRegion(contents: string, region: ManagedRegion, body: string): string {
  return replaceRegion(contents, region, body) ?? insertRegionAfterHeading(contents, region, body);
}

/** 관리 영역 본문의 hash 입력용 정규화 (줄끝·앞뒤 공백 무시). */
export function normalizeRegionText(inner: string): string {
  return inner.replace(/\r\n/g, "\n").trim();
}

/** 레거시 Daily Note(마커 없음) 판정: `# <date> ` 로 시작하고 요약 헤딩을 포함. */
export function looksLikeLegacyDailyNote(contents: string): boolean {
  return /^#\s+\d{4}-\d{2}-\d{2}\s/.test(contents) && contents.includes("## 오늘 이것만 알면 됨");
}
