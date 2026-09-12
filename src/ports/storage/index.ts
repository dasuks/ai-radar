import type { RawObservation } from "../../domain/documents/raw-observation.js";
import type { DocumentLink, NormalizedDocument } from "../../domain/documents/normalized-document.js";
import type { Entity, EntityMention } from "../../domain/entities/entity.js";
import type { MetricObservation } from "../../domain/metrics/metric-observation.js";
import type { DerivedSignal } from "../../domain/metrics/derived-signal.js";
import type { Evidence } from "../../domain/evidence/evidence.js";
import type { Claim } from "../../domain/evidence/claim.js";
import type { AnalysisRecord, Classification } from "../../domain/evidence/analysis.js";
import type { Artifact, ArtifactHead, ArtifactType, ApprovalRecord, ChannelId, PublicationRecord } from "../../domain/artifacts/artifact.js";
import type { Run } from "../../domain/runs/run.js";
import type { DomainEvent } from "../../domain/runs/run.js";
import type { SourceCheckpoint } from "../sources/source-adapter.js";
import type { TimeWindow } from "../../domain/shared/time.js";

/**
 * Storage Ports (ARCHITECTURE.md §5, CONTRACTS_AND_DATA.md §7).
 * 모든 메서드는 idempotent 하게 설계한다: put 계열은 같은 키면 덮어쓰거나 무시하고 예외를 던지지 않는다.
 */

export interface RawStore {
  /** 같은 id가 있으면 false (신규 아님). */
  putIfAbsent(observation: RawObservation): Promise<boolean>;
  get(id: string): Promise<RawObservation | null>;
  listBySource(sourceId: string, window: TimeWindow): Promise<RawObservation[]>;
  /** payload 본문을 읽는다 (inline이면 그대로, file이면 파일에서). */
  readPayload(observation: RawObservation): Promise<unknown>;
}

export interface DocumentStore {
  upsert(document: NormalizedDocument): Promise<void>;
  get(id: string): Promise<NormalizedDocument | null>;
  getBySource(sourceId: string, externalId: string): Promise<NormalizedDocument | null>;
  /** publishedAt 또는 (null이면) fetchedAt 이 window 안인 문서 */
  listInWindow(window: TimeWindow): Promise<NormalizedDocument[]>;
  findByCanonicalUrl(url: string): Promise<NormalizedDocument[]>;
  upsertLink(link: DocumentLink): Promise<void>;
  linksOf(documentId: string): Promise<DocumentLink[]>;
}

export interface EntityStore {
  upsert(entity: Entity): Promise<void>;
  get(id: string): Promise<Entity | null>;
  findByRepositoryUrl(url: string): Promise<Entity | null>;
  findByNormalizedName(normalized: string): Promise<Entity[]>;
  upsertMention(mention: EntityMention): Promise<void>;
  mentionsOf(documentId: string): Promise<EntityMention[]>;
}

export interface MetricStore {
  /** unique 키 충돌은 무시 (idempotent). 기록된 개수 반환. */
  record(observations: MetricObservation[]): Promise<number>;
  series(subjectId: string, key: MetricObservation["key"], window: TimeWindow): Promise<MetricObservation[]>;
  upsertSignal(signal: DerivedSignal): Promise<void>;
  signals(subjectId: string, window: TimeWindow): Promise<DerivedSignal[]>;
}

export interface ClaimStore {
  putEvidence(evidence: Evidence[]): Promise<void>;
  getEvidence(ids: string[]): Promise<Evidence[]>;
  evidenceOfDocument(documentId: string): Promise<Evidence[]>;
  putAnalysis(record: AnalysisRecord): Promise<void>;
  findAnalysisByCacheKey(cacheKey: string): Promise<AnalysisRecord | null>;
  putClaims(claims: Claim[]): Promise<void>;
  claimsByAnalysis(analysisId: string): Promise<Claim[]>;
  claimsForDocuments(documentIds: string[]): Promise<Claim[]>;
  putClassification(classification: Classification, policyVersion: string): Promise<void>;
  classificationsFor(documentIds: string[], policyVersion: string): Promise<Classification[]>;
}

export interface ArtifactStore {
  head(type: ArtifactType, targetKey: string): Promise<ArtifactHead | null>;
  get<T>(type: ArtifactType, targetKey: string, revision: number): Promise<Artifact<T> | null>;
  /** 새 revision 저장 + head 갱신. contentHash 가 head 와 같으면 저장하지 않고 head 를 돌려준다. */
  putRevision<T>(artifact: Artifact<T>): Promise<ArtifactHead>;
  putApproval(approval: ApprovalRecord): Promise<void>;
  approval(artifactId: string, revision: number, channel: ChannelId): Promise<ApprovalRecord | null>;
  putPublication(record: PublicationRecord): Promise<void>;
  latestPublication(artifactId: string, channel: ChannelId): Promise<PublicationRecord | null>;
}

export interface RunStore {
  put(run: Run): Promise<void>;
  get(id: string): Promise<Run | null>;
  appendEvent(runId: string, at: string, event: DomainEvent): Promise<void>;
  latestByKind(kind: Run["kind"]): Promise<Run | null>;
}

export interface CheckpointStore {
  get(sourceId: string): Promise<SourceCheckpoint | null>;
  put(sourceId: string, checkpoint: SourceCheckpoint, runId: string, updatedAt: string): Promise<void>;
}

export interface UnitOfWork {
  /** 트랜잭션. fn 이 throw 하면 rollback. 파일 저장은 트랜잭션 밖에서 먼저 한다. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

export interface Stores {
  raw: RawStore;
  documents: DocumentStore;
  entities: EntityStore;
  metrics: MetricStore;
  claims: ClaimStore;
  artifacts: ArtifactStore;
  runs: RunStore;
  checkpoints: CheckpointStore;
  unitOfWork: UnitOfWork;
  close(): Promise<void>;
}
