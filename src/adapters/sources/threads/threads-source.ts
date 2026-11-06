import type { RawObservation } from "../../../domain/documents/raw-observation.js";
import type { NormalizedDocument } from "../../../domain/documents/normalized-document.js";
import { observationId, payloadHashOf } from "../../../domain/shared/ids.js";
import { isWithinWindow } from "../../../domain/shared/time.js";
import type {
  CollectContext, CollectRequest, CollectResult, NormalizeInput, SourceAdapter, SourceDescriptor,
} from "../../../ports/sources/source-adapter.js";
import { normalizeThreads, readThreadsPost, type ThreadsPost } from "./normalize.js";

const ENDPOINT = "https://graph.threads.net/profile_posts";
const FIELDS = "id,text,timestamp,permalink,username,media_type";
const TIMEOUT_MS = 20_000;
const MAX_PAGES = 5;
const MAX_ITEMS = 100;
type CollectError = CollectResult["errors"][number];
type TruncationReason = CollectResult["coverage"]["truncationReason"];

export interface ThreadsSourceOptions { username: string; accessToken?: string }

/**
 * Official public-profile-posts API. Meta's published request documents the exact username and
 * fields parameters, but supplies no successful response example. UNVERIFIED EXTERNAL CONSTRAINT:
 * confirm granted scopes, app access, target eligibility, Bearer acceptance, response fields and
 * after-cursor pagination with one authorized target read before claiming live coverage.
 * https://www.postman.com/meta/threads/request/34203612-116161fc-75af-4a09-a972-66d6f64ddb10
 */
export class ThreadsSource implements SourceAdapter {
  readonly descriptor: SourceDescriptor;
  private readonly username: string;
  private readonly accessToken: string | undefined;

  constructor(options: ThreadsSourceOptions) {
    const username = options.username.replace(/^@/u, "").trim();
    if (!/^[a-zA-Z0-9_.]+$/u.test(username)) throw new Error("threads username must be an exact profile handle");
    this.username = username;
    this.accessToken = options.accessToken?.trim() || undefined;
    this.descriptor = {
      id: `threads:${username}`,
      kind: "API",
      capabilities: {
        timeWindow: false,
        cursor: true,
        // Rescan within the window. Durable observation IDs dedupe; no partial page can advance a checkpoint.
        checkpoint: false,
        comments: false,
        metrics: [],
        expectedCompleteness: "FULL",
      },
      limits: { requestsPerMinute: null, maxItemsPerRun: MAX_ITEMS, defaultTimeoutMs: TIMEOUT_MS },
      license: {
        name: "Meta Threads API",
        url: "https://www.postman.com/meta/threads/request/34203612-116161fc-75af-4a09-a972-66d6f64ddb10",
        attributionRequired: true,
      },
    };
  }

  async collect(request: CollectRequest, ctx: CollectContext): Promise<CollectResult> {
    if (!this.accessToken) return failed(request, { kind: "ACCESS", message: `${this.descriptor.id} requires Threads API authorization`, retryable: false });
    const fetchedAt = ctx.clock.nowIso();
    const observations: RawObservation[] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    const errors: CollectError[] = [];
    let itemsSeen = 0;
    let after: string | null = null;
    let truncationReason: TruncationReason = null;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      if (ctx.signal.aborted || deadlinePassed(request, ctx)) {
        if (page === 0) return failed(request, { kind: "TIMEOUT", message: `${this.descriptor.id} deadline passed`, retryable: true });
        truncationReason = "DEADLINE";
        break;
      }
      const url = new URL(ENDPOINT);
      url.searchParams.set("username", this.username);
      url.searchParams.set("fields", FIELDS);
      if (after) url.searchParams.set("after", after);
      const remaining = Date.parse(request.deadlineAt) - ctx.clock.nowMs();
      const timeoutMs = Number.isFinite(remaining) ? Math.max(1, Math.min(TIMEOUT_MS, remaining)) : TIMEOUT_MS;
      let text: string;
      try {
        const response = await ctx.http.request({
          url: url.toString(), method: "GET",
          headers: { accept: "application/json", authorization: `Bearer ${this.accessToken}` },
          timeoutMs, signal: ctx.signal,
        });
        if (response.status < 200 || response.status >= 300) {
          errors.push(httpError(response.status, this.descriptor.id));
          if (response.status === 429) truncationReason = "RATE_LIMIT";
          break;
        }
        text = response.text;
      } catch (error) {
        errors.push({
          kind: ctx.signal.aborted ? "TIMEOUT" : "NETWORK",
          // Error.message can echo request headers or a credentialed URL.
          message: `${this.descriptor.id} request ${ctx.signal.aborted ? "aborted" : "failed"}`,
          retryable: true,
        });
        void error;
        break;
      }
      let payload: unknown;
      try { payload = JSON.parse(text) as unknown; }
      catch { errors.push({ kind: "PARSE", message: `${this.descriptor.id} returned invalid JSON`, retryable: false }); break; }
      if (!isRecord(payload) || !Array.isArray(payload.data)) {
        errors.push({ kind: "PARSE", message: `${this.descriptor.id} response has no data array`, retryable: false });
        break;
      }
      const pagePosts: ThreadsPost[] = [];
      for (const entry of payload.data) {
        itemsSeen += 1;
        const post = readThreadsPost(entry, this.username);
        if (!post) {
          errors.push({ kind: "PARSE", message: `${this.descriptor.id} response contains an invalid or mismatched post`, retryable: false });
          continue;
        }
        pagePosts.push(post);
      }
      // Empty data[] is a real empty page. A nonempty page with no valid post is a failed read.
      if (payload.data.length > 0 && pagePosts.length === 0) break;
      let nextAfter: string | null = null;
      if (payload.paging !== undefined) {
        const paging = payload.paging;
        if (!isRecord(paging)) {
          errors.push({ kind: "PARSE", message: `${this.descriptor.id} has malformed paging`, retryable: false });
        } else {
          if (paging.cursors !== undefined) {
            const cursor = paging.cursors;
            if (!isRecord(cursor) || (cursor.after !== undefined && typeof cursor.after !== "string")) {
              errors.push({ kind: "PARSE", message: `${this.descriptor.id} has malformed after cursor`, retryable: false });
            } else if (typeof cursor.after === "string" && cursor.after.length > 0) {
              nextAfter = cursor.after;
            }
          }
          // A supplied next URL signals more data, but is never followed with Authorization.
          // Without a reconstructable cursor this page cannot be called complete.
          if (!nextAfter && typeof paging.next === "string" && paging.next.length > 0) {
            errors.push({ kind: "PARSE", message: `${this.descriptor.id} paging has no usable after cursor`, retryable: false });
          }
        }
      }
      for (const post of pagePosts) {
        if (ids.has(post.id)) continue;
        ids.add(post.id);
        if (post.timestamp !== null && !isWithinWindow(post.timestamp, request.window)) continue;
        if (observations.length >= Math.min(request.maxItems, MAX_ITEMS)) {
          truncationReason = "MAX_ITEMS";
          break;
        }
        observations.push(toObservation(post, this.descriptor.id, fetchedAt, request.runId));
      }
      if (truncationReason || errors.some((error) => error.kind === "PARSE")) break;
      if (!nextAfter) break;
      if (cursors.has(nextAfter)) {
        errors.push({ kind: "PARSE", message: `${this.descriptor.id} repeated an after cursor`, retryable: false });
        break;
      }
      cursors.add(nextAfter);
      after = nextAfter;
      if (page === MAX_PAGES - 1) truncationReason = "PAGINATION_LIMIT";
    }

    if (errors.length > 0 && observations.length === 0) return failed(request, errors, itemsSeen);
    const partial = errors.length > 0 || truncationReason !== null;
    ctx.logger.child(this.descriptor.id).info("threads collect finished", {
      status: partial ? "PARTIAL" : "COMPLETE", itemsSeen, observations: observations.length, errors: errors.length,
    });
    return {
      status: partial ? "PARTIAL" : "COMPLETE",
      observations,
      nextCheckpoint: null,
      coverage: {
        windowRequested: request.window,
        windowCovered: partial ? null : request.window,
        truncated: partial,
        truncationReason,
        itemsSeen,
      },
      errors,
    };
  }

  normalize(input: NormalizeInput): NormalizedDocument { return normalizeThreads(input); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deadlinePassed(request: CollectRequest, ctx: CollectContext): boolean {
  const deadline = Date.parse(request.deadlineAt);
  return Number.isFinite(deadline) && ctx.clock.nowMs() >= deadline;
}

function httpError(status: number, sourceId: string): CollectError {
  if (status === 429) return { kind: "RATE_LIMIT", message: `${sourceId} responded 429`, retryable: true };
  if (status >= 500) return { kind: "NETWORK", message: `${sourceId} responded ${status}`, retryable: true };
  return { kind: "ACCESS", message: `${sourceId} responded ${status}; verify API permission and token`, retryable: false };
}

function toObservation(post: ThreadsPost, sourceId: string, fetchedAt: string, runId: string): RawObservation {
  const payloadHash = payloadHashOf(post);
  return {
    schemaVersion: 1,
    id: observationId(sourceId, post.id, payloadHash),
    sourceId,
    sourceKind: "API",
    externalId: post.id,
    originalUrl: post.permalink,
    observedAt: fetchedAt,
    observedAtIsFetchedAt: true,
    fetchedAt,
    runId,
    payloadHash,
    payloadRef: { kind: "inline", json: post },
    completeness: post.text && post.text.trim() ? "FULL" : "TITLE_ONLY",
    rawMetadata: { mediaType: post.media_type },
  };
}

function failed(request: CollectRequest, errors: CollectError | CollectError[], itemsSeen = 0): CollectResult {
  return {
    status: "FAILED", observations: [], nextCheckpoint: null,
    coverage: { windowRequested: request.window, windowCovered: null, truncated: false, truncationReason: null, itemsSeen },
    errors: Array.isArray(errors) ? errors : [errors],
  };
}
