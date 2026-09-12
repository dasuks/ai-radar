import type { DomainEvent } from "../../domain/runs/run.js";
import type { EventSink, Logger } from "../../ports/system/index.js";

/**
 * 초기 구현은 로그 출력뿐이다 (PIPELINES_AND_POLICIES.md §10).
 * Run 기록(`run_events`)은 RunStore 가 담당한다.
 */
export class LogEventSink implements EventSink {
  constructor(
    private readonly logger: Logger,
    private readonly onEvent?: (event: DomainEvent, runId: string) => void,
  ) {}

  emit(event: DomainEvent, runId: string): void {
    this.logger.info(`event ${event.type}`, { runId, ...event });
    this.onEvent?.(event, runId);
  }
}
