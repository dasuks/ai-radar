import type {
  CollectContext,
  CollectRequest,
  CollectResult,
  NormalizeInput,
  SourceAdapter,
  SourceCheckpoint,
  SourceDescriptor,
} from "../../../ports/sources/source-adapter.js";
import type { NormalizedDocument } from "../../../domain/documents/normalized-document.js";
import type { RawObservation } from "../../../domain/documents/raw-observation.js";
import type { HttpResponse } from "../../../ports/system/index.js";
import type { TimeWindow } from "../../../domain/shared/time.js";
import { isWithinWindow } from "../../../domain/shared/time.js";
import { observationId, payloadHashOf } from "../../../domain/shared/ids.js";
import { parseFeed, type ParsedFeedItem } from "./feed.js";
import { normalizeRss, RSS_SOURCE_ID_PREFIX, type RssPayload } from "./normalize.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_ITEMS_PER_RUN = 100;
/** checkpoint 에 남기는 guid 개수 상한 */
const MAX_SEEN_GUIDS = 500;

type CollectError = CollectResult["errors"][number];
type TruncationReason = CollectResult["coverage"]["truncationReason"];

export interface RssFeedConfig {
  /** 짧은 안정 키. sourceId 는 `rss:<id>`, 문서 tag 로도 쓴다 */
  id: string;
  /** 사람이 읽는 이름 (license.name 에 쓴다) */
  name: string;
  /** 피드 URL */
  url: string;
}

interface RssCheckpointData {
  lastSeenGuids: string[];
  etag: string | null;
  lastModified: string | null;
}

const EMPTY_CHECKPOINT: RssCheckpointData = { lastSeenGuids: [], etag: null, lastModified: null };

function readCheckpoint(checkpoint: SourceCheckpoint | null): RssCheckpointData {
  if (!checkpoint || checkpoint.schemaVersion !== 1) return EMPTY_CHECKPOINT;
  const data = checkpoint.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return EMPTY_CHECKPOINT;
  const raw = data as Record<string, unknown>;
  const guids = Array.isArray(raw.lastSeenGuids)
    ? raw.lastSeenGuids.filter((g): g is string => typeof g === "string")
    : [];
  return {
    lastSeenGuids: guids.slice(0, MAX_SEEN_GUIDS),
    etag: typeof raw.etag === "string" ? raw.etag : null,
    lastModified: typeof raw.lastModified === "string" ? raw.lastModified : null,
  };
}

function toCheckpoint(data: RssCheckpointData): SourceCheckpoint {
  return { schemaVersion: 1, data };
}

function headerOf(response: HttpResponse, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(response.headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return null;
}

function httpStatusError(status: number, feedId: string): CollectError {
  if (status === 429) {
    return { kind: "RATE_LIMIT", message: `rss:${feedId} responded 429`, retryable: true };
  }
  if (status >= 500) {
    return { kind: "NETWORK", message: `rss:${feedId} responded ${status}`, retryable: true };
  }
  return { kind: "ACCESS", message: `rss:${feedId} responded ${status}`, retryable: false };
}

/**
 * 피드 하나를 담당하는 RSS 2.0 / Atom source adapter (PIPELINES_AND_POLICIES.md §2).
 *
 * - 피드마다 인스턴스 하나. sourceId 는 `rss:<id>`.
 * - stateless: 이미 본 guid 는 checkpoint 로 주고받는다.
 * - ETag / Last-Modified 는 checkpoint 에 실어 조건부 GET 에 쓴다 (304 → 새 항목 없음).
 * - 피드 본문 문자열은 로그에 남기지 않는다 (INTEGRATIONS §5.1).
 */
export class RssSource implements SourceAdapter {
  readonly descriptor: SourceDescriptor;
  private readonly feed: RssFeedConfig;

  constructor(feed: RssFeedConfig) {
    this.feed = { id: feed.id, name: feed.name, url: feed.url };
    this.descriptor = {
      id: `${RSS_SOURCE_ID_PREFIX}${feed.id}`,
      kind: "RSS",
      capabilities: {
        timeWindow: false,
        cursor: false,
        checkpoint: true,
        comments: false,
        metrics: [],
        expectedCompleteness: "EXCERPT",
      },
      limits: { requestsPerMinute: null, maxItemsPerRun: MAX_ITEMS_PER_RUN, defaultTimeoutMs: DEFAULT_TIMEOUT_MS },
      license: { name: `${feed.name} (feed)`, url: feed.url, attributionRequired: true },
    };
  }

  async collect(request: CollectRequest, ctx: CollectContext): Promise<CollectResult> {
    const log = ctx.logger.child(this.descriptor.id);
    const fetchedAt = ctx.clock.nowIso();
    const previous = readCheckpoint(request.checkpoint);

    try {
      const headers: Record<string, string> = { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" };
      if (previous.etag) headers["if-none-match"] = previous.etag;
      if (previous.lastModified) headers["if-modified-since"] = previous.lastModified;

      const remaining = Date.parse(request.deadlineAt) - ctx.clock.nowMs();
      const budget = Number.isFinite(remaining) ? remaining : DEFAULT_TIMEOUT_MS;
      let response: HttpResponse;
      try {
        response = await ctx.http.request({
          url: this.feed.url,
          method: "GET",
          headers,
          timeoutMs: Math.max(1, Math.min(DEFAULT_TIMEOUT_MS, budget)),
          signal: ctx.signal,
        });
      } catch (error) {
        if (ctx.signal.aborted) {
          return this.failed(request.window, [
            { kind: "TIMEOUT", message: `${this.descriptor.id} request aborted`, retryable: true },
          ]);
        }
        return this.failed(request.window, [
          { kind: "NETWORK", message: `${this.descriptor.id} request failed: ${errorName(error)}`, retryable: true },
        ]);
      }

      if (response.status === 304) {
        log.info("rss feed not modified", { itemsSeen: 0 });
        return {
          status: "COMPLETE",
          observations: [],
          nextCheckpoint: toCheckpoint(previous),
          coverage: {
            windowRequested: request.window,
            windowCovered: request.window,
            truncated: false,
            truncationReason: null,
            itemsSeen: 0,
          },
          errors: [],
        };
      }
      if (response.status < 200 || response.status >= 300) {
        return this.failed(request.window, [httpStatusError(response.status, this.feed.id)]);
      }

      const parsed = parseFeed(response.text);
      if (!parsed) {
        return this.failed(request.window, [
          { kind: "PARSE", message: `${this.descriptor.id} response is not RSS 2.0 or Atom`, retryable: false },
        ]);
      }

      const seen = new Set(previous.lastSeenGuids);
      const observations: RawObservation[] = [];
      const freshGuids: string[] = [];
      let itemsSeen = 0;
      let truncationReason: TruncationReason = null;

      for (const parsedItem of parsed.items) {
        if (this.pastDeadline(request, ctx)) {
          truncationReason = "DEADLINE";
          break;
        }
        itemsSeen += 1;
        const { item } = parsedItem;
        if (seen.has(item.externalId)) continue;
        // 날짜를 주지 않는 피드는 그대로 통과시키고 payloadHash dedupe 에 맡긴다.
        if (item.publishedAt !== null && !isWithinWindow(item.publishedAt, request.window)) continue;
        if (observations.length >= request.maxItems) {
          truncationReason = "MAX_ITEMS";
          break;
        }
        observations.push(this.toObservation(parsedItem, parsed.feedTitle, fetchedAt, request.runId));
        freshGuids.push(item.externalId);
      }

      const truncated = truncationReason !== null;
      const nextCheckpoint = toCheckpoint({
        lastSeenGuids: dedupe([...freshGuids, ...previous.lastSeenGuids]).slice(0, MAX_SEEN_GUIDS),
        etag: headerOf(response, "etag"),
        lastModified: headerOf(response, "last-modified"),
      });

      log.info("rss collect finished", {
        itemsSeen,
        observations: observations.length,
        truncationReason,
      });

      return {
        status: truncated ? "PARTIAL" : "COMPLETE",
        observations,
        nextCheckpoint,
        coverage: {
          windowRequested: request.window,
          windowCovered: truncated ? (observations.length > 0 ? request.window : null) : request.window,
          truncated,
          truncationReason,
          itemsSeen,
        },
        errors: [],
      };
    } catch (error) {
      return this.failed(request.window, [
        { kind: "UNKNOWN", message: `${this.descriptor.id} adapter threw ${errorName(error)}`, retryable: false },
      ]);
    }
  }

  normalize(input: NormalizeInput): NormalizedDocument {
    return normalizeRss(input);
  }

  private pastDeadline(request: CollectRequest, ctx: CollectContext): boolean {
    if (ctx.signal.aborted) return true;
    const deadline = Date.parse(request.deadlineAt);
    return Number.isFinite(deadline) && ctx.clock.nowMs() >= deadline;
  }

  private toObservation(
    parsedItem: ParsedFeedItem,
    feedTitle: string | null,
    fetchedAt: string,
    runId: string,
  ): RawObservation {
    const payload: RssPayload = { item: parsedItem.item, rawXml: parsedItem.rawXml };
    const payloadHash = payloadHashOf(payload);
    const externalId = parsedItem.item.externalId;
    return {
      schemaVersion: 1,
      id: observationId(this.descriptor.id, externalId, payloadHash),
      sourceId: this.descriptor.id,
      sourceKind: "RSS",
      externalId,
      originalUrl: parsedItem.item.link,
      // 피드는 snapshot 시각을 주지 않는다 → fetchedAt 으로 두고 플래그를 세운다.
      observedAt: fetchedAt,
      observedAtIsFetchedAt: true,
      fetchedAt,
      runId,
      payloadHash,
      payloadRef: { kind: "inline", json: payload },
      completeness: parsedItem.item.completeness,
      rawMetadata: {
        feedId: this.feed.id,
        feedTitle,
        hasContent: parsedItem.item.contentHtml !== null,
      },
    };
  }

  private failed(window: TimeWindow, errors: CollectError[]): CollectResult {
    return {
      status: "FAILED",
      observations: [],
      nextCheckpoint: null,
      coverage: {
        windowRequested: window,
        windowCovered: null,
        truncated: false,
        truncationReason: null,
        itemsSeen: 0,
      },
      errors,
    };
  }
}

/** 피드 설정 목록 → adapter 목록 (composition root 에서 쓴다). */
export function createRssSources(feeds: readonly RssFeedConfig[]): RssSource[] {
  const seen = new Set<string>();
  const out: RssSource[] = [];
  for (const feed of feeds) {
    if (seen.has(feed.id)) throw new Error(`duplicate rss feed id: ${feed.id}`);
    seen.add(feed.id);
    out.push(new RssSource(feed));
  }
  return out;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
