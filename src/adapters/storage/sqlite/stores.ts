import path from "node:path";
import type { Artifact, ArtifactHead, ArtifactType, ApprovalRecord, ChannelId, PublicationRecord } from "../../../domain/artifacts/artifact.js";
import type { DocumentLink, NormalizedDocument } from "../../../domain/documents/normalized-document.js";
import type { PayloadRef, RawObservation, SourceKind } from "../../../domain/documents/raw-observation.js";
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
  UnitOfWork,
} from "../../../ports/storage/index.js";
import type { SourceCheckpoint } from "../../../ports/sources/source-adapter.js";
import { artifactBodyRef, readArtifactBody, writeArtifactBody } from "../fs/artifact-body.js";
import { readRawPayload } from "../fs/raw-payload.js";
import type { SqlRow, SqliteDriver } from "./driver.js";
import { bool, json, num, placeholders, text, textOrNull } from "./row.js";

// ---------------------------------------------------------------------------
// Unit of work
// ---------------------------------------------------------------------------

export class SqliteUnitOfWork implements UnitOfWork {
  #depth = 0;

  constructor(private readonly db: SqliteDriver) {}

  /** 중첩 호출은 바깥 트랜잭션을 재사용한다. */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#depth > 0) {
      this.#depth += 1;
      try {
        return await fn();
      } finally {
        this.#depth -= 1;
      }
    }
    this.db.exec("BEGIN");
    this.#depth = 1;
    try {
      const result = await fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.#depth = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Raw
// ---------------------------------------------------------------------------

const RAW_COLUMNS =
  "id, source_id, source_kind, external_id, payload_hash, original_url, observed_at, observed_at_is_fetched_at, fetched_at, run_id, completeness, payload_ref_json, raw_metadata_json, schema_version";

export class SqliteRawStore implements RawStore {
  constructor(
    private readonly db: SqliteDriver,
    private readonly rawPayloadRoot: string,
  ) {}

  async putIfAbsent(observation: RawObservation): Promise<boolean> {
    const changes = this.db.run(
      `INSERT OR IGNORE INTO raw_observations (${RAW_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        observation.id,
        observation.sourceId,
        observation.sourceKind,
        observation.externalId,
        observation.payloadHash,
        observation.originalUrl,
        observation.observedAt,
        observation.observedAtIsFetchedAt ? 1 : 0,
        observation.fetchedAt,
        observation.runId,
        observation.completeness,
        JSON.stringify(observation.payloadRef),
        JSON.stringify(observation.rawMetadata),
        observation.schemaVersion,
      ],
    );
    return changes > 0;
  }

  async get(id: string): Promise<RawObservation | null> {
    const row = this.db.get(`SELECT ${RAW_COLUMNS} FROM raw_observations WHERE id = ?`, [id]);
    return row === null ? null : toRawObservation(row);
  }

  async listBySource(sourceId: string, window: TimeWindow): Promise<RawObservation[]> {
    const rows = this.db.all(
      `SELECT ${RAW_COLUMNS} FROM raw_observations
       WHERE source_id = ? AND observed_at >= ? AND observed_at <= ?
       ORDER BY observed_at ASC, id ASC`,
      [sourceId, window.start, window.end],
    );
    return rows.map(toRawObservation);
  }

  async readPayload(observation: RawObservation): Promise<unknown> {
    return readPayloadRef(observation.payloadRef, this.rawPayloadRoot);
  }
}

export async function readPayloadRef(ref: PayloadRef, root: string): Promise<unknown> {
  if (ref.kind === "inline") return ref.json;
  const target = path.isAbsolute(ref.path) ? ref.path : path.resolve(root, ref.path);
  return readRawPayload(target);
}

function toRawObservation(row: SqlRow): RawObservation {
  return {
    schemaVersion: 1,
    id: text(row, "id"),
    sourceId: text(row, "source_id"),
    sourceKind: text(row, "source_kind") as SourceKind,
    externalId: text(row, "external_id"),
    originalUrl: textOrNull(row, "original_url"),
    observedAt: text(row, "observed_at"),
    observedAtIsFetchedAt: bool(row, "observed_at_is_fetched_at"),
    fetchedAt: text(row, "fetched_at"),
    runId: text(row, "run_id"),
    payloadHash: text(row, "payload_hash"),
    payloadRef: json<PayloadRef>(row, "payload_ref_json", { kind: "inline", json: null }),
    completeness: text(row, "completeness") as RawObservation["completeness"],
    rawMetadata: json<RawObservation["rawMetadata"]>(row, "raw_metadata_json", {}),
  };
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export class SqliteDocumentStore implements DocumentStore {
  constructor(private readonly db: SqliteDriver) {}

  async upsert(document: NormalizedDocument): Promise<void> {
    this.db.run(
      `INSERT INTO documents (
         id, source_id, external_id, latest_observation_id, first_observation_id, title, canonical_url,
         published_at, updated_at, fetched_at, content_completeness, language, status, document_json, schema_version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         latest_observation_id = excluded.latest_observation_id,
         first_observation_id = excluded.first_observation_id,
         title = excluded.title,
         canonical_url = excluded.canonical_url,
         published_at = excluded.published_at,
         updated_at = excluded.updated_at,
         fetched_at = excluded.fetched_at,
         content_completeness = excluded.content_completeness,
         language = excluded.language,
         status = excluded.status,
         document_json = excluded.document_json,
         schema_version = excluded.schema_version`,
      [
        document.id,
        document.sourceId,
        document.externalId,
        document.latestObservationId,
        document.firstObservationId,
        document.title,
        document.canonicalUrl,
        document.publishedAt,
        document.updatedAt,
        document.fetchedAt,
        document.contentCompleteness,
        document.language,
        document.status,
        JSON.stringify(document),
        document.schemaVersion,
      ],
    );
  }

  async get(id: string): Promise<NormalizedDocument | null> {
    const row = this.db.get("SELECT document_json FROM documents WHERE id = ?", [id]);
    return row === null ? null : json<NormalizedDocument | null>(row, "document_json", null);
  }

  async getBySource(sourceId: string, externalId: string): Promise<NormalizedDocument | null> {
    const row = this.db.get("SELECT document_json FROM documents WHERE source_id = ? AND external_id = ?", [
      sourceId,
      externalId,
    ]);
    return row === null ? null : json<NormalizedDocument | null>(row, "document_json", null);
  }

  /** publishedAt 이 없으면 fetchedAt 으로 판정한다 (CONTRACTS_AND_DATA.md §1.2). */
  async listInWindow(window: TimeWindow): Promise<NormalizedDocument[]> {
    const rows = this.db.all(
      `SELECT document_json FROM documents
       WHERE COALESCE(published_at, fetched_at) >= ? AND COALESCE(published_at, fetched_at) <= ?
       ORDER BY COALESCE(published_at, fetched_at) DESC, id ASC`,
      [window.start, window.end],
    );
    return collectJson<NormalizedDocument>(rows, "document_json");
  }

  async findByCanonicalUrl(url: string): Promise<NormalizedDocument[]> {
    const rows = this.db.all("SELECT document_json FROM documents WHERE canonical_url = ? ORDER BY id ASC", [url]);
    return collectJson<NormalizedDocument>(rows, "document_json");
  }

  async upsertLink(link: DocumentLink): Promise<void> {
    this.db.run(
      `INSERT INTO document_links (from_document_id, to_document_id, type, confidence, provenance_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(from_document_id, to_document_id, type) DO UPDATE SET
         confidence = excluded.confidence, provenance_json = excluded.provenance_json`,
      [link.fromDocumentId, link.toDocumentId, link.type, link.confidence, JSON.stringify(link.provenance)],
    );
  }

  async linksOf(documentId: string): Promise<DocumentLink[]> {
    const rows = this.db.all(
      `SELECT from_document_id, to_document_id, type, confidence, provenance_json FROM document_links
       WHERE from_document_id = ? OR to_document_id = ?
       ORDER BY from_document_id ASC, to_document_id ASC, type ASC`,
      [documentId, documentId],
    );
    return rows.map((row) => ({
      fromDocumentId: text(row, "from_document_id"),
      toDocumentId: text(row, "to_document_id"),
      type: text(row, "type") as DocumentLink["type"],
      confidence: num(row, "confidence"),
      provenance: json<DocumentLink["provenance"]>(row, "provenance_json", { method: "RULE", runId: "", createdAt: "" }),
    }));
  }
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export class SqliteEntityStore implements EntityStore {
  constructor(private readonly db: SqliteDriver) {}

  async upsert(entity: Entity): Promise<void> {
    this.db.run(
      `INSERT INTO entities (
         id, type, canonical_name, normalized_name, official_url, repository_url, ecosystem, parent_entity_id,
         identity_confidence, status, merged_into_id, entity_json, schema_version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         type = excluded.type, canonical_name = excluded.canonical_name, normalized_name = excluded.normalized_name,
         official_url = excluded.official_url, repository_url = excluded.repository_url, ecosystem = excluded.ecosystem,
         parent_entity_id = excluded.parent_entity_id, identity_confidence = excluded.identity_confidence,
         status = excluded.status, merged_into_id = excluded.merged_into_id, entity_json = excluded.entity_json,
         schema_version = excluded.schema_version, updated_at = excluded.updated_at`,
      [
        entity.id,
        entity.type,
        entity.canonicalName,
        normalizeEntityName(entity.canonicalName),
        entity.officialUrl,
        entity.repositoryUrl,
        entity.ecosystem,
        entity.parentEntityId,
        entity.identityConfidence,
        entity.status,
        entity.mergedIntoId,
        JSON.stringify(entity),
        entity.schemaVersion,
        entity.createdAt,
        entity.updatedAt,
      ],
    );
    // Entity.aliases 는 문자열 배열이므로 alias source 는 OBSERVED 로 기록한다 (§2.1 EntityAlias).
    this.db.run("DELETE FROM entity_aliases WHERE entity_id = ?", [entity.id]);
    for (const alias of entity.aliases) {
      this.db.run(
        `INSERT OR IGNORE INTO entity_aliases (entity_id, alias, normalized, source) VALUES (?, ?, ?, ?)`,
        [entity.id, alias, normalizeEntityName(alias), "OBSERVED"],
      );
    }
  }

  async get(id: string): Promise<Entity | null> {
    const row = this.db.get("SELECT entity_json FROM entities WHERE id = ?", [id]);
    return row === null ? null : json<Entity | null>(row, "entity_json", null);
  }

  async findByRepositoryUrl(url: string): Promise<Entity | null> {
    const row = this.db.get(
      "SELECT entity_json FROM entities WHERE repository_url = ? ORDER BY status = 'ACTIVE' DESC, created_at ASC",
      [url],
    );
    return row === null ? null : json<Entity | null>(row, "entity_json", null);
  }

  /** entities.normalized_name 과 entity_aliases.normalized 를 함께 본다. */
  async findByNormalizedName(normalized: string): Promise<Entity[]> {
    const rows = this.db.all(
      `SELECT entity_json, created_at FROM entities WHERE normalized_name = ?
       UNION
       SELECT e.entity_json, e.created_at FROM entities e
         JOIN entity_aliases a ON a.entity_id = e.id WHERE a.normalized = ?
       ORDER BY created_at ASC`,
      [normalized, normalized],
    );
    return collectJson<Entity>(rows, "entity_json");
  }

  async upsertMention(mention: EntityMention): Promise<void> {
    this.db.run(
      `INSERT INTO entity_mentions (
         document_id, surface_form, locator_key, entity_id, resolution, candidate_ids_json, confidence, mention_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(document_id, surface_form, locator_key) DO UPDATE SET
         entity_id = excluded.entity_id, resolution = excluded.resolution,
         candidate_ids_json = excluded.candidate_ids_json, confidence = excluded.confidence,
         mention_json = excluded.mention_json`,
      [
        mention.documentId,
        mention.surfaceForm,
        mention.locatorKey,
        mention.entityId,
        mention.resolution,
        JSON.stringify(mention.candidateEntityIds),
        mention.confidence,
        JSON.stringify(mention),
      ],
    );
  }

  async mentionsOf(documentId: string): Promise<EntityMention[]> {
    const rows = this.db.all(
      "SELECT mention_json FROM entity_mentions WHERE document_id = ? ORDER BY surface_form ASC, locator_key ASC",
      [documentId],
    );
    return collectJson<EntityMention>(rows, "mention_json");
  }
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export class SqliteMetricStore implements MetricStore {
  constructor(private readonly db: SqliteDriver) {}

  /** unique 키 충돌은 무시하고 실제로 새로 들어간 row 수만 센다 (§8 Metric). */
  async record(observations: MetricObservation[]): Promise<number> {
    let inserted = 0;
    for (const observation of observations) {
      inserted += this.db.run(
        `INSERT OR IGNORE INTO metric_observations (
           subject_type, subject_id, key, source_id, observed_at, value, unit, scope,
           window_start, window_end, observation_id, coverage_json, schema_version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          observation.subjectType,
          observation.subjectId,
          observation.key,
          observation.sourceId,
          observation.observedAt,
          observation.value,
          observation.unit,
          observation.scope,
          observation.window?.start ?? null,
          observation.window?.end ?? null,
          observation.observationId,
          JSON.stringify(observation.coverage),
          observation.schemaVersion,
        ],
      );
    }
    return inserted;
  }

  async series(subjectId: string, key: MetricObservation["key"], window: TimeWindow): Promise<MetricObservation[]> {
    const rows = this.db.all(
      `SELECT subject_type, subject_id, key, source_id, observed_at, value, unit, scope,
              window_start, window_end, observation_id, coverage_json, schema_version
       FROM metric_observations
       WHERE subject_id = ? AND key = ? AND observed_at >= ? AND observed_at <= ?
       ORDER BY observed_at ASC, source_id ASC`,
      [subjectId, key, window.start, window.end],
    );
    return rows.map((row) => {
      const start = textOrNull(row, "window_start");
      const end = textOrNull(row, "window_end");
      return {
        schemaVersion: 1,
        subjectType: text(row, "subject_type") as MetricObservation["subjectType"],
        subjectId: text(row, "subject_id"),
        key: text(row, "key") as MetricObservation["key"],
        value: num(row, "value"),
        unit: text(row, "unit") as MetricObservation["unit"],
        scope: text(row, "scope") as MetricObservation["scope"],
        observedAt: text(row, "observed_at"),
        window: start !== null && end !== null ? { start, end } : null,
        sourceId: text(row, "source_id"),
        observationId: textOrNull(row, "observation_id"),
        coverage: json<MetricObservation["coverage"]>(row, "coverage_json", {
          sourcesAttempted: 0,
          sourcesSucceeded: 0,
          truncated: false,
          note: null,
        }),
      } satisfies MetricObservation;
    });
  }

  async upsertSignal(signal: DerivedSignal): Promise<void> {
    this.db.run(
      `INSERT INTO derived_signals (
         subject_type, subject_id, key, window_start, window_end, policy_version,
         value, status, status_reason, signal_json, schema_version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(subject_type, subject_id, key, window_start, window_end, policy_version) DO UPDATE SET
         value = excluded.value, status = excluded.status, status_reason = excluded.status_reason,
         signal_json = excluded.signal_json, schema_version = excluded.schema_version`,
      [
        signal.subjectType,
        signal.subjectId,
        signal.key,
        signal.window.start,
        signal.window.end,
        signal.provenance.policyVersion ?? "",
        signal.value,
        signal.status,
        signal.statusReason,
        JSON.stringify(signal),
        signal.schemaVersion,
      ],
    );
  }

  /** window.end 가 요청 window 안에 드는 signal 을 돌려준다. */
  async signals(subjectId: string, window: TimeWindow): Promise<DerivedSignal[]> {
    const rows = this.db.all(
      `SELECT signal_json FROM derived_signals
       WHERE subject_id = ? AND window_end >= ? AND window_end <= ?
       ORDER BY window_end ASC, key ASC, policy_version ASC`,
      [subjectId, window.start, window.end],
    );
    return collectJson<DerivedSignal>(rows, "signal_json");
  }
}

// ---------------------------------------------------------------------------
// Evidence / Claims / Analyses
// ---------------------------------------------------------------------------

export class SqliteClaimStore implements ClaimStore {
  constructor(private readonly db: SqliteDriver) {}

  async putEvidence(evidence: Evidence[]): Promise<void> {
    for (const item of evidence) {
      this.db.run(
        `INSERT INTO evidence (id, document_id, observation_id, locator_json, captured_at, published_at, schema_version)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           document_id = excluded.document_id, observation_id = excluded.observation_id,
           locator_json = excluded.locator_json, captured_at = excluded.captured_at,
           published_at = excluded.published_at, schema_version = excluded.schema_version`,
        [
          item.id,
          item.documentId,
          item.observationId,
          JSON.stringify(item.locator),
          item.capturedAt,
          item.publishedAt,
          item.schemaVersion,
        ],
      );
    }
  }

  async getEvidence(ids: string[]): Promise<Evidence[]> {
    if (ids.length === 0) return [];
    const rows = this.db.all(
      `SELECT id, document_id, observation_id, locator_json, captured_at, published_at, schema_version
       FROM evidence WHERE id IN (${placeholders(ids.length)}) ORDER BY id ASC`,
      ids,
    );
    return rows.map(toEvidence);
  }

  async evidenceOfDocument(documentId: string): Promise<Evidence[]> {
    const rows = this.db.all(
      `SELECT id, document_id, observation_id, locator_json, captured_at, published_at, schema_version
       FROM evidence WHERE document_id = ? ORDER BY id ASC`,
      [documentId],
    );
    return rows.map(toEvidence);
  }

  async putAnalysis(record: AnalysisRecord): Promise<void> {
    this.db.run(
      `INSERT INTO analyses (
         id, task, run_id, status, provider, model, prompt_id, prompt_version, output_hash,
         cache_key, record_json, schema_version, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         task = excluded.task, run_id = excluded.run_id, status = excluded.status, provider = excluded.provider,
         model = excluded.model, prompt_id = excluded.prompt_id, prompt_version = excluded.prompt_version,
         output_hash = excluded.output_hash, cache_key = excluded.cache_key, record_json = excluded.record_json,
         schema_version = excluded.schema_version, created_at = excluded.created_at`,
      [
        record.id,
        record.task,
        record.provenance.runId,
        record.status,
        record.provenance.provider ?? null,
        record.provenance.model ?? null,
        record.provenance.promptId ?? null,
        record.provenance.promptVersion ?? null,
        record.outputHash,
        record.cacheKey,
        JSON.stringify(record),
        record.schemaVersion,
        record.provenance.createdAt,
      ],
    );
  }

  async findAnalysisByCacheKey(cacheKey: string): Promise<AnalysisRecord | null> {
    const row = this.db.get(
      "SELECT record_json FROM analyses WHERE cache_key = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      [cacheKey],
    );
    return row === null ? null : json<AnalysisRecord | null>(row, "record_json", null);
  }

  async putClaims(claims: Claim[]): Promise<void> {
    for (const claim of claims) {
      this.db.run(
        `INSERT INTO claims (
           id, type, statement, analysis_id, confidence, sentiment, visibility, status, superseded_by_id,
           claim_json, schema_version, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           type = excluded.type, statement = excluded.statement, analysis_id = excluded.analysis_id,
           confidence = excluded.confidence, sentiment = excluded.sentiment, visibility = excluded.visibility,
           status = excluded.status, superseded_by_id = excluded.superseded_by_id, claim_json = excluded.claim_json,
           schema_version = excluded.schema_version, created_at = excluded.created_at`,
        [
          claim.id,
          claim.type,
          claim.statement,
          claim.analysisId,
          claim.confidence,
          claim.sentiment,
          claim.visibility,
          claim.status,
          claim.supersededById,
          JSON.stringify(claim),
          claim.schemaVersion,
          claim.provenance.createdAt,
        ],
      );
      this.db.run("DELETE FROM claim_evidence WHERE claim_id = ?", [claim.id]);
      for (const evidenceId of claim.evidenceIds) {
        this.db.run("INSERT OR IGNORE INTO claim_evidence (claim_id, evidence_id) VALUES (?, ?)", [
          claim.id,
          evidenceId,
        ]);
      }
      this.db.run("DELETE FROM claim_entities WHERE claim_id = ?", [claim.id]);
      for (const entityId of claim.subjectEntityIds) {
        this.db.run("INSERT OR IGNORE INTO claim_entities (claim_id, entity_id) VALUES (?, ?)", [claim.id, entityId]);
      }
    }
  }

  async claimsByAnalysis(analysisId: string): Promise<Claim[]> {
    const rows = this.db.all("SELECT claim_json FROM claims WHERE analysis_id = ? ORDER BY id ASC", [analysisId]);
    return collectJson<Claim>(rows, "claim_json");
  }

  async claimsForDocuments(documentIds: string[]): Promise<Claim[]> {
    if (documentIds.length === 0) return [];
    const rows = this.db.all(
      `SELECT DISTINCT c.claim_json AS claim_json, c.id AS id FROM claims c
         JOIN claim_evidence ce ON ce.claim_id = c.id
         JOIN evidence e ON e.id = ce.evidence_id
       WHERE e.document_id IN (${placeholders(documentIds.length)})
       ORDER BY c.id ASC`,
      documentIds,
    );
    return collectJson<Claim>(rows, "claim_json");
  }

  async putClassification(classification: Classification, policyVersion: string): Promise<void> {
    this.db.run(
      `INSERT INTO classifications (document_id, policy_version, classification_json, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(document_id, policy_version) DO UPDATE SET
         classification_json = excluded.classification_json, created_at = excluded.created_at`,
      [
        classification.documentId,
        policyVersion,
        JSON.stringify(classification),
        classification.provenance.createdAt,
      ],
    );
  }

  async classificationsFor(documentIds: string[], policyVersion: string): Promise<Classification[]> {
    if (documentIds.length === 0) return [];
    const rows = this.db.all(
      `SELECT classification_json FROM classifications
       WHERE policy_version = ? AND document_id IN (${placeholders(documentIds.length)})
       ORDER BY document_id ASC`,
      [policyVersion, ...documentIds],
    );
    return collectJson<Classification>(rows, "classification_json");
  }
}

function toEvidence(row: SqlRow): Evidence {
  return {
    schemaVersion: 1,
    id: text(row, "id"),
    documentId: text(row, "document_id"),
    observationId: text(row, "observation_id"),
    locator: json<Evidence["locator"]>(row, "locator_json", { kind: "document" }),
    capturedAt: text(row, "captured_at"),
    publishedAt: textOrNull(row, "published_at"),
  };
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

const ARTIFACT_COLUMNS =
  "id, type, target_key, revision, content_hash, status, visibility, run_id, timezone, window_start, window_end, body_ref, inputs_json, schema_version, created_at";

export class SqliteArtifactStore implements ArtifactStore {
  constructor(
    private readonly db: SqliteDriver,
    private readonly dir: string,
  ) {}

  async head(type: ArtifactType, targetKey: string): Promise<ArtifactHead | null> {
    const row = this.db.get("SELECT revision FROM artifacts_current WHERE type = ? AND target_key = ?", [
      type,
      targetKey,
    ]);
    if (row === null) return null;
    return { type, targetKey, revision: num(row, "revision") };
  }

  async get<T>(type: ArtifactType, targetKey: string, revision: number): Promise<Artifact<T> | null> {
    const row = this.db.get(
      `SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE type = ? AND target_key = ? AND revision = ?`,
      [type, targetKey, revision],
    );
    if (row === null) return null;
    const body = (await readArtifactBody(this.dir, text(row, "body_ref"))) as T;
    return toArtifact<T>(row, body);
  }

  /**
   * contentHash 가 head 와 같으면 새 revision 을 만들지 않고 head 를 돌려준다 (§8 Artifact).
   * 들어온 revision 이 head 이하면 head+1 을 부여한다.
   */
  async putRevision<T>(artifact: Artifact<T>): Promise<ArtifactHead> {
    const head = await this.head(artifact.type, artifact.targetKey);
    if (head !== null) {
      const headRow = this.db.get(
        "SELECT content_hash FROM artifacts WHERE type = ? AND target_key = ? AND revision = ?",
        [artifact.type, artifact.targetKey, head.revision],
      );
      if (headRow !== null && text(headRow, "content_hash") === artifact.contentHash) return head;
    }
    const revision = nextRevision(head?.revision ?? null, artifact.revision);
    const bodyRef = artifactBodyRef(artifact.type, artifact.targetKey, revision);
    // 파일은 row 커밋 전에 쓴다 (CONTRACTS_AND_DATA.md §7.3 설계 노트).
    await writeArtifactBody(this.dir, bodyRef, artifact.body);
    this.db.run(
      `INSERT INTO artifacts (${ARTIFACT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(type, target_key, revision) DO UPDATE SET
         id = excluded.id, content_hash = excluded.content_hash, status = excluded.status,
         visibility = excluded.visibility, run_id = excluded.run_id, timezone = excluded.timezone,
         window_start = excluded.window_start, window_end = excluded.window_end, body_ref = excluded.body_ref,
         inputs_json = excluded.inputs_json, schema_version = excluded.schema_version, created_at = excluded.created_at`,
      [
        artifact.id,
        artifact.type,
        artifact.targetKey,
        revision,
        artifact.contentHash,
        artifact.status,
        artifact.visibility,
        artifact.inputs.runId,
        artifact.timezone,
        artifact.window.start,
        artifact.window.end,
        bodyRef,
        JSON.stringify(artifact.inputs),
        artifact.schemaVersion,
        artifact.createdAt,
      ],
    );
    this.db.run(
      `INSERT INTO artifacts_current (type, target_key, revision) VALUES (?, ?, ?)
       ON CONFLICT(type, target_key) DO UPDATE SET revision = excluded.revision`,
      [artifact.type, artifact.targetKey, revision],
    );
    return { type: artifact.type, targetKey: artifact.targetKey, revision };
  }

  async putApproval(approval: ApprovalRecord): Promise<void> {
    this.db.run(
      `INSERT INTO approvals (artifact_id, revision, channel, content_hash, rendered_asset_hash, approved_by, approved_at, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(artifact_id, revision, channel) DO UPDATE SET
         content_hash = excluded.content_hash, rendered_asset_hash = excluded.rendered_asset_hash,
         approved_by = excluded.approved_by, approved_at = excluded.approved_at, note = excluded.note`,
      [
        approval.artifactId,
        approval.revision,
        approval.channel,
        approval.contentHash,
        approval.renderedAssetHash,
        approval.approvedBy,
        approval.approvedAt,
        approval.note,
      ],
    );
  }

  async approval(artifactId: string, revision: number, channel: ChannelId): Promise<ApprovalRecord | null> {
    const row = this.db.get(
      `SELECT artifact_id, revision, channel, content_hash, rendered_asset_hash, approved_by, approved_at, note
       FROM approvals WHERE artifact_id = ? AND revision = ? AND channel = ?`,
      [artifactId, revision, channel],
    );
    if (row === null) return null;
    return {
      artifactId: text(row, "artifact_id"),
      revision: num(row, "revision"),
      contentHash: text(row, "content_hash"),
      renderedAssetHash: textOrNull(row, "rendered_asset_hash"),
      channel: text(row, "channel") as ChannelId,
      approvedBy: text(row, "approved_by") as ApprovalRecord["approvedBy"],
      approvedAt: text(row, "approved_at"),
      note: textOrNull(row, "note"),
    };
  }

  async putPublication(record: PublicationRecord): Promise<void> {
    this.db.run(
      `INSERT INTO publications (
         artifact_id, channel, revision, external_id, external_url, status, attempt, rendered_hash,
         scheduled_at, published_at, error, run_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(artifact_id, channel, revision) DO UPDATE SET
         external_id = excluded.external_id, external_url = excluded.external_url, status = excluded.status,
         attempt = excluded.attempt, rendered_hash = excluded.rendered_hash, scheduled_at = excluded.scheduled_at,
         published_at = excluded.published_at, error = excluded.error, run_id = excluded.run_id`,
      [
        record.artifactId,
        record.channel,
        record.revision,
        record.externalId,
        record.externalUrl,
        record.status,
        record.attempt,
        record.renderedHash,
        record.scheduledAt,
        record.publishedAt,
        record.error,
        record.runId,
      ],
    );
  }

  /** 가장 높은 revision 의 발행 기록 (§5.3). */
  async latestPublication(artifactId: string, channel: ChannelId): Promise<PublicationRecord | null> {
    const row = this.db.get(
      `SELECT artifact_id, channel, revision, external_id, external_url, status, attempt, rendered_hash,
              scheduled_at, published_at, error, run_id
       FROM publications WHERE artifact_id = ? AND channel = ? ORDER BY revision DESC LIMIT 1`,
      [artifactId, channel],
    );
    if (row === null) return null;
    return {
      artifactId: text(row, "artifact_id"),
      revision: num(row, "revision"),
      channel: text(row, "channel") as ChannelId,
      externalId: textOrNull(row, "external_id"),
      externalUrl: textOrNull(row, "external_url"),
      status: text(row, "status") as PublicationRecord["status"],
      attempt: num(row, "attempt"),
      renderedHash: text(row, "rendered_hash"),
      scheduledAt: textOrNull(row, "scheduled_at"),
      publishedAt: textOrNull(row, "published_at"),
      error: textOrNull(row, "error"),
      runId: text(row, "run_id"),
    };
  }
}

/** head 가 없으면 들어온 revision(최소 1), 있으면 head 보다 커야 한다. */
export function nextRevision(headRevision: number | null, incoming: number): number {
  if (headRevision === null) return incoming >= 1 ? incoming : 1;
  return incoming > headRevision ? incoming : headRevision + 1;
}

function toArtifact<T>(row: SqlRow, body: T): Artifact<T> {
  return {
    schemaVersion: 1,
    id: text(row, "id"),
    type: text(row, "type") as ArtifactType,
    targetKey: text(row, "target_key"),
    revision: num(row, "revision"),
    contentHash: text(row, "content_hash"),
    status: text(row, "status") as Artifact<T>["status"],
    timezone: text(row, "timezone"),
    window: { start: text(row, "window_start"), end: text(row, "window_end") },
    body,
    inputs: json<Artifact<T>["inputs"]>(row, "inputs_json", {
      claimIds: [],
      documentIds: [],
      signalRefs: [],
      rankingPolicies: [],
      runId: text(row, "run_id"),
    }),
    visibility: text(row, "visibility") as Artifact<T>["visibility"],
    createdAt: text(row, "created_at"),
  };
}

// ---------------------------------------------------------------------------
// Runs and checkpoints
// ---------------------------------------------------------------------------

export class SqliteRunStore implements RunStore {
  constructor(private readonly db: SqliteDriver) {}

  async put(run: Run): Promise<void> {
    this.db.run(
      `INSERT INTO runs (id, kind, started_at, finished_at, window_start, window_end, timezone, status, record_json, schema_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind, started_at = excluded.started_at, finished_at = excluded.finished_at,
         window_start = excluded.window_start, window_end = excluded.window_end, timezone = excluded.timezone,
         status = excluded.status, record_json = excluded.record_json, schema_version = excluded.schema_version`,
      [
        run.id,
        run.kind,
        run.startedAt,
        run.finishedAt,
        run.targetWindow.start,
        run.targetWindow.end,
        run.timezone,
        run.status,
        JSON.stringify(run),
        run.schemaVersion,
      ],
    );
  }

  async get(id: string): Promise<Run | null> {
    const row = this.db.get("SELECT record_json FROM runs WHERE id = ?", [id]);
    return row === null ? null : json<Run | null>(row, "record_json", null);
  }

  async appendEvent(runId: string, at: string, event: DomainEvent): Promise<void> {
    this.db.run("INSERT INTO run_events (run_id, at, type, payload_json) VALUES (?, ?, ?, ?)", [
      runId,
      at,
      event.type,
      JSON.stringify(event),
    ]);
  }

  async latestByKind(kind: Run["kind"]): Promise<Run | null> {
    const row = this.db.get(
      "SELECT record_json FROM runs WHERE kind = ? ORDER BY started_at DESC, id DESC LIMIT 1",
      [kind],
    );
    return row === null ? null : json<Run | null>(row, "record_json", null);
  }

  /** 디버깅·테스트용 read model. Port 계약은 아니다. */
  async events(runId: string): Promise<{ at: string; event: DomainEvent }[]> {
    const rows = this.db.all("SELECT at, payload_json FROM run_events WHERE run_id = ? ORDER BY seq ASC", [runId]);
    const out: { at: string; event: DomainEvent }[] = [];
    for (const row of rows) {
      const event = json<DomainEvent | null>(row, "payload_json", null);
      if (event !== null) out.push({ at: text(row, "at"), event });
    }
    return out;
  }
}

export class SqliteCheckpointStore implements CheckpointStore {
  constructor(private readonly db: SqliteDriver) {}

  async get(sourceId: string): Promise<SourceCheckpoint | null> {
    const row = this.db.get("SELECT checkpoint_json FROM source_checkpoints WHERE source_id = ?", [sourceId]);
    return row === null ? null : json<SourceCheckpoint | null>(row, "checkpoint_json", null);
  }

  async put(sourceId: string, checkpoint: SourceCheckpoint, runId: string, updatedAt: string): Promise<void> {
    this.db.run(
      `INSERT INTO source_checkpoints (source_id, checkpoint_json, updated_at, run_id) VALUES (?, ?, ?, ?)
       ON CONFLICT(source_id) DO UPDATE SET
         checkpoint_json = excluded.checkpoint_json, updated_at = excluded.updated_at, run_id = excluded.run_id`,
      [sourceId, JSON.stringify(checkpoint), updatedAt, runId],
    );
  }
}

// ---------------------------------------------------------------------------

function collectJson<T>(rows: readonly SqlRow[], column: string): T[] {
  const out: T[] = [];
  for (const row of rows) {
    const parsed = json<T | null>(row, column, null);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}
