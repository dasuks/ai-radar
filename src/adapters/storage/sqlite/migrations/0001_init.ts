/**
 * DDL v1 — CONTRACTS_AND_DATA.md §7.3.
 *
 * 문서의 DDL 을 기준으로 하되, domain 계약을 손실 없이 복원하기 위해 아래만 다르다(추가 전용).
 *  - `raw_observations.source_kind`, `.observed_at_is_fetched_at`: RawObservation 복원에 필요.
 *  - `entity_mentions`: domain 의 EntityMention 은 `locatorKey: string` 이므로
 *    `locator_hash`/`locator_json` 대신 `locator_key` 하나를 쓰고 전체 계약은 `mention_json` 에 둔다.
 *  - `analyses.cache_key`: AnalysisRecord.cacheKey (§8 Claim 캐시) 조회용.
 *  - `artifacts.timezone`/`.window_start`/`.window_end`: Artifact envelope 복원에 필요.
 *  - `classifications.classification_json` 외 `policy_version` 은 문서와 동일.
 *  - `schema_migrations` 는 migrate.ts 가 bootstrap 으로 만든다 (migration 이 자기 장부를 만들 수 없다).
 *  - `PRAGMA foreign_keys` / `journal_mode` 는 트랜잭션 안에서 적용되지 않으므로 driver.ts 가 연결 시점에 건다.
 *
 * unique key 와 index 는 문서와 동일하다.
 */
export const version = 1;
export const name = "init";

export const sql = `
CREATE TABLE runs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
  window_start TEXT NOT NULL, window_end TEXT NOT NULL, timezone TEXT NOT NULL,
  status TEXT NOT NULL, record_json TEXT NOT NULL, schema_version INTEGER NOT NULL
);
CREATE INDEX runs_window ON runs(window_start, window_end);
CREATE INDEX runs_kind_started ON runs(kind, started_at);

CREATE TABLE run_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id),
  at TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL
);
CREATE INDEX run_events_run ON run_events(run_id, seq);

CREATE TABLE source_checkpoints (
  source_id TEXT PRIMARY KEY, checkpoint_json TEXT NOT NULL, updated_at TEXT NOT NULL, run_id TEXT NOT NULL
);

CREATE TABLE raw_observations (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL, source_kind TEXT NOT NULL, external_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL, original_url TEXT, observed_at TEXT NOT NULL,
  observed_at_is_fetched_at INTEGER NOT NULL, fetched_at TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id), completeness TEXT NOT NULL,
  payload_ref_json TEXT NOT NULL, raw_metadata_json TEXT NOT NULL, schema_version INTEGER NOT NULL,
  UNIQUE(source_id, external_id, payload_hash)
);
CREATE INDEX raw_obs_source_time ON raw_observations(source_id, observed_at);

CREATE TABLE documents (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL, external_id TEXT NOT NULL,
  latest_observation_id TEXT NOT NULL REFERENCES raw_observations(id),
  first_observation_id TEXT NOT NULL REFERENCES raw_observations(id),
  title TEXT NOT NULL, canonical_url TEXT, published_at TEXT, updated_at TEXT, fetched_at TEXT NOT NULL,
  content_completeness TEXT NOT NULL, language TEXT, status TEXT NOT NULL DEFAULT 'ACTIVE',
  document_json TEXT NOT NULL, schema_version INTEGER NOT NULL,
  UNIQUE(source_id, external_id)
);
CREATE INDEX documents_published ON documents(published_at);
CREATE INDEX documents_canonical_url ON documents(canonical_url);
CREATE INDEX documents_effective_time ON documents(COALESCE(published_at, fetched_at));

CREATE TABLE document_links (
  from_document_id TEXT NOT NULL REFERENCES documents(id), to_document_id TEXT NOT NULL REFERENCES documents(id),
  type TEXT NOT NULL, confidence REAL NOT NULL, provenance_json TEXT NOT NULL,
  PRIMARY KEY(from_document_id, to_document_id, type)
);
CREATE INDEX document_links_to ON document_links(to_document_id);

CREATE TABLE entities (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, canonical_name TEXT NOT NULL, normalized_name TEXT NOT NULL,
  official_url TEXT, repository_url TEXT, ecosystem TEXT, parent_entity_id TEXT REFERENCES entities(id),
  identity_confidence REAL NOT NULL, status TEXT NOT NULL, merged_into_id TEXT REFERENCES entities(id),
  entity_json TEXT NOT NULL, schema_version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX entities_repo ON entities(repository_url) WHERE repository_url IS NOT NULL AND status = 'ACTIVE';
CREATE INDEX entities_lookup ON entities(type, normalized_name, ecosystem);
CREATE INDEX entities_normalized ON entities(normalized_name);

CREATE TABLE entity_aliases (
  entity_id TEXT NOT NULL REFERENCES entities(id), alias TEXT NOT NULL, normalized TEXT NOT NULL, source TEXT NOT NULL,
  PRIMARY KEY(entity_id, normalized)
);
CREATE INDEX entity_aliases_normalized ON entity_aliases(normalized);

CREATE TABLE entity_merges (
  from_entity_id TEXT NOT NULL REFERENCES entities(id), into_entity_id TEXT NOT NULL REFERENCES entities(id),
  reason TEXT NOT NULL, provenance_json TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(from_entity_id, into_entity_id)
);

CREATE TABLE entity_mentions (
  document_id TEXT NOT NULL REFERENCES documents(id), surface_form TEXT NOT NULL, locator_key TEXT NOT NULL,
  entity_id TEXT REFERENCES entities(id), resolution TEXT NOT NULL, candidate_ids_json TEXT NOT NULL,
  confidence REAL NOT NULL, mention_json TEXT NOT NULL,
  PRIMARY KEY(document_id, surface_form, locator_key)
);
CREATE INDEX entity_mentions_entity ON entity_mentions(entity_id, resolution);

CREATE TABLE metric_observations (
  subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, key TEXT NOT NULL, source_id TEXT NOT NULL,
  observed_at TEXT NOT NULL, value REAL NOT NULL, unit TEXT NOT NULL, scope TEXT NOT NULL,
  window_start TEXT, window_end TEXT, observation_id TEXT REFERENCES raw_observations(id),
  coverage_json TEXT NOT NULL, schema_version INTEGER NOT NULL,
  PRIMARY KEY(subject_type, subject_id, key, source_id, observed_at)
);
CREATE INDEX metric_obs_series ON metric_observations(subject_id, key, observed_at);

CREATE TABLE derived_signals (
  subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, key TEXT NOT NULL,
  window_start TEXT NOT NULL, window_end TEXT NOT NULL, policy_version TEXT NOT NULL,
  value REAL, status TEXT NOT NULL, status_reason TEXT, signal_json TEXT NOT NULL, schema_version INTEGER NOT NULL,
  PRIMARY KEY(subject_type, subject_id, key, window_start, window_end, policy_version)
);
CREATE INDEX derived_signals_window ON derived_signals(window_end, key, status);
CREATE INDEX derived_signals_subject ON derived_signals(subject_id, window_end);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id),
  observation_id TEXT NOT NULL REFERENCES raw_observations(id), locator_json TEXT NOT NULL,
  captured_at TEXT NOT NULL, published_at TEXT, schema_version INTEGER NOT NULL
);
CREATE INDEX evidence_document ON evidence(document_id);

CREATE TABLE analyses (
  id TEXT PRIMARY KEY, task TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), status TEXT NOT NULL,
  provider TEXT, model TEXT, prompt_id TEXT, prompt_version TEXT, output_hash TEXT NOT NULL,
  cache_key TEXT NOT NULL, record_json TEXT NOT NULL, schema_version INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX analyses_cache_key ON analyses(cache_key, created_at);

CREATE TABLE claims (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, statement TEXT NOT NULL, analysis_id TEXT NOT NULL REFERENCES analyses(id),
  confidence REAL NOT NULL, sentiment TEXT NOT NULL, visibility TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE', superseded_by_id TEXT REFERENCES claims(id),
  claim_json TEXT NOT NULL, schema_version INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX claims_analysis ON claims(analysis_id);

CREATE TABLE claim_evidence (claim_id TEXT NOT NULL REFERENCES claims(id), evidence_id TEXT NOT NULL REFERENCES evidence(id), PRIMARY KEY(claim_id, evidence_id));
CREATE INDEX claim_evidence_evidence ON claim_evidence(evidence_id);
CREATE TABLE claim_entities (claim_id TEXT NOT NULL REFERENCES claims(id), entity_id TEXT NOT NULL REFERENCES entities(id), PRIMARY KEY(claim_id, entity_id));
CREATE INDEX claim_entities_entity ON claim_entities(entity_id);

CREATE TABLE classifications (
  document_id TEXT NOT NULL REFERENCES documents(id), policy_version TEXT NOT NULL,
  classification_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(document_id, policy_version)
);

CREATE TABLE artifacts (
  id TEXT NOT NULL, type TEXT NOT NULL, target_key TEXT NOT NULL, revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL, status TEXT NOT NULL, visibility TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id),
  timezone TEXT NOT NULL, window_start TEXT NOT NULL, window_end TEXT NOT NULL,
  body_ref TEXT NOT NULL, inputs_json TEXT NOT NULL, schema_version INTEGER NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(type, target_key, revision)
);
CREATE INDEX artifacts_id ON artifacts(id, revision);

CREATE TABLE artifacts_current (type TEXT NOT NULL, target_key TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(type, target_key));

CREATE TABLE approvals (
  artifact_id TEXT NOT NULL, revision INTEGER NOT NULL, channel TEXT NOT NULL, content_hash TEXT NOT NULL,
  rendered_asset_hash TEXT, approved_by TEXT NOT NULL, approved_at TEXT NOT NULL, note TEXT,
  PRIMARY KEY(artifact_id, revision, channel)
);

CREATE TABLE publications (
  artifact_id TEXT NOT NULL, channel TEXT NOT NULL, revision INTEGER NOT NULL, external_id TEXT, external_url TEXT,
  status TEXT NOT NULL, attempt INTEGER NOT NULL, rendered_hash TEXT NOT NULL, scheduled_at TEXT, published_at TEXT, error TEXT,
  run_id TEXT NOT NULL REFERENCES runs(id), PRIMARY KEY(artifact_id, channel, revision)
);
CREATE INDEX publications_scheduled ON publications(status, scheduled_at);
CREATE INDEX publications_external ON publications(channel, external_id);

CREATE TABLE feedback_events (
  id TEXT PRIMARY KEY, subject_json TEXT NOT NULL, kind TEXT NOT NULL, channel TEXT NOT NULL,
  observed_at TEXT NOT NULL, source TEXT NOT NULL, schema_version INTEGER NOT NULL,
  UNIQUE(subject_json, kind, source, observed_at)
);

CREATE TABLE knowledge_proposals (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), target_path TEXT, target_title TEXT NOT NULL,
  entity_id TEXT REFERENCES entities(id), operation TEXT NOT NULL, decision TEXT NOT NULL,
  proposal_json TEXT NOT NULL, applied_at TEXT, schema_version INTEGER NOT NULL, created_at TEXT NOT NULL
);
`;
