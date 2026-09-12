import type { Clock, EventSink, HttpClient, HttpRequest, HttpResponse, Logger } from "../../src/ports/system/index.js";
import type { DomainEvent } from "../../src/domain/runs/run.js";

/** 결정적 Clock. 필요하면 테스트에서 명시적으로 시간을 진행시킨다. */
export class FakeClock implements Clock {
  private current: number;

  constructor(startIso: string) {
    this.current = Date.parse(startIso);
  }

  nowMs(): number {
    return this.current;
  }

  nowIso(): string {
    return new Date(this.current).toISOString();
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

export interface LogLine {
  level: "info" | "warn" | "error";
  scope: string;
  message: string;
  fields: Record<string, unknown>;
}

export class FakeLogger implements Logger {
  readonly lines: LogLine[];
  private readonly scope: string;

  constructor(scope = "root", lines: LogLine[] = []) {
    this.scope = scope;
    this.lines = lines;
  }

  info(message: string, fields: Record<string, unknown> = {}): void {
    this.lines.push({ level: "info", scope: this.scope, message, fields });
  }

  warn(message: string, fields: Record<string, unknown> = {}): void {
    this.lines.push({ level: "warn", scope: this.scope, message, fields });
  }

  error(message: string, fields: Record<string, unknown> = {}): void {
    this.lines.push({ level: "error", scope: this.scope, message, fields });
  }

  child(scope: string): Logger {
    return new FakeLogger(`${this.scope}.${scope}`, this.lines);
  }

  errors(): LogLine[] {
    return this.lines.filter((line) => line.level === "error");
  }
}

export class FakeEvents implements EventSink {
  readonly events: { event: DomainEvent; runId: string }[] = [];

  emit(event: DomainEvent, runId: string): void {
    this.events.push({ event, runId });
  }

  ofType<T extends DomainEvent["type"]>(type: T): Extract<DomainEvent, { type: T }>[] {
    return this.events
      .map((entry) => entry.event)
      .filter((event): event is Extract<DomainEvent, { type: T }> => event.type === type);
  }
}

export type RouteHandler = HttpResponse | ((request: HttpRequest) => HttpResponse);

export interface FakeHttpOptions {
  /** 요청 하나마다 호출된다. 시간 경과를 흉내 낼 때 쓴다. */
  onRequest?: (request: HttpRequest) => void;
}

export function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers: { "content-type": "application/json", ...headers }, text: JSON.stringify(value) };
}

export function textResponse(text: string, status = 200, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers: { "content-type": "application/xml", ...headers }, text };
}

/** url → 응답 매핑. 네트워크를 쓰지 않는다. */
export class FakeHttp implements HttpClient {
  readonly requests: HttpRequest[] = [];
  private readonly routes: Map<string, RouteHandler>;
  private readonly options: FakeHttpOptions;

  constructor(routes: Record<string, RouteHandler>, options: FakeHttpOptions = {}) {
    this.routes = new Map(Object.entries(routes));
    this.options = options;
  }

  set(url: string, handler: RouteHandler): void {
    this.routes.set(url, handler);
  }

  countFor(url: string): number {
    return this.requests.filter((request) => request.url === url).length;
  }

  async request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    this.options.onRequest?.(request);
    const handler = this.routes.get(request.url);
    if (handler === undefined) {
      throw new Error(`FakeHttp: no route for ${request.url}`);
    }
    return typeof handler === "function" ? handler(request) : handler;
  }
}
