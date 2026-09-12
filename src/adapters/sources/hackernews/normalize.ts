import type { NormalizeInput } from "../../../ports/sources/source-adapter.js";
import type {
  MetricSnapshot,
  NormalizedComment,
  NormalizedDocument,
} from "../../../domain/documents/normalized-document.js";
import { canonicalUrl } from "../../../domain/documents/normalized-document.js";
import { documentId } from "../../../domain/shared/ids.js";
import { extractHrefs, stripHtml } from "../../shared/html.js";
import {
  HN_NORMALIZER_VERSION,
  hnDiscussionUrl,
  hnUserUrl,
  toHnItem,
  unixSecondsToIso,
  type HnItem,
  type HnPayload,
} from "./types.js";

/** payloadRef(inline) → HnPayload. I/O 없음. */
export function readHnPayload(payload: unknown): HnPayload | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;
  const item = toHnItem(raw.item);
  if (!item) return null;
  const comments = Array.isArray(raw.comments)
    ? raw.comments.map(toHnItem).filter((c): c is HnItem => c !== null)
    : [];
  return { item, comments };
}

function toNormalizedComment(comment: HnItem): NormalizedComment {
  return {
    externalId: String(comment.id),
    author: comment.by ?? null,
    content: stripHtml(comment.text ?? ""),
    score: null,
    publishedAt: unixSecondsToIso(comment.time),
    parentExternalId: comment.parent === undefined ? null : String(comment.parent),
  };
}

/**
 * Hacker News payload → NormalizedDocument. 순수 함수 (PIPELINES §2.1).
 * payloadRef 가 inline 이 아니면 호출자가 payload 를 읽어 올 수 없으므로 예외를 던진다.
 */
export function normalizeHackerNews(input: NormalizeInput): NormalizedDocument {
  const { observation, existing } = input;
  if (observation.payloadRef.kind !== "inline") {
    throw new Error(`hackernews normalize requires an inline payload (observation ${observation.id})`);
  }
  const payload = readHnPayload(observation.payloadRef.json);
  if (!payload) {
    throw new Error(`hackernews payload is not a Hacker News item (observation ${observation.id})`);
  }
  const { item, comments } = payload;

  const textHtml = item.text ?? "";
  const content = textHtml ? stripHtml(textHtml) : "";
  const completeness = content.length > 0 ? observation.completeness : "TITLE_ONLY";

  const metrics: MetricSnapshot[] = [];
  if (typeof item.score === "number") {
    metrics.push({ key: "hn.points", value: item.score, observedAt: observation.observedAt });
  }
  if (typeof item.descendants === "number") {
    metrics.push({ key: "hn.comments", value: item.descendants, observedAt: observation.observedAt });
  }

  const urls: string[] = [];
  if (item.url) urls.push(item.url);
  for (const href of extractHrefs(textHtml)) {
    if (!urls.includes(href)) urls.push(href);
  }

  return {
    schemaVersion: 1,
    id: documentId(observation.sourceId, observation.externalId),
    sourceId: observation.sourceId,
    externalId: observation.externalId,
    latestObservationId: observation.id,
    firstObservationId: existing?.firstObservationId ?? observation.id,
    title: item.title ?? hnDiscussionUrl(item.id),
    content: content.length > 0 ? content : null,
    contentCompleteness: completeness,
    author: {
      name: item.by ?? null,
      externalId: item.by ?? null,
      url: item.by ? hnUserUrl(item.by) : null,
    },
    language: null,
    publishedAt: unixSecondsToIso(item.time),
    updatedAt: null,
    fetchedAt: observation.fetchedAt,
    canonicalUrl: canonicalUrl(observation.originalUrl ?? hnDiscussionUrl(item.id)),
    urls,
    comments: comments.map(toNormalizedComment),
    metrics,
    tags: ["hackernews"],
    status: "ACTIVE",
    provenance: {
      normalizerVersion: HN_NORMALIZER_VERSION,
      runId: input.runId,
      normalizedAt: input.normalizedAt,
    },
  };
}
