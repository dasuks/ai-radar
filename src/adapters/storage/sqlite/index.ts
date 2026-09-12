import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Stores } from "../../../ports/storage/index.js";
import { openDatabase, type SqliteDriver } from "./driver.js";
import { migrate } from "./migrate.js";
import {
  SqliteArtifactStore,
  SqliteCheckpointStore,
  SqliteClaimStore,
  SqliteDocumentStore,
  SqliteEntityStore,
  SqliteMetricStore,
  SqliteRawStore,
  SqliteRunStore,
  SqliteUnitOfWork,
} from "./stores.js";

export interface OpenSqliteStoresOptions {
  /** SQLite 파일과 artifact body 파일이 사는 디렉터리 (`data/store`). */
  dir: string;
  /** 기본 "ai-radar.sqlite". ":memory:" 를 주면 메모리 DB 를 연다. */
  filename?: string;
  /** Raw payload 파일 루트. PayloadRef 의 상대 경로는 여기를 기준으로 읽는다. */
  rawPayloadRoot: string;
  /** migration 기록 시각. 기본은 현재 시각. */
  appliedAt?: string;
}

export interface SqliteStores extends Stores {
  /** 테스트·진단용. Port 계약은 아니다. */
  readonly db: SqliteDriver;
}

/** CONTRACTS_AND_DATA.md §7 저장소 어댑터 진입점. 열면서 미적용 migration 을 적용한다. */
export function openSqliteStores(options: OpenSqliteStoresOptions): SqliteStores {
  const filename = options.filename ?? "ai-radar.sqlite";
  const inMemory = filename === ":memory:";
  if (!inMemory) mkdirSync(options.dir, { recursive: true });
  const file = inMemory ? ":memory:" : path.resolve(options.dir, filename);
  const db = openDatabase(file);
  migrate(db, options.appliedAt ?? new Date().toISOString());

  return {
    db,
    raw: new SqliteRawStore(db, options.rawPayloadRoot),
    documents: new SqliteDocumentStore(db),
    entities: new SqliteEntityStore(db),
    metrics: new SqliteMetricStore(db),
    claims: new SqliteClaimStore(db),
    artifacts: new SqliteArtifactStore(db, options.dir),
    runs: new SqliteRunStore(db),
    checkpoints: new SqliteCheckpointStore(db),
    unitOfWork: new SqliteUnitOfWork(db),
    async close(): Promise<void> {
      db.close();
    },
  };
}

export { migrate } from "./migrate.js";
export { MIGRATIONS, type Migration } from "./migrations/index.js";
export { openDatabase, type SqliteDriver } from "./driver.js";
export { nextRevision } from "./stores.js";
