import type { CollectContext, CollectRequest, CollectResult, SourceAdapter, SourceDescriptor } from "../../../ports/sources/source-adapter.js";
import { observationId, payloadHashOf } from "../../../domain/shared/ids.js";
import { normalizeGithubTrending, type TrendingPayload } from "./normalize.js";

export const TRENDING_BASE = "https://raw.githubusercontent.com/hanishrao/trending-collection/main/api";
const PERIODS = ["daily", "weekly"] as const;
const MAX_READMES = 40;
const README_CHARS = 16_000;

/** Third-party Trending snapshots + GitHub's public README API. No code is executed. */
export class GithubTrendingSource implements SourceAdapter {
  readonly descriptor: SourceDescriptor = {
    id: "github-trending", kind: "API",
    capabilities: { timeWindow: false, cursor: false, checkpoint: true, comments: false, metrics: [], expectedCompleteness: "EXCERPT" },
    limits: { requestsPerMinute: null, maxItemsPerRun: 25, defaultTimeoutMs: 20_000 },
    license: { name: "Trending mirror; README retains each repository's license", url: "https://github.com/hanishrao/trending-collection", attributionRequired: true },
  };
  readonly normalize = normalizeGithubTrending;
  constructor(private readonly isRelevant: (text: string) => boolean) {}

  async collect(request: CollectRequest, ctx: CollectContext): Promise<CollectResult> {
    const observations: CollectResult["observations"] = [];
    const errors: CollectResult["errors"] = [];
    let truncated: CollectResult["coverage"]["truncationReason"] = null;
    let listsRead = 0;
    let readmes = 0;
    let readmeRateLimited = false;
    const candidates = new Map<string, TrendingPayload>();
    const oldData = request.checkpoint?.schemaVersion === 1 ? request.checkpoint.data : null;
    const hashes: Record<string, string> = Object.create(null);
    if (oldData && typeof oldData === "object" && "hashes" in oldData && oldData.hashes && typeof oldData.hashes === "object") {
      for (const [key, value] of Object.entries(oldData.hashes)) if (typeof value === "string") hashes[key] = value;
    }
    const get = async (url: string, accept: string, isReadme = false) => {
      const remaining = Date.parse(request.deadlineAt) - ctx.clock.nowMs();
      if (ctx.signal.aborted || remaining <= 0) { truncated = "DEADLINE"; throw new Error("deadline"); }
      const response = await ctx.http.request({ url, method: "GET", headers: { accept }, timeoutMs: Math.min(20_000, remaining), signal: ctx.signal });
      if (response.status !== 200) {
        if (response.status === 429 || response.status === 403) {
          truncated = "RATE_LIMIT";
          if (isReadme) readmeRateLimited = true;
        }
        throw new Error(`HTTP ${response.status}`);
      }
      return response.text;
    };
    for (const period of PERIODS) {
      try {
        const data = JSON.parse(await get(`${TRENDING_BASE}/${period}/all.json`, "application/json"));
        const timestamp = typeof data?.pubDate === "string" ? Date.parse(data.pubDate) : NaN;
        if (!Array.isArray(data?.items) || !Number.isFinite(timestamp)) throw new Error("invalid snapshot");
        const age = ctx.clock.nowMs() - timestamp;
        if (age > 48 * 60 * 60 * 1000 || age < -5 * 60 * 1000) throw new Error("stale or future snapshot");
        listsRead++;
        for (const [index, item] of data.items.entries()) {
          const match = typeof item?.url === "string" ? /^https:\/\/github\.com\/([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)\/?$/.exec(item.url) : null;
          if (!match || typeof item.description !== "string" || match[1]!.split("/").some(s => s === "." || s === "..")) {
            errors.push({ kind: "PARSE", message: `${period}: invalid repository entry`, retryable: false }); continue;
          }
          const repository = match[1]!;
          const key = repository.toLowerCase();
          const candidate: TrendingPayload = candidates.get(key) ?? { repository, description: item.description, readme: "", appearances: [] };
          candidate.appearances.push({ period, snapshotAt: new Date(timestamp).toISOString(), rank: index + 1 });
          candidates.set(key, candidate);
        }
      } catch {
        errors.push({ kind: truncated === "RATE_LIMIT" ? "RATE_LIMIT" : truncated === "DEADLINE" ? "TIMEOUT" : "PARSE", message: `${period}: snapshot unavailable, invalid or stale`, retryable: true });
      }
    }
    for (const [key, candidate] of candidates) {
      // Mirror and README API have independent rate budgets; retain the healthy period.
      if (truncated === "DEADLINE" || readmeRateLimited) break;
      if (readmes >= MAX_READMES || observations.length >= Math.min(25, request.maxItems)) { truncated = "MAX_ITEMS"; break; }
      try {
        readmes++;
        const readme = await get(`https://api.github.com/repos/${candidate.repository}/readme`, "application/vnd.github.raw+json", true);
        if (!readme.trim() || /^\s*[\[{]/.test(readme) && readme.includes('"download_url"')) throw new Error("invalid README");
        candidate.readme = readme.slice(0, README_CHARS);
        if (!this.isRelevant(`${candidate.repository} ${candidate.description}\n${candidate.readme}`)) continue;
        // Rank/star/snapshot changes alone do not make another daily article.
        const fingerprint = payloadHashOf({ description: candidate.description, readme: candidate.readme });
        if (hashes[key] === fingerprint) continue;
        const payloadHash = payloadHashOf(candidate);
        const fetchedAt = ctx.clock.nowIso();
        observations.push({ schemaVersion: 1, id: observationId(this.descriptor.id, key, payloadHash), sourceId: this.descriptor.id,
          sourceKind: "API", externalId: key, originalUrl: `https://github.com/${candidate.repository}`,
          observedAt: fetchedAt, observedAtIsFetchedAt: true, fetchedAt, runId: request.runId,
          payloadHash, payloadRef: { kind: "inline", json: candidate }, completeness: "EXCERPT", rawMetadata: { readmeTruncated: readme.length > README_CHARS } });
        hashes[key] = fingerprint;
      } catch {
        errors.push({ kind: truncated === "RATE_LIMIT" ? "RATE_LIMIT" : truncated === "DEADLINE" ? "TIMEOUT" : "NETWORK", message: `${candidate.repository}: README unavailable`, retryable: true });
      }
    }
    return {
      status: listsRead === 0 ? "FAILED" : errors.length || truncated ? "PARTIAL" : "COMPLETE", observations,
      nextCheckpoint: listsRead ? { schemaVersion: 1, data: { hashes: Object.fromEntries(Object.entries(hashes).slice(-1000)) } } : request.checkpoint,
      coverage: { windowRequested: request.window, windowCovered: null, truncated: truncated !== null, truncationReason: truncated, itemsSeen: candidates.size }, errors,
    };
  }
}
