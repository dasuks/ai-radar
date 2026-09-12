/**
 * 테스트용 LlmProvider. 실제 호출 없이 task 별 handler 로 JSON 을 만든다.
 * 호출 기록(calls)을 남겨 "캐시 히트 시 provider 를 부르지 않는다" 같은 검증에 쓴다.
 */
import type { AnalysisTask } from "../../../domain/evidence/analysis.js";
import type { LlmCapabilities, LlmProvider, LlmRequest, LlmResponse } from "../../../ports/llm/llm-provider.js";

export interface FakeLlmCall {
  task: AnalysisTask;
  model: string;
  req: LlmRequest;
}

export type FakeLlmHandler = (req: LlmRequest) => unknown;

export class FakeLlmProvider implements LlmProvider {
  readonly id = "fake";
  readonly calls: FakeLlmCall[] = [];

  constructor(
    private readonly handlers: Partial<Record<AnalysisTask, FakeLlmHandler>>,
    private readonly options: { model?: string; maxContextTokens?: number } = {},
  ) {}

  get callCount(): number {
    return this.calls.length;
  }

  callsFor(task: AnalysisTask): FakeLlmCall[] {
    return this.calls.filter((call) => call.task === task);
  }

  capabilities(_model: string): LlmCapabilities {
    return {
      structuredOutput: true,
      toolCalling: false,
      maxContextTokens: this.options.maxContextTokens ?? 200_000,
      reasoning: false,
      usageMetadata: false,
    };
  }

  async complete(req: LlmRequest, model: string, signal: AbortSignal): Promise<LlmResponse> {
    if (signal.aborted) throw new Error("aborted");
    this.calls.push({ task: req.task, model, req });
    const handler = this.handlers[req.task];
    if (!handler) throw new Error(`FakeLlmProvider has no handler for task ${req.task}`);
    const json = handler(req);
    const raw = JSON.stringify(json);
    return {
      json,
      raw,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: null, latencyMs: 0 },
      model: this.options.model ?? model,
      provider: this.id,
      finishReason: "stop",
    };
  }
}
