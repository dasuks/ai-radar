import type { NormalizeInput } from "../../../ports/sources/source-adapter.js";
import type { NormalizedDocument } from "../../../domain/documents/normalized-document.js";
import { canonicalUrl } from "../../../domain/documents/normalized-document.js";
import { documentId } from "../../../domain/shared/ids.js";
import { extractHrefs, stripHtml } from "../../shared/html.js";
import type { RssFeedItem } from "./feed.js";

export const RSS_NORMALIZER_VERSION = "rss@1";
export const RSS_SOURCE_ID_PREFIX = "rss:";

export interface RssPayload {
  item: RssFeedItem;
  rawXml: string;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** payloadRef(inline) → RssPayload. I/O 없음. */
export function readRssPayload(payload: unknown): RssPayload | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;
  const itemRaw = raw.item;
  if (typeof itemRaw !== "object" || itemRaw === null || Array.isArray(itemRaw)) return null;
  const fields = itemRaw as Record<string, unknown>;
  const externalId = asString(fields.externalId);
  if (!externalId) return null;
  const categories = Array.isArray(fields.categories)
    ? fields.categories.filter((c): c is string => typeof c === "string")
    : [];
  const completeness = fields.completeness;
  return {
    item: {
      externalId,
      guid: asString(fields.guid),
      title: asString(fields.title),
      link: asString(fields.link),
      publishedAt: asString(fields.publishedAt),
      updatedAt: asString(fields.updatedAt),
      author: asString(fields.author),
      summaryHtml: asString(fields.summaryHtml),
      contentHtml: asString(fields.contentHtml),
      categories,
      completeness:
        completeness === "FULL" || completeness === "EXCERPT" || completeness === "TITLE_ONLY" || completeness === "MISSING"
          ? completeness
          : "TITLE_ONLY",
    },
    rawXml: asString(raw.rawXml) ?? "",
  };
}

/** `rss:<feedId>` → `<feedId>` (tag 로 쓴다). */
export function feedIdOf(sourceId: string): string {
  return sourceId.startsWith(RSS_SOURCE_ID_PREFIX) ? sourceId.slice(RSS_SOURCE_ID_PREFIX.length) : sourceId;
}

/** RSS/Atom payload → NormalizedDocument. 순수 함수 (PIPELINES §2.1). */
export function normalizeRss(input: NormalizeInput): NormalizedDocument {
  const { observation, existing } = input;
  if (observation.payloadRef.kind !== "inline") {
    throw new Error(`rss normalize requires an inline payload (observation ${observation.id})`);
  }
  const payload = readRssPayload(observation.payloadRef.json);
  if (!payload) {
    throw new Error(`rss payload is not a feed item (observation ${observation.id})`);
  }
  const { item } = payload;

  const bodyHtml = item.contentHtml ?? item.summaryHtml ?? "";
  const content = bodyHtml ? stripHtml(bodyHtml) : "";
  const completeness = content.length > 0 ? observation.completeness : "TITLE_ONLY";

  const urls: string[] = [];
  if (item.link) urls.push(item.link);
  for (const href of extractHrefs(bodyHtml)) {
    if (!urls.includes(href)) urls.push(href);
  }

  const feedId = feedIdOf(observation.sourceId);
  const tags = [feedId, ...item.categories.filter((c) => c !== feedId)];

  return {
    schemaVersion: 1,
    id: documentId(observation.sourceId, observation.externalId),
    sourceId: observation.sourceId,
    externalId: observation.externalId,
    latestObservationId: observation.id,
    firstObservationId: existing?.firstObservationId ?? observation.id,
    title: item.title ?? item.link ?? item.externalId,
    content: content.length > 0 ? content : null,
    contentCompleteness: completeness,
    author: { name: item.author, externalId: null, url: null },
    language: null,
    publishedAt: item.publishedAt,
    updatedAt: item.updatedAt,
    fetchedAt: observation.fetchedAt,
    canonicalUrl: canonicalUrl(observation.originalUrl),
    urls,
    comments: [],
    metrics: [],
    tags,
    status: "ACTIVE",
    provenance: {
      normalizerVersion: RSS_NORMALIZER_VERSION,
      runId: input.runId,
      normalizedAt: input.normalizedAt,
    },
  };
}
