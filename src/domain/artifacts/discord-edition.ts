import { isValidCalendarDate } from "../shared/time.js";
import { ContractValidationError, isRecord } from "../shared/validation.js";

export const DISCORD_SECTORS = ["models", "coding", "agents", "products", "infra", "evals", "culture"] as const;
export type DiscordSector = (typeof DISCORD_SECTORS)[number];
export type DiscordChannelKey = DiscordSector | "summary";
export const DISCORD_SECTOR_LABELS: Record<DiscordSector, string> = {
  models: "모델·API", coding: "코딩 도구·스킬", agents: "에이전트 엔지니어링",
  products: "AI 제품 개발", infra: "인프라·비용", evals: "평가·보안", culture: "AI 교양",
};
export interface DiscordPostV1 {
  id: string;
  sector: DiscordSector;
  title: string;
  summary: string;
  detail: string;
  example: string;
  caveat: string;
  evidenceLabel: string;
  links: { label: string; url: string }[];
}
export interface DiscordPostV2 {
  id: string;
  sector: DiscordSector;
  title: string;
  summary: string;
  detail: string;
  example: string | null;
  caveat: string | null;
  links: { label: string; url: string }[];
}
/** Legacy alias retained for existing callers and stored editions. */
export type DiscordPost = DiscordPostV1;
export type DiscordEditionBody =
  | { bodySchemaVersion: 1; date: string; posts: DiscordPostV1[] }
  | { bodySchemaVersion: 2; date: string; posts: DiscordPostV2[] };
export interface DiscordDeliveryPayload {
  date: string;
  posts: { key: string; channel: DiscordSector; title: string; summary: string; content: string }[];
}

/** Public HTTPS resource addresses only; literal IPs and local/reserved names are deliberately excluded. */
export function isPublicDiscordLink(value: string): boolean {
  if (value.length > 500 || /[\s<>\\]/u.test(value)) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") &&
      host.includes(".") && !host.includes(":") && !/^\d+(\.\d+)*$/.test(host) &&
      !/(^|\.)(localhost|local|internal|intranet|lan|home|test|invalid|example|onion)$/.test(host) &&
      !/(^|\.)(nip\.io|sslip\.io|localtest\.me|lvh\.me)$/.test(host);
  } catch { return false; }
}

function fail(message: string): never { throw new ContractValidationError("DiscordEditionBody", [message]); }
function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) fail("unexpected field");
}
function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value)) fail(`invalid ${name}`);
  return value.trim();
}
export function parseDiscordEdition(value: unknown): DiscordEditionBody {
  if (!isRecord(value)) fail("root must be an object");
  exactKeys(value, ["bodySchemaVersion", "date", "posts"]);
  if (value.bodySchemaVersion !== 1 && value.bodySchemaVersion !== 2) fail("bodySchemaVersion must be 1 or 2");
  const version = value.bodySchemaVersion;
  const date = text(value.date, "date", 10);
  if (!isValidCalendarDate(date)) fail("invalid date");
  if (!Array.isArray(value.posts) || value.posts.length > 100) fail("posts must be an array of at most 100 items");
  const seen = new Set<string>();
  const posts = value.posts.map((raw): DiscordPostV1 | DiscordPostV2 => {
    if (!isRecord(raw)) fail("post must be an object");
    exactKeys(raw, version === 1 ? ["id", "sector", "title", "summary", "detail", "example", "caveat", "evidenceLabel", "links"] : ["id", "sector", "title", "summary", "detail", "example", "caveat", "links"]);
    const id = text(raw.id, "id", 200);
    if (seen.has(id)) fail("duplicate post id");
    seen.add(id);
    if (!DISCORD_SECTORS.includes(raw.sector as DiscordSector)) fail("invalid sector");
    if (!Array.isArray(raw.links) || raw.links.length < 1 || raw.links.length > 100) fail("post requires 1–100 source links");
    const links = raw.links.map((link) => {
      if (!isRecord(link)) fail("invalid link");
      exactKeys(link, ["label", "url"]);
      const label = text(link.label, "link label", 100);
      const url = text(link.url, "link URL", 500);
      if (!isPublicDiscordLink(url)) fail("link must be a public HTTPS resource");
      return { label, url };
    });
    if (new Set(links.map((link) => link.url)).size !== links.length) fail("duplicate link");
    const fields = { title: text(raw.title, "title", 100), summary: text(raw.summary, "summary", 180), detail: text(raw.detail, "detail", 500) };
    const example = version === 1 ? text(raw.example, "example", 350) : raw.example === null ? null : text(raw.example, "example", 350);
    const caveat = version === 1 ? text(raw.caveat, "caveat", 300) : raw.caveat === null ? null : text(raw.caveat, "caveat", 300);
    const evidenceLabel = version === 1 ? text(raw.evidenceLabel, "evidenceLabel", 100) : null;
    if ([...Object.values(fields), example, caveat, evidenceLabel].some((field) => field && /https?:\/\/|www\./i.test(field))) fail("resource URLs belong in links");
    if (version === 1) return { id, sector: raw.sector as DiscordSector, ...fields, example: example!, caveat: caveat!, evidenceLabel: evidenceLabel!, links };
    return { id, sector: raw.sector as DiscordSector, ...fields, example, caveat, links };
  });
  return version === 1 ? { bodySchemaVersion: 1, date, posts: posts as DiscordPostV1[] } : { bodySchemaVersion: 2, date, posts: posts as DiscordPostV2[] };
}
