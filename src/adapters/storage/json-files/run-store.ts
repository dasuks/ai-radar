import { readdir } from "node:fs/promises";
import type { DomainEvent, Run } from "../../../domain/runs/run.js";
import type { RunStore } from "../../../ports/storage/index.js";
import { appendLine, readJsonIfExists, segmentsToPath, writeJsonAtomic } from "./json-file.js";

/**
 * JSON 파일 기반 RunStore (Phase 1, CONTRACTS §6.1).
 *   <dir>/runs/<runId>.json        Run 스냅샷 (단계마다 flush)
 *   <dir>/runs/<runId>.events.jsonl  DomainEvent 추가 기록
 */
export class JsonFileRunStore implements RunStore {
  constructor(private readonly dir: string) {}

  private runFile(id: string): string {
    return segmentsToPath(this.dir, "runs", `${id}.json`);
  }

  async put(run: Run): Promise<void> {
    await writeJsonAtomic(this.runFile(run.id), run);
  }

  async get(id: string): Promise<Run | null> {
    return readJsonIfExists<Run>(this.runFile(id));
  }

  async appendEvent(runId: string, at: string, event: DomainEvent): Promise<void> {
    await appendLine(
      segmentsToPath(this.dir, "runs", `${runId}.events.jsonl`),
      JSON.stringify({ at, ...event }),
    );
  }

  async latestByKind(kind: Run["kind"]): Promise<Run | null> {
    let entries: string[];
    try {
      entries = await readdir(segmentsToPath(this.dir, "runs"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let latest: Run | null = null;
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry.endsWith(".events.jsonl")) continue;
      const run = await readJsonIfExists<Run>(segmentsToPath(this.dir, "runs", entry));
      if (!run || run.kind !== kind) continue;
      if (latest === null || run.startedAt > latest.startedAt) latest = run;
    }
    return latest;
  }
}
