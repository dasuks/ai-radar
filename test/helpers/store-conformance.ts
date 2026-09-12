import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Artifact } from "../../src/domain/artifacts/artifact.js";
import { contentHashOf } from "../../src/domain/artifacts/artifact.js";
import type { NormalizedDocument } from "../../src/domain/documents/normalized-document.js";
import type { PayloadRef, RawObservation } from "../../src/domain/documents/raw-observation.js";
import type { Entity, EntityMention } from "../../src/domain/entities/entity.js";
import type { AnalysisRecord, Classification } from "../../src/domain/evidence/analysis.js";
import type { Claim } from "../../src/domain/evidence/claim.js";
import type { Evidence } from "../../src/domain/evidence/evidence.js";
import type { DerivedSignal } from "../../src/domain/metrics/derived-signal.js";
import type { MetricObservation } from "../../src/domain/metrics/metric-observation.js";
import { emptyCounters, type Run } from "../../src/domain/runs/run.js";
import type { Provenance } from "../../src/domain/evidence/provenance.js";
import type { Stores } from "../../src/ports/storage/index.js";
import { toPayloadRef } from "../../src/adapters/storage/fs/raw-payload.js";

export interface StoreHarness {
  stores: Stores;
  /** Raw payload 파일 루트 (file PayloadRef 테스트용) */
  rawPayloadRoot: string;
  cleanup(): Promise<void>;
}

export type OpenHarness = () => Promise<StoreHarness>;

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

export const RUN_ID = "run_TESTRUN0000000000000001";

export function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    schemaVersion: 1,
    id: RUN_ID,
    kind: "DAILY",
    startedAt: "2026-09-12T00:00:00.000Z",
    finishedAt: null,
    targetWindow: { start: "2026-09-11T00:00:00.000Z", end: "2026-09-12T00:00:00.000Z" },
    timezone: "Asia/Seoul",
    status: "RUNNING",
    counters: emptyCounters(),
    llmUsage: [],
    errors: [],
    stages: [],
    ...overrides,
  };
}

export function provenance(overrides: Partial<Provenance> = {}): Provenance {
  return { method: "RULE", runId: RUN_ID, createdAt: "2026-09-12T01:00:00.000Z", ...overrides };
}

export function makeObservation(overrides: Partial<RawObservation> = {}): RawObservation {
  return {
    schemaVersion: 1,
    id: "obs_aaaaaaaaaaaaaaaaaaaaaaa1",
    sourceId: "hackernews",
    sourceKind: "API",
    externalId: "item-1",
    originalUrl: "https://news.ycombinator.com/item?id=1",
    observedAt: "2026-09-11T12:00:00.000Z",
    observedAtIsFetchedAt: false,
    fetchedAt: "2026-09-11T12:05:00.000Z",
    runId: RUN_ID,
    payloadHash: "hash-1",
    payloadRef: { kind: "inline", json: { title: "hello" } },
    completeness: "FULL",
    rawMetadata: { feed: "front-page" },
    ...overrides,
  };
}

export function makeDocument(overrides: Partial<NormalizedDocument> = {}): NormalizedDocument {
  return {
    schemaVersion: 1,
    id: "doc_aaaaaaaaaaaaaaaaaaaaaaa1",
    sourceId: "hackernews",
    externalId: "item-1",
    latestObservationId: "obs_aaaaaaaaaaaaaaaaaaaaaaa1",
    firstObservationId: "obs_aaaaaaaaaaaaaaaaaaaaaaa1",
    title: "Hello",
    content: "body text",
    contentCompleteness: "FULL",
    author: { name: "someone", externalId: null, url: null },
    language: "en",
    publishedAt: "2026-09-11T10:00:00.000Z",
    updatedAt: null,
    fetchedAt: "2026-09-11T12:05:00.000Z",
    canonicalUrl: "https://example.com/a",
    urls: ["https://example.com/a"],
    comments: [],
    metrics: [],
    tags: ["ai"],
    status: "ACTIVE",
    provenance: { normalizerVersion: "1.0.0", runId: RUN_ID, normalizedAt: "2026-09-11T12:06:00.000Z" },
    ...overrides,
  };
}

export function makeEntity(overrides: Partial<Entity> = {}): Entity {
  return {
    schemaVersion: 1,
    id: "ent_TEST0000000000000000001",
    type: "TOOL",
    canonicalName: "Claude Code",
    aliases: ["claude-code", "CC"],
    officialUrl: "https://claude.com/claude-code",
    repositoryUrl: "https://github.com/anthropics/claude-code",
    ecosystem: "claude-code",
    parentEntityId: null,
    versionLabel: null,
    identityConfidence: 0.9,
    status: "ACTIVE",
    mergedIntoId: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
    ...overrides,
  };
}

export function makeMetric(overrides: Partial<MetricObservation> = {}): MetricObservation {
  return {
    schemaVersion: 1,
    subjectType: "DOCUMENT",
    subjectId: "doc_aaaaaaaaaaaaaaaaaaaaaaa1",
    key: "hn.points",
    value: 120,
    unit: "score",
    scope: "ITEM",
    observedAt: "2026-09-11T12:00:00.000Z",
    window: null,
    sourceId: "hackernews",
    observationId: "obs_aaaaaaaaaaaaaaaaaaaaaaa1",
    coverage: { sourcesAttempted: 1, sourcesSucceeded: 1, truncated: false, note: null },
    ...overrides,
  };
}

export function makeSignal(overrides: Partial<DerivedSignal> = {}): DerivedSignal {
  return {
    schemaVersion: 1,
    subjectType: "ENTITY",
    subjectId: "ent_TEST0000000000000000001",
    key: "mention_velocity",
    window: { start: "2026-09-05T00:00:00.000Z", end: "2026-09-12T00:00:00.000Z" },
    previousWindow: null,
    value: 1.5,
    status: "COMPUTED",
    statusReason: null,
    inputs: [{ metricKey: "radar.mentions", observationCount: 3, sourceIds: ["hackernews"] }],
    provenance: provenance({ method: "DERIVED", policyId: "trend.engine", policyVersion: "1.0.0" }),
    ...overrides,
  };
}

export function makeEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    schemaVersion: 1,
    id: "evd_aaaaaaaaaaaaaaaaaaaaaaa1",
    documentId: "doc_aaaaaaaaaaaaaaaaaaaaaaa1",
    observationId: "obs_aaaaaaaaaaaaaaaaaaaaaaa1",
    locator: { kind: "excerpt", start: 0, end: 5, text: "body " },
    capturedAt: "2026-09-12T01:00:00.000Z",
    publishedAt: "2026-09-11T10:00:00.000Z",
    ...overrides,
  };
}

export function makeAnalysis(overrides: Partial<AnalysisRecord> = {}): AnalysisRecord {
  return {
    schemaVersion: 1,
    id: "ana_TEST0000000000000000001",
    task: "EXTRACT_CLAIMS",
    inputDocumentIds: ["doc_aaaaaaaaaaaaaaaaaaaaaaa1"],
    inputEvidenceIds: ["evd_aaaaaaaaaaaaaaaaaaaaaaa1"],
    provenance: provenance({ method: "LLM", model: "claude-sonnet-5", provider: "anthropic", promptId: "extract-claims", promptVersion: "1.0.0" }),
    usage: { inputTokens: 10, outputTokens: 20, costUsd: null, latencyMs: 100 },
    outputHash: "out-hash",
    validation: { schemaOk: true, evidenceOk: true, rejectedItems: 0, notes: [] },
    status: "SUCCEEDED",
    cacheKey: "EXTRACT_CLAIMS|1.0.0|claude-sonnet-5|input-hash",
    ...overrides,
  };
}

export function makeClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    schemaVersion: 1,
    id: "clm_TEST0000000000000000001",
    type: "FACT",
    statement: "무언가 릴리스되었다.",
    statementLanguage: "ko",
    subjectEntityIds: ["ent_TEST0000000000000000001"],
    evidenceIds: ["evd_aaaaaaaaaaaaaaaaaaaaaaa1"],
    signalRefs: [],
    confidence: 0.8,
    sentiment: "NEUTRAL",
    visibility: "PRIVATE",
    status: "ACTIVE",
    supersededById: null,
    analysisId: "ana_TEST0000000000000000001",
    provenance: provenance({ method: "LLM" }),
    ...overrides,
  };
}

export function makeClassification(overrides: Partial<Classification> = {}): Classification {
  return {
    documentId: "doc_aaaaaaaaaaaaaaaaaaaaaaa1",
    categories: [{ category: "AI_CODING", confidence: 0.9 }],
    audience: "PRACTITIONER",
    provenance: provenance({ method: "RULE", policyId: "classification", policyVersion: "1.0.0" }),
    ...overrides,
  };
}

export interface BriefBody {
  bodySchemaVersion: 2;
  date: string;
  items: string[];
}

export function makeArtifact(body: BriefBody, overrides: Partial<Artifact<BriefBody>> = {}): Artifact<BriefBody> {
  return {
    schemaVersion: 1,
    id: "art_daily_brief_2026-09-12",
    type: "DAILY_BRIEF",
    targetKey: "2026-09-12",
    revision: 1,
    contentHash: contentHashOf(body),
    status: "DRAFT",
    timezone: "Asia/Seoul",
    window: { start: "2026-09-11T00:00:00.000Z", end: "2026-09-12T00:00:00.000Z" },
    body,
    inputs: { claimIds: [], documentIds: [], signalRefs: [], rankingPolicies: [], runId: RUN_ID },
    visibility: "PRIVATE",
    createdAt: "2026-09-12T02:00:00.000Z",
    ...overrides,
  };
}

/** FK 순서를 만족하는 최소 그래프 (run → observation → document). */
async function seedGraph(stores: Stores): Promise<void> {
  await stores.runs.put(makeRun());
  await stores.raw.putIfAbsent(makeObservation());
  await stores.documents.upsert(makeDocument());
}

// ---------------------------------------------------------------------------
// conformance suite
// ---------------------------------------------------------------------------

export function describeStoreConformance(label: string, open: OpenHarness): void {
  const withStores = async (fn: (harness: StoreHarness) => Promise<void>): Promise<void> => {
    const harness = await open();
    try {
      await fn(harness);
    } finally {
      await harness.cleanup();
    }
  };

  describe(`${label} storage conformance`, () => {
    test("raw putIfAbsent is idempotent by observation id", async () => {
      await withStores(async ({ stores }) => {
        await stores.runs.put(makeRun());
        const observation = makeObservation();
        assert.equal(await stores.raw.putIfAbsent(observation), true);
        assert.equal(await stores.raw.putIfAbsent(observation), false);
        const loaded = await stores.raw.get(observation.id);
        assert.deepEqual(loaded, observation);
      });
    });

    test("raw keeps both observations when the payload hash differs", async () => {
      await withStores(async ({ stores }) => {
        await stores.runs.put(makeRun());
        const first = makeObservation();
        const second = makeObservation({
          id: "obs_aaaaaaaaaaaaaaaaaaaaaaa2",
          payloadHash: "hash-2",
          observedAt: "2026-09-11T13:00:00.000Z",
          payloadRef: { kind: "inline", json: { title: "hello again" } },
        });
        assert.equal(await stores.raw.putIfAbsent(first), true);
        assert.equal(await stores.raw.putIfAbsent(second), true);
        const listed = await stores.raw.listBySource("hackernews", {
          start: "2026-09-11T00:00:00.000Z",
          end: "2026-09-12T00:00:00.000Z",
        });
        assert.deepEqual(listed.map((item) => item.id), [first.id, second.id]);
      });
    });

    test("raw readPayload reads inline and file payload refs", async () => {
      await withStores(async ({ stores, rawPayloadRoot }) => {
        await stores.runs.put(makeRun());
        const inline = makeObservation();
        await stores.raw.putIfAbsent(inline);
        assert.deepEqual(await stores.raw.readPayload(inline), { title: "hello" });

        const big = { title: "big", body: "x".repeat(200) };
        const base = makeObservation({ id: "obs_aaaaaaaaaaaaaaaaaaaaaaa3", payloadHash: "hash-3" });
        const ref: PayloadRef = await toPayloadRef(rawPayloadRoot, base, big, 64);
        assert.equal(ref.kind, "file");
        const fileObservation = makeObservation({ id: base.id, payloadHash: base.payloadHash, payloadRef: ref });
        await stores.raw.putIfAbsent(fileObservation);
        const stored = await stores.raw.get(fileObservation.id);
        assert.notEqual(stored, null);
        assert.deepEqual(await stores.raw.readPayload(stored as RawObservation), big);
      });
    });

    test("document upsert stores what it is given and reads back by id and source", async () => {
      await withStores(async ({ stores }) => {
        await seedGraph(stores);
        const document = makeDocument();
        const loaded = await stores.documents.get(document.id);
        assert.deepEqual(loaded, document);
        assert.deepEqual(await stores.documents.getBySource("hackernews", "item-1"), document);

        // 두 번째 observation 이 와도 firstObservationId 는 호출자가 준 값 그대로 유지된다.
        await stores.raw.putIfAbsent(makeObservation({ id: "obs_aaaaaaaaaaaaaaaaaaaaaaa2", payloadHash: "hash-2" }));
        const updated = makeDocument({
          latestObservationId: "obs_aaaaaaaaaaaaaaaaaaaaaaa2",
          title: "Hello v2",
          status: "CORRECTED",
        });
        await stores.documents.upsert(updated);
        const reloaded = await stores.documents.get(document.id);
        assert.equal(reloaded?.firstObservationId, "obs_aaaaaaaaaaaaaaaaaaaaaaa1");
        assert.equal(reloaded?.latestObservationId, "obs_aaaaaaaaaaaaaaaaaaaaaaa2");
        assert.equal(reloaded?.title, "Hello v2");
        assert.deepEqual(await stores.documents.findByCanonicalUrl("https://example.com/a"), [updated]);
      });
    });

    test("listInWindow falls back to fetchedAt when publishedAt is null", async () => {
      await withStores(async ({ stores }) => {
        await seedGraph(stores);
        await stores.raw.putIfAbsent(
          makeObservation({ id: "obs_aaaaaaaaaaaaaaaaaaaaaaa2", externalId: "item-2", payloadHash: "hash-2" }),
        );
        // publishedAt 은 window 밖이지만 fetchedAt 은 안. fallback 이 없으면 잡히지 않는다.
        await stores.documents.upsert(
          makeDocument({
            id: "doc_aaaaaaaaaaaaaaaaaaaaaaa2",
            externalId: "item-2",
            latestObservationId: "obs_aaaaaaaaaaaaaaaaaaaaaaa2",
            firstObservationId: "obs_aaaaaaaaaaaaaaaaaaaaaaa2",
            canonicalUrl: "https://example.com/b",
            publishedAt: null,
            fetchedAt: "2026-09-11T20:00:00.000Z",
          }),
        );
        await stores.raw.putIfAbsent(
          makeObservation({ id: "obs_aaaaaaaaaaaaaaaaaaaaaaa3", externalId: "item-3", payloadHash: "hash-3" }),
        );
        await stores.documents.upsert(
          makeDocument({
            id: "doc_aaaaaaaaaaaaaaaaaaaaaaa3",
            externalId: "item-3",
            latestObservationId: "obs_aaaaaaaaaaaaaaaaaaaaaaa3",
            firstObservationId: "obs_aaaaaaaaaaaaaaaaaaaaaaa3",
            canonicalUrl: "https://example.com/c",
            publishedAt: null,
            fetchedAt: "2026-09-01T00:00:00.000Z",
          }),
        );

        const inWindow = await stores.documents.listInWindow({
          start: "2026-09-11T00:00:00.000Z",
          end: "2026-09-12T00:00:00.000Z",
        });
        assert.deepEqual(
          inWindow.map((document) => document.id).sort(),
          ["doc_aaaaaaaaaaaaaaaaaaaaaaa1", "doc_aaaaaaaaaaaaaaaaaaaaaaa2"],
        );
        // 최신순 정렬: fetchedAt 20:00 > publishedAt 10:00
        assert.equal(inWindow[0]?.id, "doc_aaaaaaaaaaaaaaaaaaaaaaa2");
      });
    });

    test("document links upsert by (from, to, type)", async () => {
      await withStores(async ({ stores }) => {
        await seedGraph(stores);
        await stores.raw.putIfAbsent(
          makeObservation({ id: "obs_aaaaaaaaaaaaaaaaaaaaaaa2", externalId: "item-2", payloadHash: "hash-2" }),
        );
        await stores.documents.upsert(
          makeDocument({
            id: "doc_aaaaaaaaaaaaaaaaaaaaaaa2",
            externalId: "item-2",
            latestObservationId: "obs_aaaaaaaaaaaaaaaaaaaaaaa2",
            firstObservationId: "obs_aaaaaaaaaaaaaaaaaaaaaaa2",
            canonicalUrl: "https://example.com/b",
          }),
        );
        await stores.documents.upsertLink({
          fromDocumentId: "doc_aaaaaaaaaaaaaaaaaaaaaaa1",
          toDocumentId: "doc_aaaaaaaaaaaaaaaaaaaaaaa2",
          type: "SAME_URL",
          confidence: 0.5,
          provenance: provenance(),
        });
        await stores.documents.upsertLink({
          fromDocumentId: "doc_aaaaaaaaaaaaaaaaaaaaaaa1",
          toDocumentId: "doc_aaaaaaaaaaaaaaaaaaaaaaa2",
          type: "SAME_URL",
          confidence: 1,
          provenance: provenance(),
        });
        const links = await stores.documents.linksOf("doc_aaaaaaaaaaaaaaaaaaaaaaa2");
        assert.equal(links.length, 1);
        assert.equal(links[0]?.confidence, 1);
      });
    });

    test("entity lookup by repository url, normalized name and alias", async () => {
      await withStores(async ({ stores }) => {
        await seedGraph(stores);
        const entity = makeEntity();
        await stores.entities.upsert(entity);
        assert.deepEqual(await stores.entities.get(entity.id), entity);
        assert.deepEqual(
          await stores.entities.findByRepositoryUrl("https://github.com/anthropics/claude-code"),
          entity,
        );
        const byName = await stores.entities.findByNormalizedName("claude code");
        assert.deepEqual(byName.map((item) => item.id), [entity.id]);
        const byAlias = await stores.entities.findByNormalizedName("cc");
        assert.deepEqual(byAlias.map((item) => item.id), [entity.id]);
        assert.deepEqual(await stores.entities.findByNormalizedName("nothing"), []);

        const mention: EntityMention = {
          documentId: "doc_aaaaaaaaaaaaaaaaaaaaaaa1",
          entityId: entity.id,
          surfaceForm: "Claude Code",
          resolution: "RESOLVED",
          candidateEntityIds: [],
          confidence: 0.95,
          locatorKey: "excerpt:0:11",
          provenance: provenance(),
        };
        await stores.entities.upsertMention(mention);
        await stores.entities.upsertMention({ ...mention, confidence: 0.99 });
        const mentions = await stores.entities.mentionsOf("doc_aaaaaaaaaaaaaaaaaaaaaaa1");
        assert.equal(mentions.length, 1);
        assert.equal(mentions[0]?.confidence, 0.99);
      });
    });

    test("metric record counts only newly inserted rows", async () => {
      await withStores(async ({ stores }) => {
        await seedGraph(stores);
        const first = makeMetric();
        const second = makeMetric({ observedAt: "2026-09-11T13:00:00.000Z", value: 130 });
        assert.equal(await stores.metrics.record([first, second]), 2);
        assert.equal(await stores.metrics.record([first, second]), 0);
        assert.equal(await stores.metrics.record([first, makeMetric({ observedAt: "2026-09-11T14:00:00.000Z" })]), 1);

        const series = await stores.metrics.series("doc_aaaaaaaaaaaaaaaaaaaaaaa1", "hn.points", {
          start: "2026-09-11T00:00:00.000Z",
          end: "2026-09-11T13:30:00.000Z",
        });
        assert.deepEqual(series.map((item) => item.value), [120, 130]);
        assert.deepEqual(series[0], first);
      });
    });

    test("derived signal upsert replaces the same key", async () => {
      await withStores(async ({ stores }) => {
        await seedGraph(stores);
        await stores.entities.upsert(makeEntity());
        await stores.metrics.upsertSignal(makeSignal());
        await stores.metrics.upsertSignal(makeSignal({ value: 2.5 }));
        const signals = await stores.metrics.signals("ent_TEST0000000000000000001", {
          start: "2026-09-11T00:00:00.000Z",
          end: "2026-09-13T00:00:00.000Z",
        });
        assert.equal(signals.length, 1);
        assert.equal(signals[0]?.value, 2.5);

        await stores.metrics.upsertSignal(
          makeSignal({ value: 9, provenance: provenance({ method: "DERIVED", policyVersion: "2.0.0" }) }),
        );
        const both = await stores.metrics.signals("ent_TEST0000000000000000001", {
          start: "2026-09-11T00:00:00.000Z",
          end: "2026-09-13T00:00:00.000Z",
        });
        assert.equal(both.length, 2);
      });
    });

    test("evidence, analysis cache key, claims and classifications roundtrip", async () => {
      await withStores(async ({ stores }) => {
        await seedGraph(stores);
        await stores.entities.upsert(makeEntity());
        const evidence = makeEvidence();
        await stores.claims.putEvidence([evidence]);
        await stores.claims.putEvidence([evidence]);
        assert.deepEqual(await stores.claims.getEvidence([evidence.id]), [evidence]);
        assert.deepEqual(await stores.claims.evidenceOfDocument(evidence.documentId), [evidence]);
        assert.deepEqual(await stores.claims.getEvidence([]), []);

        const analysis = makeAnalysis();
        await stores.claims.putAnalysis(analysis);
        assert.deepEqual(await stores.claims.findAnalysisByCacheKey(analysis.cacheKey), analysis);
        assert.equal(await stores.claims.findAnalysisByCacheKey("missing"), null);

        const claim = makeClaim();
        await stores.claims.putClaims([claim]);
        await stores.claims.putClaims([claim]);
        assert.deepEqual(await stores.claims.claimsByAnalysis(analysis.id), [claim]);
        assert.deepEqual(await stores.claims.claimsForDocuments([evidence.documentId]), [claim]);
        assert.deepEqual(await stores.claims.claimsForDocuments([]), []);

        const classification = makeClassification();
        await stores.claims.putClassification(classification, "1.0.0");
        await stores.claims.putClassification({ ...classification, audience: "GENERAL" }, "1.0.0");
        const found = await stores.claims.classificationsFor([classification.documentId], "1.0.0");
        assert.equal(found.length, 1);
        assert.equal(found[0]?.audience, "GENERAL");
        assert.deepEqual(await stores.claims.classificationsFor([classification.documentId], "2.0.0"), []);
      });
    });

    test("artifact putRevision skips identical content and bumps otherwise", async () => {
      await withStores(async ({ stores }) => {
        await stores.runs.put(makeRun());
        const body: BriefBody = { bodySchemaVersion: 2, date: "2026-09-12", items: ["a"] };
        const first = makeArtifact(body);
        const head1 = await stores.artifacts.putRevision(first);
        assert.deepEqual(head1, { type: "DAILY_BRIEF", targetKey: "2026-09-12", revision: 1 });

        // 같은 contentHash → 새 revision 을 만들지 않는다.
        const same = makeArtifact(body, { revision: 2 });
        assert.deepEqual(await stores.artifacts.putRevision(same), head1);
        assert.equal(await stores.artifacts.get("DAILY_BRIEF", "2026-09-12", 2), null);

        // 다른 contentHash → head + 1.
        const nextBody: BriefBody = { bodySchemaVersion: 2, date: "2026-09-12", items: ["a", "b"] };
        const changed = makeArtifact(nextBody, { revision: 1, status: "FINAL" });
        const head2 = await stores.artifacts.putRevision(changed);
        assert.equal(head2.revision, 2);
        assert.deepEqual(await stores.artifacts.head("DAILY_BRIEF", "2026-09-12"), head2);

        const loaded = await stores.artifacts.get<BriefBody>("DAILY_BRIEF", "2026-09-12", 2);
        assert.equal(loaded?.revision, 2);
        assert.equal(loaded?.status, "FINAL");
        assert.deepEqual(loaded?.body, nextBody);
        assert.deepEqual(loaded?.window, changed.window);
        assert.equal(loaded?.timezone, "Asia/Seoul");
        assert.deepEqual(loaded?.inputs, changed.inputs);

        assert.equal(await stores.artifacts.head("WEEKLY_REPORT", "2026-W37"), null);
      });
    });

    test("approvals and latestPublication return the highest revision", async () => {
      await withStores(async ({ stores }) => {
        await stores.runs.put(makeRun());
        const body: BriefBody = { bodySchemaVersion: 2, date: "2026-09-12", items: ["a"] };
        const artifact = makeArtifact(body);
        await stores.artifacts.putRevision(artifact);

        await stores.artifacts.putApproval({
          artifactId: artifact.id,
          revision: 1,
          contentHash: artifact.contentHash,
          renderedAssetHash: null,
          channel: "notion",
          approvedBy: "POLICY",
          approvedAt: "2026-09-12T03:00:00.000Z",
          note: null,
        });
        const approval = await stores.artifacts.approval(artifact.id, 1, "notion");
        assert.equal(approval?.approvedBy, "POLICY");
        assert.equal(await stores.artifacts.approval(artifact.id, 2, "notion"), null);

        for (const revision of [1, 3, 2]) {
          await stores.artifacts.putPublication({
            artifactId: artifact.id,
            revision,
            channel: "notion",
            externalId: `page-${revision}`,
            externalUrl: null,
            status: "SUCCEEDED",
            attempt: 1,
            renderedHash: `rendered-${revision}`,
            scheduledAt: null,
            publishedAt: "2026-09-12T04:00:00.000Z",
            error: null,
            runId: RUN_ID,
          });
        }
        const latest = await stores.artifacts.latestPublication(artifact.id, "notion");
        assert.equal(latest?.revision, 3);
        assert.equal(latest?.externalId, "page-3");
        assert.equal(await stores.artifacts.latestPublication(artifact.id, "discord"), null);
      });
    });

    test("run put/get roundtrip with appended events", async () => {
      await withStores(async ({ stores }) => {
        const run = makeRun();
        await stores.runs.put(run);
        assert.deepEqual(await stores.runs.get(run.id), run);

        await stores.runs.appendEvent(run.id, "2026-09-12T00:01:00.000Z", {
          type: "ITEM_COLLECTED",
          observationId: "obs_aaaaaaaaaaaaaaaaaaaaaaa1",
          sourceId: "hackernews",
        });
        await stores.runs.appendEvent(run.id, "2026-09-12T00:02:00.000Z", {
          type: "ITEM_NORMALIZED",
          documentId: "doc_aaaaaaaaaaaaaaaaaaaaaaa1",
        });

        const finished = makeRun({ status: "SUCCESS", finishedAt: "2026-09-12T00:30:00.000Z" });
        await stores.runs.put(finished);
        const reloaded = await stores.runs.get(run.id);
        assert.equal(reloaded?.status, "SUCCESS");
        assert.equal(reloaded?.finishedAt, "2026-09-12T00:30:00.000Z");

        assert.deepEqual(await stores.runs.latestByKind("DAILY"), finished);
        assert.equal(await stores.runs.latestByKind("WEEKLY"), null);
      });
    });

    test("checkpoint put/get", async () => {
      await withStores(async ({ stores }) => {
        assert.equal(await stores.checkpoints.get("hackernews"), null);
        await stores.checkpoints.put(
          "hackernews",
          { schemaVersion: 1, data: { lastItemId: 42 } },
          RUN_ID,
          "2026-09-12T00:10:00.000Z",
        );
        assert.deepEqual(await stores.checkpoints.get("hackernews"), { schemaVersion: 1, data: { lastItemId: 42 } });
        await stores.checkpoints.put(
          "hackernews",
          { schemaVersion: 1, data: { lastItemId: 99 } },
          RUN_ID,
          "2026-09-12T00:20:00.000Z",
        );
        assert.deepEqual(await stores.checkpoints.get("hackernews"), { schemaVersion: 1, data: { lastItemId: 99 } });
      });
    });

    test("unit of work commits and supports nesting", async () => {
      await withStores(async ({ stores }) => {
        const value = await stores.unitOfWork.transaction(async () => {
          await stores.runs.put(makeRun());
          return stores.unitOfWork.transaction(async () => {
            await stores.raw.putIfAbsent(makeObservation());
            return "ok";
          });
        });
        assert.equal(value, "ok");
        assert.notEqual(await stores.runs.get(RUN_ID), null);
        assert.notEqual(await stores.raw.get("obs_aaaaaaaaaaaaaaaaaaaaaaa1"), null);
      });
    });
  });
}
