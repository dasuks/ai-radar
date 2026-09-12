import type { Logger } from "../../ports/system/index.js";

/** 레거시 `errorMessage(valuesToRedact)` 와 같은 규칙: secret 값의 모든 출현을 마스킹한다. */
export function redactText(text: string, valuesToRedact: readonly string[]): string {
  let out = text;
  for (const value of valuesToRedact) {
    if (value && value.length > 0) out = out.replaceAll(value, "[REDACTED]");
  }
  return out;
}

export type LogLevel = "info" | "warn" | "error";

export interface ConsoleLoggerOptions {
  redact?: readonly string[];
  scope?: string;
  /** 테스트에서 출력을 가로채기 위한 sink. 기본값은 console. */
  sink?: (level: LogLevel, line: string) => void;
}

function defaultSink(level: LogLevel, line: string): void {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export class ConsoleLogger implements Logger {
  private readonly valuesToRedact: readonly string[];
  private readonly scope: string;
  private readonly sink: (level: LogLevel, line: string) => void;

  constructor(options: ConsoleLoggerOptions = {}) {
    this.valuesToRedact = options.redact ?? [];
    this.scope = options.scope ?? "";
    this.sink = options.sink ?? defaultSink;
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.write("error", message, fields);
  }

  child(scope: string): Logger {
    return new ConsoleLogger({
      redact: this.valuesToRedact,
      scope: this.scope ? `${this.scope}:${scope}` : scope,
      sink: this.sink,
    });
  }

  /** 마커 없이 본문만 출력한다 (dry-run diff 등 이미 정렬된 여러 줄 출력용). */
  raw(text: string): void {
    this.sink("info", redactText(text, this.valuesToRedact));
  }

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    const prefix = this.scope ? `[${this.scope}] ` : "";
    const suffix = fields && Object.keys(fields).length > 0 ? ` ${safeJson(fields)}` : "";
    this.sink(level, redactText(`${prefix}${message}${suffix}`, this.valuesToRedact));
  }
}

function safeJson(fields: Record<string, unknown>): string {
  try {
    return JSON.stringify(fields);
  } catch {
    return "[unserializable fields]";
  }
}
