import type { SqlRow, SqlValue } from "./driver.js";

export function text(row: SqlRow, column: string): string {
  const value = row[column];
  return typeof value === "string" ? value : "";
}

export function textOrNull(row: SqlRow, column: string): string | null {
  const value = row[column];
  return typeof value === "string" ? value : null;
}

export function num(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return 0;
}

export function bool(row: SqlRow, column: string): boolean {
  return num(row, column) !== 0;
}

export function json<T>(row: SqlRow, column: string, fallback: T): T {
  const value = row[column];
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** IN (?, ?, ...) 자리표시자. 빈 목록이면 null 을 돌려주어 호출자가 쿼리를 건너뛰게 한다. */
export function placeholders(count: number): string {
  return new Array(count).fill("?").join(", ");
}

export function toParams(values: readonly (string | number | null)[]): SqlValue[] {
  return values.map((value) => value);
}
