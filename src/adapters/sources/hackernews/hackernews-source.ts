import type {
  CollectContext,
  CollectErrorKind,
  CollectRequest,
  CollectResult,
  NormalizeInput,
  SourceAdapter,
  SourceCheckpoint,
  SourceDescriptor,
} from "../../../ports/sources/source-adapter.js";
import type { NormalizedDocument } from "../../../domain/documents/normalized-document.js";
import type { ContentCompleteness, RawObservation } from "../../../domain/documents/raw-observation.js";
import type { TimeWindow } from "../../../domain/shared/time.js";
import { isWithinWindow } from "../../../domain/shared/time.js";
import { observationId, payloadHashOf } from "../../../domain/shared/ids.js";
import { normalizeHackerNews } from "./normalize.js";
import {
  HN_SOURCE_ID,
  hnDiscussionUrl,
  toHnItem,
  unixSecondsToIso,
  type HnItem,
  type HnPayload,
} from "./types.js";

const API_BASE = "https://hacker-news.firebaseio.com/v0";
const TOP_STORIES_URL = `${API_BASE}/topstories.json`;

/** 동시 요청 상한. Firebase API 는 공개 rate limit 을 문서화하지 않는다. */
const BATCH_SIZE = 10;
/** topstories 는 최대 500개를 돌려준다. 상위 N개만 훑는다. */
const TOP_STORY_SCAN_LIMIT = 200;
/** 항목당 가져오는 1단계 댓글 수 */
const MAX_COMMENTS = 5;

const DEFAULT_TIMEOUT_MS = 20_000;

type CollectError = CollectResult["errors"][number];
type TruncationReason = CollectResult["coverage"]["truncationReason"];

interface HackerNewsCheckpointData {
  lastMaxItemId: number | null;
}

type JsonOutcome = { ok: true; json: unknown } | { ok: false; error: CollectError };

function httpStatusError(status: number, url: string): CollectError {
  if (status === 429) {
    return { kind: "RATE_LIMIT", message: `hackernews responded 429 for ${url}`, retryable: true };
  }
  if (status >= 500) {
    return { kind: "NETWORK", message: `hackernews responded ${status} for ${url}`, retryable: true };
  }
  return { kind: "ACCESS", message: `hackernews responded ${status} for ${url}`, retryable: false };
}

function readCheckpoint(checkpoint: SourceCheckpoint | null): HackerNewsCheckpointData {
  if (!checkpoint || checkpoint.schemaVersion !== 1) return { lastMaxItemId: null };
  const data = checkpoint.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { lastMaxItemId: null };
  const value = (data as Record<string, unknown>).lastMaxItemId;
  return { lastMaxItemId: typeof value === "number" && Number.isFinite(value) ? value : null };
}

export interface HackerNewsSourceOptions {
  /**
   * 제목 관련성 필터. 정책은 adapter 가 아니라 Composition Root 가 정한다
   * (`policies/classification/source-relevance.ts`). 생략하면 필터 없이 전부 받는다.
   */
  isRelevant?: (title: string) => boolean;
}

/**
 * Hacker News 공식 Firebase API source adapter (PIPELINES_AND_POLICIES.md §2).
 *
 * - stateless: checkpoint 는 인자로 받고 결과로 돌려준다.
 * - 네트워크는 `ctx.http` 로만 접근한다 (global fetch 금지).
 * - 외부에서 온 문자열(제목·본문)은 로그에 남기지 않는다 (INTEGRATIONS §5.1).
 * - 관련성 정책은 주입받는다 (adapters 는 policies 를 import 하지 않는다, ARCH-06).
 */
export class HackerNewsSource implements SourceAdapter {
  private readonly isRelevant: (title: string) => boolean;

  constructor(options: HackerNewsSourceOptions = {}) {
    this.isRelevant = options.isRelevant ?? (() => true);
  }

  readonly descriptor: SourceDescriptor = {
    id: HN_SOURCE_ID,
    kind: "API",
    capabilities: {
      timeWindow: false,
      cursor: false,
      checkpoint: true,
      comments: true,
      metrics: ["hn.points", "hn.comments"],
      expectedCompleteness: "TITLE_ONLY",
    },
    limits: { requestsPerMinute: null, maxItemsPerRun: 60, defaultTimeoutMs: DEFAULT_TIMEOUT_MS },
    license: {
      name: "Hacker News API (Firebase)",
      url: "https://github.com/HackerNews/API",
      attributionRequired: false,
    },
  };

  async collect(request: CollectRequest, ctx: CollectContext): Promise<CollectResult> {
    const log = ctx.logger.child(HN_SOURCE_ID);
    const fetchedAt = ctx.clock.nowIso();
    const errors: CollectError[] = [];
    let itemsSeen = 0;
    let truncationReason: TruncationReason = null;

    try {
      const top = await this.requestJson(TOP_STORIES_URL, request, ctx);
      if (!top.ok) return failed(request.window, [top.error], 0);
      if (!Array.isArray(top.json)) {
        return failed(
          request.window,
          [{ kind: "PARSE", message: "topstories.json is not an array", retryable: false }],
          0,
        );
      }
      const allIds = top.json.filter((id): id is number => typeof id === "number");
      const candidateIds = allIds.slice(0, TOP_STORY_SCAN_LIMIT);
      const paginationLimited = allIds.length > candidateIds.length;
      const lastMaxItemId =
        allIds.length > 0 ? Math.max(...allIds) : readCheckpoint(request.checkpoint).lastMaxItemId;

      const kept: HnItem[] = [];
      scan: for (let offset = 0; offset < candidateIds.length; offset += BATCH_SIZE) {
        if (this.pastDeadline(request, ctx)) {
          truncationReason = "DEADLINE";
          break;
        }
        const batch = candidateIds.slice(offset, offset + BATCH_SIZE);
        const outcomes = await Promise.all(
          batch.map((id) => this.requestJson(`${API_BASE}/item/${id}.json`, request, ctx)),
        );
        for (const outcome of outcomes) {
          itemsSeen += 1;
          if (!outcome.ok) {
            errors.push(outcome.error);
            if (outcome.error.kind === "RATE_LIMIT") {
              truncationReason = "RATE_LIMIT";
              break scan;
            }
            continue;
          }
          if (outcome.json === null) continue;
          const item = toHnItem(outcome.json);
          if (!item) {
            errors.push({
              kind: "PARSE",
              message: "hackernews item payload is not an object with an id",
              retryable: false,
            });
            continue;
          }
          if (!this.isCollectableStory(item, request.window)) continue;
          kept.push(item);
          if (kept.length >= request.maxItems) {
            truncationReason = "MAX_ITEMS";
            break scan;
          }
        }
      }

      const observations: RawObservation[] = [];
      for (let offset = 0; offset < kept.length; offset += BATCH_SIZE) {
        if (this.pastDeadline(request, ctx)) {
          truncationReason = "DEADLINE";
          break;
        }
        const batch = kept.slice(offset, offset + BATCH_SIZE);
        const payloads = await Promise.all(batch.map((item) => this.withComments(item, request, ctx, log)));
        for (const payload of payloads) {
          observations.push(toObservation(payload, fetchedAt, request.runId));
        }
      }

      if (truncationReason === null && paginationLimited) truncationReason = "PAGINATION_LIMIT";

      const truncated = truncationReason !== null;
      // topstories 자체의 실패는 위에서 이미 FAILED 로 돌아갔다. 여기서의 errors 는 개별 item 오류이므로
      // 관측이 0건이어도 접근 실패가 아니다 (PIPELINES §2.2: COMPLETE + 0건 = NO_NEW_ITEMS).
      const status: CollectResult["status"] = truncated || errors.length > 0 ? "PARTIAL" : "COMPLETE";

      // (FAILED 는 topstories 실패 시 위에서 이미 반환됨)

      log.info("hackernews collect finished", {
        status,
        itemsSeen,
        observations: observations.length,
        errors: errors.length,
      });

      return {
        status,
        observations,
        nextCheckpoint: { schemaVersion: 1, data: { lastMaxItemId } satisfies HackerNewsCheckpointData },
        coverage: {
          windowRequested: request.window,
          windowCovered: coveredWindow(request.window, observations, truncated),
          truncated,
          truncationReason,
          itemsSeen,
        },
        errors,
      };
    } catch (error) {
      return failed(request.window, [...errors, unexpectedError(error)], itemsSeen);
    }
  }

  normalize(input: NormalizeInput): NormalizedDocument {
    return normalizeHackerNews(input);
  }

  private isCollectableStory(item: HnItem, window: TimeWindow): boolean {
    if (item.deleted === true || item.dead === true) return false;
    if (item.type !== undefined && item.type !== "story") return false;
    const title = item.title;
    if (!title) return false;
    if (!this.isRelevant(title)) return false;
    const publishedAt = unixSecondsToIso(item.time);
    if (publishedAt === null) return false;
    return isWithinWindow(publishedAt, window);
  }

  private async withComments(
    item: HnItem,
    request: CollectRequest,
    ctx: CollectContext,
    log: CollectContext["logger"],
  ): Promise<HnPayload> {
    const kidIds = (item.kids ?? []).slice(0, MAX_COMMENTS);
    if (kidIds.length === 0) return { item, comments: [] };
    const outcomes = await Promise.all(
      kidIds.map((id) => this.requestJson(`${API_BASE}/item/${id}.json`, request, ctx)),
    );
    const comments: HnItem[] = [];
    for (const [index, outcome] of outcomes.entries()) {
      if (!outcome.ok || outcome.json === null) {
        log.warn("hackernews comment skipped", { itemId: item.id, commentId: kidIds[index] ?? null });
        continue;
      }
      const comment = toHnItem(outcome.json);
      if (comment && comment.deleted !== true && comment.dead !== true) comments.push(comment);
    }
    return { item, comments };
  }

  private pastDeadline(request: CollectRequest, ctx: CollectContext): boolean {
    if (ctx.signal.aborted) return true;
    const deadline = Date.parse(request.deadlineAt);
    return Number.isFinite(deadline) && ctx.clock.nowMs() >= deadline;
  }

  private async requestJson(url: string, request: CollectRequest, ctx: CollectContext): Promise<JsonOutcome> {
    const remaining = Date.parse(request.deadlineAt) - ctx.clock.nowMs();
    const budget = Number.isFinite(remaining) ? remaining : this.descriptor.limits.defaultTimeoutMs;
    const timeoutMs = Math.max(1, Math.min(this.descriptor.limits.defaultTimeoutMs, budget));
    let response;
    try {
      response = await ctx.http.request({
        url,
        method: "GET",
        headers: { accept: "application/json" },
        timeoutMs,
        signal: ctx.signal,
      });
    } catch (error) {
      if (ctx.signal.aborted) {
        return {
          ok: false,
          error: { kind: "TIMEOUT", message: `hackernews request aborted for ${url}`, retryable: true },
        };
      }
      return {
        ok: false,
        error: {
          kind: "NETWORK",
          message: `hackernews request failed for ${url}: ${errorName(error)}`,
          retryable: true,
        },
      };
    }
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, error: httpStatusError(response.status, url) };
    }
    try {
      return { ok: true, json: JSON.parse(response.text) as unknown };
    } catch {
      return {
        ok: false,
        error: { kind: "PARSE", message: `hackernews returned invalid JSON for ${url}`, retryable: false },
      };
    }
  }
}

function completenessOf(item: HnItem): ContentCompleteness {
  return item.text ? "EXCERPT" : "TITLE_ONLY";
}

function toObservation(payload: HnPayload, fetchedAt: string, runId: string): RawObservation {
  const { item } = payload;
  const externalId = String(item.id);
  const payloadHash = payloadHashOf(payload);
  return {
    schemaVersion: 1,
    id: observationId(HN_SOURCE_ID, externalId, payloadHash),
    sourceId: HN_SOURCE_ID,
    sourceKind: "API",
    externalId,
    originalUrl: item.url ?? hnDiscussionUrl(item.id),
    // Firebase API 는 snapshot 시각을 주지 않는다 → fetchedAt 으로 두고 플래그를 세운다.
    observedAt: fetchedAt,
    observedAtIsFetchedAt: true,
    fetchedAt,
    runId,
    payloadHash,
    payloadRef: { kind: "inline", json: payload },
    completeness: completenessOf(item),
    rawMetadata: {
      score: item.score ?? null,
      descendants: item.descendants ?? null,
      type: item.type ?? null,
    },
  };
}

function coveredWindow(window: TimeWindow, observations: RawObservation[], truncated: boolean): TimeWindow | null {
  if (!truncated) return window;
  if (observations.length === 0) return null;
  return { start: window.start, end: window.end };
}

function failed(window: TimeWindow, errors: CollectError[], itemsSeen: number): CollectResult {
  return {
    status: "FAILED",
    observations: [],
    nextCheckpoint: null,
    coverage: {
      windowRequested: window,
      windowCovered: null,
      truncated: false,
      truncationReason: null,
      itemsSeen,
    },
    errors,
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function unexpectedError(error: unknown): CollectError {
  const kind: CollectErrorKind = "UNKNOWN";
  return { kind, message: `hackernews adapter threw ${errorName(error)}`, retryable: false };
}
