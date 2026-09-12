import type { Clock } from "../../ports/system/index.js";

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }

  nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }
}

/** 테스트·재현용 고정 시계. */
export class FixedClock implements Clock {
  constructor(private current: number) {}

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
