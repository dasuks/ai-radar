import type { DomainEvent } from "../../domain/runs/run.js";

export interface Clock {
  nowMs(): number;
  nowIso(): string;
}

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** 하위 로거 (prefix 부여) */
  child(scope: string): Logger;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

export interface HttpRequest {
  url: string;
  method?: "GET" | "POST" | "PATCH";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 소스 adapter는 이 Port로만 네트워크에 접근한다 (fetch 직접 호출 금지). */
export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export interface EventSink {
  emit(event: DomainEvent, runId: string): void;
}

export interface RandomSource {
  bytes(n: number): Uint8Array;
}
