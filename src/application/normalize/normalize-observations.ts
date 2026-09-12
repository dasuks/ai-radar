import type { SourceAdapter } from "../../ports/sources/source-adapter.js";
import type { DocumentStore, RawStore } from "../../ports/storage/index.js";
import type { Clock, EventSink, Logger } from "../../ports/system/index.js";
import type { NormalizedDocument } from "../../domain/documents/normalized-document.js";
import { validateNormalizedDocument } from "../../domain/documents/normalized-document.js";
import type { RawObservation } from "../../domain/documents/raw-observation.js";

export interface NormalizeObservationsDeps {
  /** sourceId → adapter. composition root 가 주입한다 (PIPELINES §3.1). */
  adapters: readonly SourceAdapter[];
  raw: RawStore;
  documents: DocumentStore;
  clock: Clock;
  logger: Logger;
  events: EventSink;
}

export interface NormalizeObservationsInput {
  /** RawObservation 또는 그 id */
  observations: readonly (string | RawObservation)[];
  runId: string;
}

export interface NormalizeError {
  observationId: string;
  message: string;
}

export interface NormalizeSummary {
  documents: NormalizedDocument[];
  documentsUpserted: number;
  skipped: number;
  errors: NormalizeError[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : "UnknownError";
}

/**
 * NormalizeObservations Use Case (PIPELINES_AND_POLICIES.md §3.1).
 *
 * sourceId 로 adapter 를 찾아 normalize 를 호출하고, domain validator 로 검증한 뒤 upsert 한다.
 * 검증에 실패한 문서는 그 문서만 skip 하고 오류로 남긴다. 절대 throw 하지 않는다.
 */
export class NormalizeObservations {
  private readonly deps: NormalizeObservationsDeps;
  private readonly log: Logger;
  private readonly bySourceId: Map<string, SourceAdapter>;

  constructor(deps: NormalizeObservationsDeps) {
    this.deps = deps;
    this.log = deps.logger.child("normalize");
    this.bySourceId = new Map(deps.adapters.map((adapter) => [adapter.descriptor.id, adapter]));
  }

  async normalize(input: NormalizeObservationsInput): Promise<NormalizeSummary> {
    const summary: NormalizeSummary = { documents: [], documentsUpserted: 0, skipped: 0, errors: [] };

    for (const entry of input.observations) {
      const reference = typeof entry === "string" ? entry : entry.id;
      try {
        const observation = typeof entry === "string" ? await this.deps.raw.get(entry) : entry;
        if (!observation) {
          this.fail(summary, reference, "observation not found in raw store");
          continue;
        }
        const adapter = this.bySourceId.get(observation.sourceId);
        if (!adapter) {
          this.fail(summary, reference, `no adapter registered for sourceId ${observation.sourceId}`);
          continue;
        }

        const existing = await this.deps.documents.getBySource(observation.sourceId, observation.externalId);
        const produced = adapter.normalize({
          observation,
          existing,
          runId: input.runId,
          normalizedAt: this.deps.clock.nowIso(),
        });
        const document = validateNormalizedDocument(this.reconcile(produced, existing));

        await this.deps.documents.upsert(document);
        summary.documents.push(document);
        summary.documentsUpserted += 1;
        this.deps.events.emit({ type: "ITEM_NORMALIZED", documentId: document.id }, input.runId);
      } catch (error) {
        this.fail(summary, reference, errorMessage(error));
      }
    }

    this.log.info("normalize finished", {
      upserted: summary.documentsUpserted,
      skipped: summary.skipped,
      errors: summary.errors.length,
    });
    return summary;
  }

  /** 기존 문서가 있으면 firstObservationId 를 유지하고, 본문이 바뀌었으면 CORRECTED 로 표시한다. */
  private reconcile(produced: NormalizedDocument, existing: NormalizedDocument | null): NormalizedDocument {
    if (!existing) return produced;
    const contentChanged = existing.content !== produced.content || existing.title !== produced.title;
    return {
      ...produced,
      firstObservationId: existing.firstObservationId,
      status: produced.status === "DELETED" ? "DELETED" : contentChanged ? "CORRECTED" : produced.status,
    };
  }

  private fail(summary: NormalizeSummary, observationId: string, message: string): void {
    summary.skipped += 1;
    summary.errors.push({ observationId, message });
    // 외부 본문은 로그에 넣지 않는다 (INTEGRATIONS §5.1). id 와 사유만 남긴다.
    this.log.error("observation not normalized", { observationId, message });
  }
}
