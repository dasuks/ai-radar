/** Hacker News Firebase API (https://github.com/HackerNews/API) 의 item 모양. */
export interface HnItem {
  id: number;
  type?: string | undefined;
  by?: string | undefined;
  time?: number | undefined;
  title?: string | undefined;
  text?: string | undefined;
  url?: string | undefined;
  score?: number | undefined;
  descendants?: number | undefined;
  kids?: number[] | undefined;
  parent?: number | undefined;
  deleted?: boolean | undefined;
  dead?: boolean | undefined;
}

/** RawObservation.payloadRef 에 inline 으로 들어가는 payload. */
export interface HnPayload {
  item: HnItem;
  comments: HnItem[];
}

export const HN_SOURCE_ID = "hackernews";
export const HN_NORMALIZER_VERSION = "hackernews@1";

export function hnDiscussionUrl(id: number): string {
  return `https://news.ycombinator.com/item?id=${id}`;
}

export function hnUserUrl(by: string): string {
  return `https://news.ycombinator.com/user?id=${encodeURIComponent(by)}`;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 외부 JSON → HnItem. 알 수 없는 모양이면 null (adapter 가 PARSE 로 처리). */
export function toHnItem(value: unknown): HnItem | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = asNumber(raw.id);
  if (id === undefined) return null;
  const kids = Array.isArray(raw.kids) ? raw.kids.filter((k): k is number => typeof k === "number") : undefined;
  const item: HnItem = { id };
  const type = asString(raw.type);
  if (type !== undefined) item.type = type;
  const by = asString(raw.by);
  if (by !== undefined) item.by = by;
  const time = asNumber(raw.time);
  if (time !== undefined) item.time = time;
  const title = asString(raw.title);
  if (title !== undefined) item.title = title;
  const text = asString(raw.text);
  if (text !== undefined) item.text = text;
  const url = asString(raw.url);
  if (url !== undefined) item.url = url;
  const score = asNumber(raw.score);
  if (score !== undefined) item.score = score;
  const descendants = asNumber(raw.descendants);
  if (descendants !== undefined) item.descendants = descendants;
  if (kids !== undefined) item.kids = kids;
  const parent = asNumber(raw.parent);
  if (parent !== undefined) item.parent = parent;
  if (raw.deleted === true) item.deleted = true;
  if (raw.dead === true) item.dead = true;
  return item;
}

/** unix seconds → ISO 8601. 없으면 null (publishedAt 을 fetchedAt 으로 채우지 않는다). */
export function unixSecondsToIso(seconds: number | undefined): string | null {
  if (seconds === undefined || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}
