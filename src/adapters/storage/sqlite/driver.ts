import { DatabaseSync } from "node:sqlite";

/**
 * node:sqlite 를 감싸는 유일한 파일 (CONTRACTS_AND_DATA.md §7.6).
 * node:sqlite 가 바뀌거나 better-sqlite3 로 교체하면 이 파일만 고친다.
 *
 * UNVERIFIED EXTERNAL CONSTRAINT: node:sqlite 는 Node 24 에서 experimental 이며
 * import 시 ExperimentalWarning 을 출력한다. 확인 방법은 §7.6.
 */

export type SqlValue = null | number | bigint | string | Uint8Array;
export type SqlRow = Record<string, unknown>;

export interface SqliteDriver {
  exec(sql: string): void;
  run(sql: string, params?: readonly SqlValue[]): number;
  all(sql: string, params?: readonly SqlValue[]): SqlRow[];
  get(sql: string, params?: readonly SqlValue[]): SqlRow | null;
  close(): void;
}

export interface OpenDatabaseOptions {
  /** WAL 저널을 켠다. 메모리 DB 에서는 의미가 없다. */
  walMode?: boolean;
}

/** 파일(또는 ":memory:") 을 열고 PRAGMA 를 적용한다. */
export function openDatabase(filePath: string, options: OpenDatabaseOptions = {}): SqliteDriver {
  const db = new DatabaseSync(filePath);
  // PRAGMA 는 트랜잭션 안에서 적용할 수 없으므로 migration 이 아니라 연결 시점에 건다.
  db.exec("PRAGMA foreign_keys = ON;");
  if (options.walMode !== false && filePath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
  }
  return new NodeSqliteDriver(db);
}

class NodeSqliteDriver implements SqliteDriver {
  readonly #db: DatabaseSync;
  readonly #cache = new Map<string, ReturnType<DatabaseSync["prepare"]>>();

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  run(sql: string, params: readonly SqlValue[] = []): number {
    const result = this.#prepare(sql).run(...params);
    return typeof result.changes === "bigint" ? Number(result.changes) : result.changes;
  }

  all(sql: string, params: readonly SqlValue[] = []): SqlRow[] {
    return this.#prepare(sql).all(...params) as SqlRow[];
  }

  get(sql: string, params: readonly SqlValue[] = []): SqlRow | null {
    const row = this.#prepare(sql).get(...params);
    return (row as SqlRow | undefined) ?? null;
  }

  close(): void {
    this.#cache.clear();
    this.#db.close();
  }

  #prepare(sql: string): ReturnType<DatabaseSync["prepare"]> {
    const cached = this.#cache.get(sql);
    if (cached) return cached;
    const statement = this.#db.prepare(sql);
    this.#cache.set(sql, statement);
    return statement;
  }
}
