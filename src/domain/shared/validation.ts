/**
 * 손으로 쓴 경량 validator 유틸. domain은 외부 패키지를 쓰지 않는다 (ARCHITECTURE.md §2.3).
 */
export type JsonObject = Record<string, unknown>;

export class ContractValidationError extends Error {
  constructor(
    public readonly contract: string,
    public readonly issues: string[],
  ) {
    super(`${contract} validation failed:\n- ${issues.join("\n- ")}`);
    this.name = "ContractValidationError";
  }
}

export class Issues {
  readonly list: string[] = [];
  constructor(private readonly contract: string) {}
  push(message: string): void {
    this.list.push(message);
  }
  throwIfAny(): void {
    if (this.list.length > 0) throw new ContractValidationError(this.contract, this.list);
  }
}

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireString(obj: JsonObject, key: string, path: string, issues: Issues): string {
  const value = obj[key];
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${path}.${key} must be a non-empty string`);
    return "";
  }
  return value;
}

export function optionalString(obj: JsonObject, key: string, path: string, issues: Issues): string | null {
  const value = obj[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    issues.push(`${path}.${key} must be a string or null`);
    return null;
  }
  return value;
}

export function requireNumber(obj: JsonObject, key: string, path: string, issues: Issues): number {
  const value = obj[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push(`${path}.${key} must be a finite number`);
    return 0;
  }
  return value;
}

export function requireBoolean(obj: JsonObject, key: string, path: string, issues: Issues): boolean {
  const value = obj[key];
  if (typeof value !== "boolean") {
    issues.push(`${path}.${key} must be a boolean`);
    return false;
  }
  return value;
}

export function requireEnum<T extends string>(
  obj: JsonObject,
  key: string,
  allowed: readonly T[],
  path: string,
  issues: Issues,
): T {
  const value = obj[key];
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    issues.push(`${path}.${key} must be one of ${allowed.join("|")}`);
    return allowed[0]!;
  }
  return value as T;
}

export function stringArray(value: unknown, path: string, issues: Issues): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array of strings`);
    return [];
  }
  const out: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== "string") issues.push(`${path}[${index}] must be a string`);
    else if (item.trim()) out.push(item.trim());
  });
  return out;
}

export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
