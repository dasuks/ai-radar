import type { DocumentStore } from "../../ports/storage/index.js";
import type { Clock, Logger } from "../../ports/system/index.js";
import type { DocumentLink, LinkType, NormalizedDocument } from "../../domain/documents/normalized-document.js";
import { canonicalUrl } from "../../domain/documents/normalized-document.js";
import type { ContentCompleteness } from "../../domain/documents/raw-observation.js";
import type { TimeWindow } from "../../domain/shared/time.js";

export const LINK_POLICY_ID = "link-and-dedupe";
export const LINK_POLICY_VERSION = "1";

/** SAME_STORY 로 볼 최소 Jaccard 유사도 (PIPELINES §3.2 3번). */
export const SAME_STORY_MIN_JACCARD = 0.8;
/** SAME_STORY 는 48시간 안쪽에서만 본다. */
export const SAME_STORY_MAX_GAP_MS = 48 * 3_600_000;

export interface LinkAndDedupeDeps {
  documents: DocumentStore;
  clock: Clock;
  logger: Logger;
}

export interface LinkAndDedupeInput {
  window: TimeWindow;
  runId: string;
}

export interface LinkAndDedupeResult {
  links: DocumentLink[];
  /** 대표 문서 id → 같은 이야기로 묶인 문서 id 목록 (대표 포함) */
  clusters: Map<string, string[]>;
}

/**
 * 제목 비교에서 무시하는 흔한 낱말.
 *
 * 공백으로 구분한 한 문자열로 둔다: 배열 리터럴로 두면 import 스캐너가
 * 인접한 두 문자열을 import 지정자로 잘못 읽는다 (`test/architecture.test.ts`).
 */
const STOPWORDS = new Set(
  "a an the of to in for on and or with is are be as at by from that this it its was were how why what show hn ask".split(
    " ",
  ),
);

const COMPLETENESS_RANK: Record<ContentCompleteness, number> = {
  FULL: 3,
  EXCERPT: 2,
  TITLE_ONLY: 1,
  MISSING: 0,
};

/** 제목 → 정규화 토큰 집합. 결정적. */
export function titleTokens(title: string): Set<string> {
  const cleaned = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (cleaned === "") return new Set();
  const tokens = cleaned.split(/\s+/).filter((token) => token.length > 1 && !STOPWORDS.has(token));
  return new Set(tokens);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function timeOf(document: NormalizedDocument): number {
  const value = Date.parse(document.publishedAt ?? document.fetchedAt);
  return Number.isFinite(value) ? value : Number.NaN;
}

class DisjointSet {
  private readonly parent = new Map<string, string>();

  add(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  find(id: string): string {
    this.add(id);
    let current = id;
    while (this.parent.get(current) !== current) {
      const next = this.parent.get(current);
      if (next === undefined) break;
      current = next;
    }
    return current;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;
    // 결정적: 항상 사전순으로 작은 쪽이 루트가 된다.
    if (rootA < rootB) this.parent.set(rootB, rootA);
    else this.parent.set(rootA, rootB);
  }
}

/**
 * LinkAndDedupe Use Case (PIPELINES_AND_POLICIES.md §3.2 규칙 1~3).
 *
 * 규칙 기반만 쓴다 (LLM `LINK_STORIES` 는 Phase 3 이후). Dedupe 는 삭제가 아니라 link 다.
 */
export class LinkAndDedupe {
  private readonly deps: LinkAndDedupeDeps;
  private readonly log: Logger;

  constructor(deps: LinkAndDedupeDeps) {
    this.deps = deps;
    this.log = deps.logger.child("link");
  }

  async run(input: LinkAndDedupeInput): Promise<LinkAndDedupeResult> {
    const documents = await this.deps.documents.listInWindow(input.window);
    const ordered = [...documents].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const createdAt = this.deps.clock.nowIso();
    const links = new Map<string, DocumentLink>();
    const clusterOf = new DisjointSet();
    for (const document of ordered) clusterOf.add(document.id);

    const addLink = (from: string, to: string, type: LinkType, confidence: number): void => {
      if (from === to) return;
      const key = `${from}|${to}|${type}`;
      const existing = links.get(key);
      if (existing && existing.confidence >= confidence) return;
      links.set(key, {
        fromDocumentId: from,
        toDocumentId: to,
        type,
        confidence,
        provenance: {
          method: "RULE",
          policyId: LINK_POLICY_ID,
          policyVersion: LINK_POLICY_VERSION,
          runId: input.runId,
          createdAt,
        },
      });
    };

    // 1. SAME_URL: canonicalUrl 이 같으면 confidence 1.0
    const byCanonical = new Map<string, NormalizedDocument[]>();
    for (const document of ordered) {
      if (!document.canonicalUrl) continue;
      const bucket = byCanonical.get(document.canonicalUrl);
      if (bucket) bucket.push(document);
      else byCanonical.set(document.canonicalUrl, [document]);
    }
    for (const bucket of byCanonical.values()) {
      if (bucket.length < 2) continue;
      for (let i = 0; i < bucket.length; i += 1) {
        for (let j = i + 1; j < bucket.length; j += 1) {
          const left = bucket[i];
          const right = bucket[j];
          if (!left || !right) continue;
          addLink(left.id, right.id, "SAME_URL", 1);
          clusterOf.union(left.id, right.id);
        }
      }
    }

    // 2. MENTIONS_URL: 본문의 url 이 다른 문서의 canonicalUrl 이면. 이야기 묶음은 아니다.
    const byCanonicalUrl = new Map<string, NormalizedDocument>();
    for (const document of ordered) {
      if (document.canonicalUrl && !byCanonicalUrl.has(document.canonicalUrl)) {
        byCanonicalUrl.set(document.canonicalUrl, document);
      }
    }
    for (const document of ordered) {
      for (const url of document.urls) {
        const normalized = canonicalUrl(url);
        if (!normalized || normalized === document.canonicalUrl) continue;
        const target = byCanonicalUrl.get(normalized);
        if (!target || target.id === document.id) continue;
        addLink(document.id, target.id, "MENTIONS_URL", 1);
      }
    }

    // 3. SAME_STORY: 제목 토큰 Jaccard >= 0.8 이고 48시간 안쪽
    const tokens = new Map<string, Set<string>>();
    for (const document of ordered) tokens.set(document.id, titleTokens(document.title));
    for (let i = 0; i < ordered.length; i += 1) {
      for (let j = i + 1; j < ordered.length; j += 1) {
        const left = ordered[i];
        const right = ordered[j];
        if (!left || !right) continue;
        if (left.canonicalUrl && left.canonicalUrl === right.canonicalUrl) continue;
        const gap = Math.abs(timeOf(left) - timeOf(right));
        if (!Number.isFinite(gap) || gap > SAME_STORY_MAX_GAP_MS) continue;
        const similarity = jaccard(tokens.get(left.id) ?? new Set(), tokens.get(right.id) ?? new Set());
        if (similarity < SAME_STORY_MIN_JACCARD) continue;
        addLink(left.id, right.id, "SAME_STORY", similarity);
        clusterOf.union(left.id, right.id);
      }
    }

    const all = [...links.values()];
    for (const link of all) {
      await this.deps.documents.upsertLink(link);
    }

    const clusters = this.buildClusters(ordered, clusterOf);
    this.log.info("link finished", { documents: ordered.length, links: all.length, clusters: clusters.size });
    return { links: all, clusters };
  }

  /** 대표 = 가장 완전한 본문 → 가장 많은 metric → 본문 길이 → id (결정적). */
  private buildClusters(documents: readonly NormalizedDocument[], clusterOf: DisjointSet): Map<string, string[]> {
    const groups = new Map<string, NormalizedDocument[]>();
    for (const document of documents) {
      const root = clusterOf.find(document.id);
      const bucket = groups.get(root);
      if (bucket) bucket.push(document);
      else groups.set(root, [document]);
    }
    const clusters = new Map<string, string[]>();
    for (const members of groups.values()) {
      const representative = [...members].sort(compareRepresentative)[0];
      if (!representative) continue;
      clusters.set(
        representative.id,
        members.map((m) => m.id).sort(),
      );
    }
    return clusters;
  }
}

function compareRepresentative(a: NormalizedDocument, b: NormalizedDocument): number {
  const completeness = COMPLETENESS_RANK[b.contentCompleteness] - COMPLETENESS_RANK[a.contentCompleteness];
  if (completeness !== 0) return completeness;
  const metrics = b.metrics.length - a.metrics.length;
  if (metrics !== 0) return metrics;
  const length = (b.content?.length ?? 0) - (a.content?.length ?? 0);
  if (length !== 0) return length;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
