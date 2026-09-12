export interface TimeWindow {
  start: string; // ISO 8601 UTC
  end: string; // ISO 8601 UTC
}

export function isoNow(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

export function isValidIsoDateTime(value: string): boolean {
  if (typeof value !== "string" || value.length < 10) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

export function isValidCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month! - 1 &&
    parsed.getUTCDate() === day
  );
}

/** 주어진 시각을 timezone 기준 YYYY-MM-DD 로 바꾼다. */
export function calendarDateIn(timezone: string, nowMs: number): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date(nowMs));
}

/** 직전 `hours` 시간 window. end는 now. */
export function trailingWindow(nowMs: number, hours: number): TimeWindow {
  return { start: new Date(nowMs - hours * 3_600_000).toISOString(), end: new Date(nowMs).toISOString() };
}

export function isWithinWindow(iso: string | null, window: TimeWindow): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return t >= Date.parse(window.start) && t <= Date.parse(window.end);
}

export function isoWeekKey(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
