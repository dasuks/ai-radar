import type { CheckpointStore, DocumentStore, MetricStore, RawStore } from "../../src/ports/storage/index.js";
import type { DocumentLink, NormalizedDocument } from "../../src/domain/documents/normalized-document.js";
import type { RawObservation } from "../../src/domain/documents/raw-observation.js";
import type { MetricObservation } from "../../src/domain/metrics/metric-observation.js";
import type { DerivedSignal } from "../../src/domain/metrics/derived-signal.js";
import type { SourceCheckpoint } from "../../src/ports/sources/source-adapter.js";
import type { TimeWindow } from "../../src/domain/shared/time.js";
import { isWithinWindow } from "../../src/domain/shared/time.js";

function notImplemented(name: string): never {
  throw new Error(`not implemented: ${name}`);
}

export class InMemoryRawStore implements RawStore {
  readonly observations = new Map<string, RawObservation>();

  async putIfAbsent(observation: RawObservation): Promise<boolean> {
    if (this.observations.has(observation.id)) return false;
    this.observations.set(observation.id, observation);
    return true;
  }

  async get(id: string): Promise<RawObservation | null> {
    return this.observations.get(id) ?? null;
  }

  async listBySource(sourceId: string, window: TimeWindow): Promise<RawObservation[]> {
    return [...this.observations.values()].filter(
      (observation) => observation.sourceId === sourceId && isWithinWindow(observation.observedAt, window),
    );
  }

  async readPayload(observation: RawObservation): Promise<unknown> {
    if (observation.payloadRef.kind === "inline") return observation.payloadRef.json;
    return notImplemented("InMemoryRawStore.readPayload(file)");
  }
}

export interface StoredCheckpoint {
  checkpoint: SourceCheckpoint;
  runId: string;
  updatedAt: string;
}

export class InMemoryCheckpointStore implements CheckpointStore {
  readonly saved = new Map<string, StoredCheckpoint>();
  writes = 0;

  async get(sourceId: string): Promise<SourceCheckpoint | null> {
    return this.saved.get(sourceId)?.checkpoint ?? null;
  }

  async put(sourceId: string, checkpoint: SourceCheckpoint, runId: string, updatedAt: string): Promise<void> {
    this.writes += 1;
    this.saved.set(sourceId, { checkpoint, runId, updatedAt });
  }

  seed(sourceId: string, checkpoint: SourceCheckpoint): void {
    this.saved.set(sourceId, { checkpoint, runId: "run_seed", updatedAt: "1970-01-01T00:00:00.000Z" });
  }
}

function linkKey(link: DocumentLink): string {
  return `${link.fromDocumentId}|${link.toDocumentId}|${link.type}`;
}

export class InMemoryDocumentStore implements DocumentStore {
  readonly documents = new Map<string, NormalizedDocument>();
  readonly links = new Map<string, DocumentLink>();

  async upsert(document: NormalizedDocument): Promise<void> {
    this.documents.set(document.id, document);
  }

  async get(id: string): Promise<NormalizedDocument | null> {
    return this.documents.get(id) ?? null;
  }

  async getBySource(sourceId: string, externalId: string): Promise<NormalizedDocument | null> {
    for (const document of this.documents.values()) {
      if (document.sourceId === sourceId && document.externalId === externalId) return document;
    }
    return null;
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
    this.links.set(linkKey(link), link);
  }

  async linksOf(documentId: string): Promise<DocumentLink[]> {
    return [...this.links.values()].filter(
      (link) => link.fromDocumentId === documentId || link.toDocumentId === documentId,
    );
  }
}

function metricKeyOf(observation: MetricObservation): string {
  return [
    observation.subjectType,
    observation.subjectId,
    observation.key,
    observation.sourceId,
    observation.observedAt,
  ].join("|");
}

export class InMemoryMetricStore implements MetricStore {
  readonly observations = new Map<string, MetricObservation>();

  async record(observations: MetricObservation[]): Promise<number> {
    let written = 0;
    for (const observation of observations) {
      const key = metricKeyOf(observation);
      if (this.observations.has(key)) continue;
      this.observations.set(key, observation);
      written += 1;
    }
    return written;
  }

  async series(
    subjectId: string,
    key: MetricObservation["key"],
    window: TimeWindow,
  ): Promise<MetricObservation[]> {
    return [...this.observations.values()].filter(
      (observation) =>
        observation.subjectId === subjectId &&
        observation.key === key &&
        isWithinWindow(observation.observedAt, window),
    );
  }

  async upsertSignal(_signal: DerivedSignal): Promise<void> {
    return notImplemented("InMemoryMetricStore.upsertSignal");
  }

  async signals(_subjectId: string, _window: TimeWindow): Promise<DerivedSignal[]> {
    return notImplemented("InMemoryMetricStore.signals");
  }
}
