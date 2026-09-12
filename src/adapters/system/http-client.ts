import type { HttpClient, HttpRequest, HttpResponse } from "../../ports/system/index.js";

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * 전역 fetch 기반 HttpClient.
 * 비-2xx 응답은 정상 반환한다 (상태 판정은 호출자의 몫). 네트워크 오류와 timeout 만 throw 한다.
 */
export class FetchHttpClient implements HttpClient {
  constructor(
    private readonly options: { userAgent?: string; defaultTimeoutMs?: number } = {},
  ) {}

  async request(req: HttpRequest): Promise<HttpResponse> {
    const timeoutMs = req.timeoutMs ?? this.options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = (): void => controller.abort();
    req.signal?.addEventListener("abort", onExternalAbort, { once: true });

    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    if (this.options.userAgent && !headers["user-agent"] && !headers["User-Agent"]) {
      headers["User-Agent"] = this.options.userAgent;
    }

    try {
      const response = await fetch(req.url, {
        method: req.method ?? "GET",
        headers,
        ...(req.body === undefined ? {} : { body: req.body }),
        signal: controller.signal,
      });
      const text = await response.text();
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key.toLowerCase()] = value;
      });
      return { status: response.status, headers: responseHeaders, text };
    } catch (error) {
      const aborted = controller.signal.aborted;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(aborted ? `HTTP request timed out after ${timeoutMs}ms: ${req.url}` : `HTTP request failed: ${message}`);
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}
