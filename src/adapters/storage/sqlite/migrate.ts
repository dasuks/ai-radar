import type { SqliteDriver } from "./driver.js";
import { MIGRATIONS, type Migration } from "./migrations/index.js";

const BOOTSTRAP = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
);`;

export interface MigrateResult {
  applied: number[];
  currentVersion: number;
}

/**
 * 미적용 migration 을 순서대로 트랜잭션 안에서 적용하고 schema_migrations 에 기록한다.
 * 이미 최신이면 아무것도 하지 않는다 (두 번 실행해도 no-op).
 */
export function migrate(
  db: SqliteDriver,
  appliedAt: string,
  migrations: readonly Migration[] = MIGRATIONS,
): MigrateResult {
  db.exec(BOOTSTRAP);
  const rows = db.all("SELECT version FROM schema_migrations");
  const done = new Set<number>();
  for (const row of rows) {
    const value = row["version"];
    if (typeof value === "number") done.add(value);
    else if (typeof value === "bigint") done.add(Number(value));
  }

  const applied: number[] = [];
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (done.has(migration.version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", [
        migration.version,
        migration.name,
        appliedAt,
      ]);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    applied.push(migration.version);
    done.add(migration.version);
  }

  return { applied, currentVersion: done.size === 0 ? 0 : Math.max(...done) };
}
