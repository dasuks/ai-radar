import type { NormalizeInput } from "../../../ports/sources/source-adapter.js";
import type { NormalizedDocument } from "../../../domain/documents/normalized-document.js";
import { canonicalUrl } from "../../../domain/documents/normalized-document.js";
import { documentId } from "../../../domain/shared/ids.js";

export const THREADS_NORMALIZER_VERSION = "threads@1";

export interface ThreadsPost {
  id: string;
  text: string | null;
  timestamp: string | null;
  permalink: string;
  username: string;
  media_type: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function readThreadsPost(value: unknown, expectedUsername: string): ThreadsPost | null {
  const post = record(value);
  if (!post || typeof post.id !== "string" || !post.id.trim()) return null;
  if (typeof post.username !== "string" || post.username.toLowerCase() !== expectedUsername.toLowerCase()) return null;
  if (post.text !== undefined && post.text !== null && typeof post.text !== "string") return null;
  if (post.media_type !== undefined && post.media_type !== null && typeof post.media_type !== "string") return null;
  if (typeof post.permalink !== "string") return null;
  try {
    const url = new URL(post.permalink);
    if (url.protocol !== "https:" || !["threads.net", "www.threads.net", "threads.com", "www.threads.com"].includes(url.hostname.toLowerCase())) return null;
    if (url.username || url.password || !url.pathname.toLowerCase().startsWith(`/@${expectedUsername.toLowerCase()}/post/`)) return null;
    if (url.pathname.length <= `/@${expectedUsername}/post/`.length) return null;
  } catch {
    return null;
  }
  const timestamp = typeof post.timestamp === "string" && Number.isFinite(Date.parse(post.timestamp))
    ? new Date(post.timestamp).toISOString()
    : null;
  return {
    id: post.id,
    text: typeof post.text === "string" ? post.text : null,
    timestamp,
    permalink: post.permalink,
    username: post.username,
    media_type: typeof post.media_type === "string" ? post.media_type : null,
  };
}

function textUrls(text: string): string[] {
  const urls: string[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const candidate = match[0].replace(/[.,;:!?)}\]]+$/u, "");
    const normalized = canonicalUrl(candidate);
    if (normalized && !urls.includes(normalized)) urls.push(normalized);
  }
  return urls;
}

export function normalizeThreads(input: NormalizeInput): NormalizedDocument {
  const { observation, existing } = input;
  if (observation.payloadRef.kind !== "inline") throw new Error("threads normalize requires an inline payload");
  const expectedUsername = observation.sourceId.startsWith("threads:") ? observation.sourceId.slice(8) : "";
  const post = readThreadsPost(observation.payloadRef.json, expectedUsername);
  if (!post || post.id !== observation.externalId) throw new Error("threads observation has an invalid post payload");
  const content = post.text && post.text.trim() ? post.text : null;
  const original = canonicalUrl(post.permalink);
  const urls = [original, ...textUrls(post.text ?? "")].filter((url): url is string => url !== null);
  return {
    schemaVersion: 1,
    id: documentId(observation.sourceId, observation.externalId),
    sourceId: observation.sourceId,
    externalId: observation.externalId,
    latestObservationId: observation.id,
    firstObservationId: existing?.firstObservationId ?? observation.id,
    title: content ? content.trim().split(/\r?\n/u)[0]!.slice(0, 160) : post.permalink,
    content,
    contentCompleteness: content ? "FULL" : "TITLE_ONLY",
    author: { name: post.username, externalId: post.username, url: `https://www.threads.com/@${post.username}` },
    language: null,
    publishedAt: post.timestamp,
    updatedAt: null,
    fetchedAt: observation.fetchedAt,
    canonicalUrl: original,
    urls: [...new Set(urls)],
    comments: [],
    metrics: [],
    tags: ["threads"],
    status: "ACTIVE",
    provenance: { normalizerVersion: THREADS_NORMALIZER_VERSION, runId: input.runId, normalizedAt: input.normalizedAt },
  };
}
