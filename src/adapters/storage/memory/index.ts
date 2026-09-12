import type { Artifact, ArtifactHead, ArtifactType, ApprovalRecord, ChannelId, PublicationRecord } from "../../../domain/artifacts/artifact.js";
import type { DocumentLink, NormalizedDocument } from "../../../domain/documents/normalized-document.js";
import type { RawObservation } from "../../../domain/documents/raw-observation.js";
import type { Entity, EntityMention } from "../../../domain/entities/entity.js";
import { normalizeEntityName } from "../../../domain/entities/entity.js";
import type { AnalysisRecord, Classification } from "../../../domain/evidence/analysis.js";
import type { Claim } from "../../../domain/evidence/claim.js";
import type { Evidence } from "../../../domain/evidence/evidence.js";
import type { DerivedSignal } from "../../../domain/metrics/derived-signal.js";
import type { MetricObservation } from "../../../domain/metrics/metric-observation.js";
import type { DomainEvent, Run } from "../../../domain/runs/run.js";
import type { TimeWindow } from "../../../domain/shared/time.js";
import type {
  ArtifactStore,
  CheckpointStore,
  ClaimStore,
  DocumentStore,
  EntityStore,
  MetricStore,
  RawStore,
  RunStore,
  Stores,
  UnitOfWork,
} from "../../../ports/storage/index.js";
import type { SourceCheckpoint } from "../../../ports/sources/source-adapter.js";
import { readRawPayload } from "../fs/raw-payload.js";

/**
 * SQLite 어댑터와 같은 의미를 갖는 in-memory 구현.
 * Use Case 테스트의 test double 이며, unique key / revision 규칙은 SQLite 판과 동일하다.
 */

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function within(iso: string | null, window: TimeWindow): boolean {
  if (iso === null) return false;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return false;
  return at >= Date.parse(window.start) && at <= Date.parse(window.end);
}

function effectiveTime(document: NormalizedDocument): string {
  return document.publishedAt ?? document.fetchedAt;
}

// ---------------------------------------------------------------------------

class MemoryRawStore implements RawStore {
  readonly byId = new Map<string, RawObservation>();

  async putIfAbsent(observation: RawObservation): Promise<boolean> {
    if (this.byId.has(observation.id)) return false;
    this.byId.set(observation.id, clone(observation));
    return true;
  }

  async get(id: string): Promise<RawObservation | null> {
    const found = this.byId.get(id);
    return found === undefined ? null : clone(found);
  }

  async listBySource(sourceId: string, window: TimeWindow): Promise<RawObservation[]> {
    return [...this.byId.values()]
      .filter((observation) => observation.sourceId === sourceId && within(observation.observedAt, window))
      .sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id))
      .map(clone);
  }

  async readPayload(observation: RawObservation): Promise<unknown> {
    if (observation.payloadRef.kind === "inline") return observation.payloadRef.json;
    return readRawPayload(observation.payloadRef.path);
  }
}

class MemoryDocumentStore implements DocumentStore {
  readonly byId = new Map<string, NormalizedDocument>();
  readonly links = new Map<string, DocumentLink>();

  async upsert(document: NormalizedDocument): Promise<void> {
    this.byId.set(document.id, clone(document));
  }

  async get(id: string): Promise<NormalizedDocument | null> {
    const found = this.byId.get(id);
    return found === undefined ? null : clone(found);
  }

  async getBySource(sourceId: string, externalId: string): Promise<NormalizedDocument | null> {
    for (const document of this.byId.values()) {
      if (document.sourceId === sourceId && document.externalId === externalId) return clone(document);
    }
    return null;
  }

  async listInWindow(window: TimeWindow): Promise<NormalizedDocument[]> {
    return [...this.byId.values()]
      .filter((document) => within(effectiveTime(document), window))
      .sort((a, b) => effectiveTime(b).localeCompare(effectiveTime(a)) || a.id.localeCompare(b.id))
      .map(clone);
  }

  async findByCanonicalUrl(url: string): Promise<NormalizedDocument[]> {
    return [...this.byId.values()]
      .filter((document) => document.canonicalUrl === url)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(clone);
  }

  async upsertLink(link: DocumentLink): Promise<void> {
    this.links.set(`${link.fromDocumentId}|${link.toDocumentId}|${link.type}`, clone(link));
  }

  async linksOf(documentId: string): Promise<DocumentLink[]> {
    return [...this.links.values()]
      .filter((link) => link.fromDocumentId === documentId || link.toDocumentId === documentId)
      .sort(
        (a, b) =>
          a.fromDocumentId.localeCompare(b.fromDocumentId) ||
          a.toDocumentId.localeCompare(b.toDocumentId) ||
          a.type.localeCompare(b.type),
      )
      .map(clone);
  }
}

class MemoryEntityStore implements EntityStore {
  readonly byId = new Map<string, Entity>();
  readonly mentions = new Map<string, EntityMention>();

  async upsert(entity: Entity): Promise<void> {
    this.byId.set(entity.id, clone(entity));
  }

  async get(id: string): Promise<Entity | null> {
    const found = this.byId.get(id);
    return found === undefined ? null : clone(found);
  }

  async findByRepositoryUrl(url: string): Promise<Entity | null> {
    const matches = [...this.byId.values()].filter((entity) => entity.repositoryUrl === url);
    matches.sort((a, b) => {
      const activeDelta = Number(b.status === "ACTIVE") - Number(a.status === "ACTIVE");
      return activeDelta !== 0 ? activeDelta : a.createdAt.localeCompare(b.createdAt);
    });
    const first = matches[0];
    return first === undefined ? null : clone(first);
  }

  async findByNormalizedName(normalized: string): Promise<Entity[]> {
    return [...this.byId.values()]
      .filter(
        (entity) =>
          normalizeEntityName(entity.canonicalName) === normalized ||
          entity.aliases.some((alias) => normalizeEntityName(alias) === normalized),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(clone);
  }

  async upsertMention(mention: EntityMention): Promise<void> {
    this.mentions.set(`${mention.documentId}|${mention.surfaceForm}|${mention.locatorKey}`, clone(mention));
  }

  async mentionsOf(documentId: string): Promise<EntityMention[]> {
    return [...this.mentions.values()]
      .filter((mention) => mention.documentId === documentId)
      .sort((a, b) => a.surfaceForm.localeCompare(b.surfaceForm) || a.locatorKey.localeCompare(b.locatorKey))
      .map(clone);
  }
}

class MemoryMetricStore implements MetricStore {
  readonly observations = new Map<string, MetricObservation>();
  readonly derived = new Map<string, DerivedSignal>();

  async record(observations: MetricObservation[]): Promise<number> {
    let inserted = 0;
    for (const observation of observations) {
      const key = [
        observation.subjectType,
        observation.subjectId,
        observation.key,
        observation.sourceId,
        observation.observedAt,
      ].join("|");
      if (this.observations.has(key)) continue;
      this.observations.set(key, clone(observation));
      inserted += 1;
    }
    return inserted;
  }

  async series(subjectId: string, key: MetricObservation["key"], window: TimeWindow): Promise<MetricObservation[]> {
    return [...this.observations.values()]
      .filter(
        (observation) =>
          observation.subjectId === subjectId && observation.key === key && within(observation.observedAt, window),
      )
      .sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.sourceId.localeCompare(b.sourceId))
      .map(clone);
  }

  async upsertSignal(signal: DerivedSignal): Promise<void> {
    const key = [
      signal.subjectType,
      signal.subjectId,
      signal.key,
      signal.window.start,
      signal.window.end,
      signal.provenance.policyVersion ?? "",
    ].join("|");
    this.derived.set(key, clone(signal));
  }

  async signals(subjectId: string, window: TimeWindow): Promise<DerivedSignal[]> {
    return [...this.derived.values()]
      .filter((signal) => signal.subjectId === subjectId && within(signal.window.end, window))
      .sort(
        (a, b) =>
          a.window.end.localeCompare(b.window.end) ||
          a.key.localeCompare(b.key) ||
          (a.provenance.policyVersion ?? "").localeCompare(b.provenance.policyVersion ?? ""),
      )
      .map(clone);
  }
}

class MemoryClaimStore implements ClaimStore {
  readonly evidence = new Map<string, Evidence>();
  readonly analyses = new Map<string, AnalysisRecord>();
  readonly claims = new Map<string, Claim>();
  readonly classifications = new Map<string, Classification>();

  async putEvidence(evidence: Evidence[]): Promise<void> {
    for (const item of evidence) this.evidence.set(item.id, clone(item));
  }

  async getEvidence(ids: string[]): Promise<Evidence[]> {
    const out: Evidence[] = [];
    for (const id of ids) {
      const found = this.evidence.get(id);
      if (found !== undefined) out.push(clone(found));
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  async evidenceOfDocument(documentId: string): Promise<Evidence[]> {
    return [...this.evidence.values()]
      .filter((item) => item.documentId === documentId)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(clone);
  }

  async putAnalysis(record: AnalysisRecord): Promise<void> {
    this.analyses.set(record.id, clone(record));
  }

  async findAnalysisByCacheKey(cacheKey: string): Promise<AnalysisRecord | null> {
    const matches = [...this.analyses.values()]
      .filter((record) => record.cacheKey === cacheKey)
      .sort(
        (a, b) => b.provenance.createdAt.localeCompare(a.provenance.createdAt) || b.id.localeCompare(a.id),
      );
    const first = matches[0];
    return first === undefined ? null : clone(first);
  }

  async putClaims(claims: Claim[]): Promise<void> {
    for (const claim of claims) this.claims.set(claim.id, clone(claim));
  }

  async claimsByAnalysis(analysisId: string): Promise<Claim[]> {
    return [...this.claims.values()]
      .filter((claim) => claim.analysisId === analysisId)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(clone);
  }

  async claimsForDocuments(documentIds: string[]): Promise<Claim[]> {
    const wanted = new Set(documentIds);
    const evidenceIds = new Set<string>();
    for (const item of this.evidence.values()) {
      if (wanted.has(item.documentId)) evidenceIds.add(item.id);
    }
    return [...this.claims.values()]
      .filter((claim) => claim.evidenceIds.some((id) => evidenceIds.has(id)))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(clone);
  }

  async putClassification(classification: Classification, policyVersion: string): Promise<void> {
    this.classifications.set(`${classification.documentId}|${policyVersion}`, clone(classification));
  }

  async classificationsFor(documentIds: string[], policyVersion: string): Promise<Classification[]> {
    const out: Classification[] = [];
    for (const documentId of [...documentIds].sort((a, b) => a.localeCompare(b))) {
      const found = this.classifications.get(`${documentId}|${policyVersion}`);
      if (found !== undefined) out.push(clone(found));
    }
    return out;
  }
}

interface StoredArtifact {
  artifact: Artifact<unknown>;
}

class MemoryArtifactStore implements ArtifactStore {
  readonly revisions = new Map<string, StoredArtifact>();
  readonly heads = new Map<string, ArtifactHead>();
  readonly approvals = new Map<string, ApprovalRecord>();
  readonly publications = new Map<string, PublicationRecord>();

  async head(type: ArtifactType, targetKey: string): Promise<ArtifactHead | null> {
    const found = this.heads.get(`${type}|${targetKey}`);
    return found === undefined ? null : { ...found };
  }

  async get<T>(type: ArtifactType, targetKey: string, revision: number): Promise<Artifact<T> | null> {
    const found = this.revisions.get(`${type}|${targetKey}|${revision}`);
    return found === undefined ? null : (clone(found.artifact) as Artifact<T>);
  }

  async putRevision<T>(artifact: Artifact<T>): Promise<ArtifactHead> {
    const headKey = `${artifact.type}|${artifact.targetKey}`;
    const head = this.heads.get(headKey) ?? null;
    if (head !== null) {
      const current = this.revisions.get(`${headKey}|${head.revision}`);
      if (current !== undefined && current.artifact.contentHash === artifact.contentHash) return { ...head };
    }
    const revision = head === null ? (artifact.revision >= 1 ? artifact.revision : 1)
      : artifact.revision > head.revision ? artifact.revision : head.revision + 1;
    const stored = clone(artifact) as Artifact<unknown>;
    stored.revision = revision;
    this.revisions.set(`${headKey}|${revision}`, { artifact: stored });
    const newHead: ArtifactHead = { type: artifact.type, targetKey: artifact.targetKey, revision };
    this.heads.set(headKey, newHead);
    return { ...newHead };
  }

  async putApproval(approval: ApprovalRecord): Promise<void> {
    this.approvals.set(`${approval.artifactId}|${approval.revision}|${approval.channel}`, clone(approval));
  }

  async approval(artifactId: string, revision: number, channel: ChannelId): Promise<ApprovalRecord | null> {
    const found = this.approvals.get(`${artifactId}|${revision}|${channel}`);
    return found === undefined ? null : clone(found);
  }

  async putPublication(record: PublicationRecord): Promise<void> {
    this.publications.set(`${record.artifactId}|${record.channel}|${record.revision}`, clone(record));
  }

  async latestPublication(artifactId: string, channel: ChannelId): Promise<PublicationRecord | null> {
    const matches = [...this.publications.values()]
      .filter((record) => record.artifactId === artifactId && record.channel === channel)
      .sort((a, b) => b.revision - a.revision);
    const first = matches[0];
    return first === undefined ? null : clone(first);
  }
}

class MemoryRunStore implements RunStore {
  readonly byId = new Map<string, Run>();
  readonly eventLog: { runId: string; at: string; event: DomainEvent }[] = [];

  async put(run: Run): Promise<void> {
    this.byId.set(run.id, clone(run));
  }

  async get(id: string): Promise<Run | null> {
    const found = this.byId.get(id);
    return found === undefined ? null : clone(found);
  }

  async appendEvent(runId: string, at: string, event: DomainEvent): Promise<void> {
    this.eventLog.push({ runId, at, event: clone(event) });
  }

  async latestByKind(kind: Run["kind"]): Promise<Run | null> {
    const matches = [...this.byId.values()]
      .filter((run) => run.kind === kind)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
    const first = matches[0];
    return first === undefined ? null : clone(first);
  }

  /** 디버깅·테스트용 read model. Port 계약은 아니다. */
  async events(runId: string): Promise<{ at: string; event: DomainEvent }[]> {
    return this.eventLog
      .filter((entry) => entry.runId === runId)
      .map((entry) => ({ at: entry.at, event: clone(entry.event) }));
  }
}

class MemoryCheckpointStore implements CheckpointStore {
  readonly byId = new Map<string, { checkpoint: SourceCheckpoint; runId: string; updatedAt: string }>();

  async get(sourceId: string): Promise<SourceCheckpoint | null> {
    const found = this.byId.get(sourceId);
    return found === undefined ? null : clone(found.checkpoint);
  }

  async put(sourceId: string, checkpoint: SourceCheckpoint, runId: string, updatedAt: string): Promise<void> {
    this.byId.set(sourceId, { checkpoint: clone(checkpoint), runId, updatedAt });
  }
}

class MemoryUnitOfWork implements UnitOfWork {
  /** rollback 이 없으므로 중첩 여부와 무관하게 fn 을 그대로 실행한다. */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

export interface MemoryStores extends Stores {
  raw: MemoryRawStore;
  documents: MemoryDocumentStore;
  entities: MemoryEntityStore;
  metrics: MemoryMetricStore;
  claims: MemoryClaimStore;
  artifacts: MemoryArtifactStore;
  runs: MemoryRunStore;
  checkpoints: MemoryCheckpointStore;
}

/** Use Case 테스트용 Stores 구현. SQLite 판과 같은 semantics 를 갖는다. */
export function createMemoryStores(): MemoryStores {
  return {
    raw: new MemoryRawStore(),
    documents: new MemoryDocumentStore(),
    entities: new MemoryEntityStore(),
    metrics: new MemoryMetricStore(),
    claims: new MemoryClaimStore(),
    artifacts: new MemoryArtifactStore(),
    runs: new MemoryRunStore(),
    checkpoints: new MemoryCheckpointStore(),
    unitOfWork: new MemoryUnitOfWork(),
    async close(): Promise<void> {
      // in-memory 는 닫을 자원이 없다.
    },
  };
}
