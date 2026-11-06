import type { NormalizeInput } from "../../../ports/sources/source-adapter.js";
import type { NormalizedDocument } from "../../../domain/documents/normalized-document.js";
import { documentId } from "../../../domain/shared/ids.js";

export interface TrendingPayload {
  repository: string;
  description: string;
  readme: string;
  appearances: { period: string; snapshotAt: string; rank: number }[];
}

export function normalizeGithubTrending(input: NormalizeInput): NormalizedDocument {
  const { observation: o, existing } = input;
  if (o.payloadRef.kind !== "inline") throw new Error("Trending requires inline payload");
  const p = o.payloadRef.json as TrendingPayload;
  const repoUrl = `https://github.com/${p.repository}`;
  const readmeUrl = `${repoUrl}#readme`;
  return {
    schemaVersion: 1, id: documentId(o.sourceId, o.externalId), sourceId: o.sourceId,
    externalId: o.externalId, latestObservationId: o.id, firstObservationId: existing?.firstObservationId ?? o.id,
    title: `${p.repository}: ${p.description}`,
    content: `${p.description}\n\nRepository README (maintainer claims, not independently tested):\n${p.readme}\n\nDiscovery context (snapshot date is NOT release date):\n${p.appearances.map(a => `${a.period} Trending snapshot ${a.snapshotAt}, position ${a.rank}`).join("\n")}\nMirror: https://github.com/hanishrao/trending-collection`,
    contentCompleteness: "EXCERPT", author: { name: p.repository.split("/")[0]!, externalId: null, url: null },
    language: null, publishedAt: null, updatedAt: null, fetchedAt: o.fetchedAt,
    canonicalUrl: repoUrl, urls: [repoUrl, readmeUrl, ...p.appearances.map(a => `https://github.com/trending?since=${a.period}`)],
    comments: [], metrics: [], tags: ["github-trending"], status: "ACTIVE",
    provenance: { normalizerVersion: "github-trending@1", runId: input.runId, normalizedAt: input.normalizedAt },
  };
}
