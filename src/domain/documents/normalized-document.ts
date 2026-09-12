import { Issues, isRecord, requireEnum, requireString, optionalString, stringArray } from "../shared/validation.js";
import { isValidIsoDateTime } from "../shared/time.js";
import { CONTENT_COMPLETENESS, type ContentCompleteness } from "./raw-observation.js";
import type { MetricKey } from "../metrics/metric-observation.js";

export interface NormalizedComment {
  externalId: string;
  author: string | null;
  content: string;
  score: number | null;
  publishedAt: string | null;
  parentExternalId: string | null;
}

export interface MetricSnapshot {
  key: MetricKey;
  value: number;
  observedAt: string;
}

export const DOCUMENT_STATUS = ["ACTIVE", "CORRECTED", "DELETED"] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUS)[number];

/** CONTRACTS_AND_DATA.md §1.2 */
export interface NormalizedDocument {
  schemaVersion: 1;
  id: string;
  sourceId: string;
  externalId: string;
  latestObservationId: string;
  firstObservationId: string;
  title: string;
  content: string | null;
  contentCompleteness: ContentCompleteness;
  author: { name: string | null; externalId: string | null; url: string | null };
  language: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  fetchedAt: string;
  canonicalUrl: string | null;
  urls: string[];
  comments: NormalizedComment[];
  metrics: MetricSnapshot[];
  tags: string[];
  status: DocumentStatus;
  provenance: { normalizerVersion: string; runId: string; normalizedAt: string };
}

const TRACKING_PARAMS = /^(utm_|ref$|ref_|fbclid|gclid|mc_cid|mc_eid|igshid|source$)/i;

/** 정규화 URL: 소문자 host, tracking param 제거, fragment 제거, trailing slash 제거. */
export function canonicalUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    const keep: [string, string][] = [];
    for (const [k, v] of url.searchParams.entries()) {
      if (!TRACKING_PARAMS.test(k)) keep.push([k, v]);
    }
    keep.sort(([a], [b]) => a.localeCompare(b));
    url.search = "";
    for (const [k, v] of keep) url.searchParams.append(k, v);
    let s = url.toString();
    if (s.endsWith("/") && url.pathname !== "/") s = s.slice(0, -1);
    if (url.pathname === "/" && !url.search) s = s.replace(/\/$/, "");
    return s;
  } catch {
    return null;
  }
}

export function validateNormalizedDocument(value: unknown): NormalizedDocument {
  const issues = new Issues("NormalizedDocument");
  if (!isRecord(value)) {
    issues.push("root must be an object");
    issues.throwIfAny();
  }
  const obj = value as Record<string, unknown>;
  const path = "NormalizedDocument";
  if (obj.schemaVersion !== 1) issues.push(`${path}.schemaVersion must be 1`);
  const id = requireString(obj, "id", path, issues);
  if (id && !id.startsWith("doc_")) issues.push(`${path}.id must start with doc_`);
  const sourceId = requireString(obj, "sourceId", path, issues);
  const externalId = requireString(obj, "externalId", path, issues);
  const latestObservationId = requireString(obj, "latestObservationId", path, issues);
  const firstObservationId = requireString(obj, "firstObservationId", path, issues);
  const title = requireString(obj, "title", path, issues);
  const content = optionalString(obj, "content", path, issues);
  const contentCompleteness = requireEnum(obj, "contentCompleteness", CONTENT_COMPLETENESS, path, issues);
  if (content === null && (contentCompleteness === "FULL" || contentCompleteness === "EXCERPT")) {
    issues.push(`${path}.content is null but completeness is ${contentCompleteness}`);
  }
  const publishedAt = optionalString(obj, "publishedAt", path, issues);
  const updatedAt = optionalString(obj, "updatedAt", path, issues);
  const fetchedAt = requireString(obj, "fetchedAt", path, issues);
  for (const [k, v] of [["publishedAt", publishedAt], ["updatedAt", updatedAt], ["fetchedAt", fetchedAt]] as const) {
    if (v && !isValidIsoDateTime(v)) issues.push(`${path}.${k} must be ISO 8601`);
  }
  const language = optionalString(obj, "language", path, issues);
  const canonical = optionalString(obj, "canonicalUrl", path, issues);
  const status = requireEnum(obj, "status", DOCUMENT_STATUS, path, issues);
  const author = isRecord(obj.author) ? obj.author : {};
  const provenance = isRecord(obj.provenance) ? obj.provenance : {};
  const normalizerVersion = requireString(provenance, "normalizerVersion", `${path}.provenance`, issues);
  const runIdValue = requireString(provenance, "runId", `${path}.provenance`, issues);
  const normalizedAt = requireString(provenance, "normalizedAt", `${path}.provenance`, issues);
  const comments = Array.isArray(obj.comments) ? (obj.comments as NormalizedComment[]) : [];
  const metrics = Array.isArray(obj.metrics) ? (obj.metrics as MetricSnapshot[]) : [];
  issues.throwIfAny();
  return {
    schemaVersion: 1,
    id,
    sourceId,
    externalId,
    latestObservationId,
    firstObservationId,
    title,
    content,
    contentCompleteness,
    author: {
      name: typeof author.name === "string" ? author.name : null,
      externalId: typeof author.externalId === "string" ? author.externalId : null,
      url: typeof author.url === "string" ? author.url : null,
    },
    language,
    publishedAt,
    updatedAt,
    fetchedAt,
    canonicalUrl: canonical,
    urls: stringArray(obj.urls, `${path}.urls`, issues),
    comments,
    metrics,
    tags: stringArray(obj.tags, `${path}.tags`, issues),
    status,
    provenance: { normalizerVersion, runId: runIdValue, normalizedAt },
  };
}

export const LINK_TYPES = ["SAME_URL", "SAME_STORY", "CROSS_POST", "REPLY_TO", "MENTIONS_URL"] as const;
export type LinkType = (typeof LINK_TYPES)[number];

export interface DocumentLink {
  fromDocumentId: string;
  toDocumentId: string;
  type: LinkType;
  confidence: number;
  provenance: import("../evidence/provenance.js").Provenance;
}
