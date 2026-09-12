/** 분석/브리핑 Use Case 테스트용 in-memory Store 와 결정적 Clock/Random. */
import type { NormalizedDocument, DocumentLink } from "../../src/domain/documents/normalized-document.js";
import type { AnalysisRecord, Classification } from "../../src/domain/evidence/analysis.js";
import type { Claim } from "../../src/domain/evidence/claim.js";
import type { Evidence } from "../../src/domain/evidence/evidence.js";
import type { Entity, EntityMention } from "../../src/domain/entities/entity.js";
import type { ClaimStore, DocumentStore, EntityStore } from "../../src/ports/storage/index.js";
import type { Clock, RandomSource } from "../../src/ports/system/index.js";
import type { TimeWindow } from "../../src/domain/shared/time.js";
import { isWithinWindow } from "../../src/domain/shared/time.js";

export class FakeClock implements Clock {
  constructor(private ms = Date.UTC(2026, 8, 12, 0, 0, 0)) {}
  nowMs(): number {
    this.ms += 1;
    return this.ms;
  }
  nowIso(): string {
    return new Date(this.ms).toISOString();
  }
}

/** 호출마다 다른 바이트를 주는 결정적 random (ULID 충돌 방지). */
export function counterRandom(): RandomSource {
  let counter = 0;
  return {
    bytes(n: number): Uint8Array {
      counter += 1;
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i += 1) out[i] = (counter * 31 + i) % 251;
      return out;
    },
  };
}

export class FakeClaimStore implements ClaimStore {
  readonly evidence = new Map<string, Evidence>();
  readonly analyses: AnalysisRecord[] = [];
  readonly claims = new Map<string, Claim>();
  readonly classifications = new Map<string, { classification: Classification; policyVersion: string }>();

  async putEvidence(evidence: Evidence[]): Promise<void> {
    for (const item of evidence) this.evidence.set(item.id, item);
  }
  async getEvidence(ids: string[]): Promise<Evidence[]> {
    return ids.map((id) => this.evidence.get(id)).filter((item): item is Evidence => item !== undefined);
  }
  async evidenceOfDocument(documentId: string): Promise<Evidence[]> {
    return [...this.evidence.values()].filter((item) => item.documentId === documentId);
  }
  async putAnalysis(record: AnalysisRecord): Promise<void> {
    const index = this.analyses.findIndex((existing) => existing.id === record.id);
    if (index >= 0) this.analyses[index] = record;
    else this.analyses.push(record);
  }
  async findAnalysisByCacheKey(cacheKey: string): Promise<AnalysisRecord | null> {
    return this.analyses.find((record) => record.cacheKey === cacheKey) ?? null;
  }
  async putClaims(claims: Claim[]): Promise<void> {
    for (const claim of claims) this.claims.set(claim.id, claim);
  }
  async claimsByAnalysis(analysisId: string): Promise<Claim[]> {
    return [...this.claims.values()].filter((claim) => claim.analysisId === analysisId);
  }
  async claimsForDocuments(documentIds: string[]): Promise<Claim[]> {
    const wanted = new Set(documentIds);
    return [...this.claims.values()].filter((claim) =>
      claim.evidenceIds.some((id) => {
        const evidence = this.evidence.get(id);
        return evidence !== undefined && wanted.has(evidence.documentId);
      }),
    );
  }
  async putClassification(classification: Classification, policyVersion: string): Promise<void> {
    this.classifications.set(`${classification.documentId}|${policyVersion}`, { classification, policyVersion });
  }
  async classificationsFor(documentIds: string[], policyVersion: string): Promise<Classification[]> {
    const out: Classification[] = [];
    for (const documentId of documentIds) {
      const entry = this.classifications.get(`${documentId}|${policyVersion}`);
      if (entry) out.push(entry.classification);
    }
    return out;
  }
}

export class FakeEntityStore implements EntityStore {
  readonly entities = new Map<string, Entity>();
  readonly mentions: EntityMention[] = [];

  async upsert(entity: Entity): Promise<void> {
    this.entities.set(entity.id, entity);
  }
  async get(id: string): Promise<Entity | null> {
    return this.entities.get(id) ?? null;
  }
  async findByRepositoryUrl(url: string): Promise<Entity | null> {
    return [...this.entities.values()].find((entity) => entity.repositoryUrl === url) ?? null;
  }
  async findByNormalizedName(normalized: string): Promise<Entity[]> {
    return [...this.entities.values()].filter((entity) => entity.canonicalName.toLowerCase() === normalized);
  }
  async upsertMention(mention: EntityMention): Promise<void> {
    this.mentions.push(mention);
  }
  async mentionsOf(documentId: string): Promise<EntityMention[]> {
    return this.mentions.filter((mention) => mention.documentId === documentId);
  }
}

export class FakeDocumentStore implements DocumentStore {
  readonly documents = new Map<string, NormalizedDocument>();
  readonly links: DocumentLink[] = [];

  async upsert(document: NormalizedDocument): Promise<void> {
    this.documents.set(document.id, document);
  }
  async get(id: string): Promise<NormalizedDocument | null> {
    return this.documents.get(id) ?? null;
  }
  async getBySource(sourceId: string, externalId: string): Promise<NormalizedDocument | null> {
    return (
      [...this.documents.values()].find(
        (document) => document.sourceId === sourceId && document.externalId === externalId,
      ) ?? null
    );
  }
  async listInWindow(window: TimeWindow): Promise<NormalizedDocument[]> {
    return [...this.documents.values()].filter((document) =>
      isWithinWindow(document.publishedAt ?? document.fetchedAt, window),
    );
  }
  async findByCanonicalUrl(url: string): Promise<NormalizedDocument[]> {
    return [...this.documents.values()].filter((document) => document.canonicalUrl === url);
  }
  async upsertLink(link: DocumentLink): Promise<void> {
    this.links.push(link);
  }
  async linksOf(documentId: string): Promise<DocumentLink[]> {
    return this.links.filter((link) => link.fromDocumentId === documentId);
  }
}

export interface DocumentOverrides {
  id?: string;
  sourceId?: string;
  title?: string;
  content?: string | null;
  canonicalUrl?: string | null;
  urls?: string[];
  tags?: string[];
  publishedAt?: string | null;
  comments?: NormalizedDocument["comments"];
  metrics?: NormalizedDocument["metrics"];
  contentCompleteness?: NormalizedDocument["contentCompleteness"];
}

export function makeDocument(overrides: DocumentOverrides = {}): NormalizedDocument {
  const id = overrides.id ?? "doc_test0000000000000001";
  return {
    schemaVersion: 1,
    id,
    sourceId: overrides.sourceId ?? "hackernews",
    externalId: id.replace("doc_", ""),
    latestObservationId: `obs_${id}`,
    firstObservationId: `obs_${id}`,
    title: overrides.title ?? "테스트 문서",
    content: overrides.content === undefined ? "본문 첫 문단입니다.\n\n본문 둘째 문단입니다." : overrides.content,
    contentCompleteness: overrides.contentCompleteness ?? "FULL",
    author: { name: null, externalId: null, url: null },
    language: "ko",
    publishedAt: overrides.publishedAt === undefined ? "2026-09-12T00:00:00.000Z" : overrides.publishedAt,
    updatedAt: null,
    fetchedAt: "2026-09-12T01:00:00.000Z",
    canonicalUrl: overrides.canonicalUrl === undefined ? "https://example.com/a" : overrides.canonicalUrl,
    urls: overrides.urls ?? [],
    comments: overrides.comments ?? [],
    metrics: overrides.metrics ?? [],
    tags: overrides.tags ?? [],
    status: "ACTIVE",
    provenance: { normalizerVersion: "1", runId: "run_test", normalizedAt: "2026-09-12T01:00:00.000Z" },
  };
}
