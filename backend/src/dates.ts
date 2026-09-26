// Calendar dates are plain 'YYYY-MM-DD' strings everywhere - in Postgres
// (DATE), over the API and in the browser. All arithmetic is done in UTC so a
// server clock or time zone can never shift a date by one day.

export type ISODate = string;
export type WorkWeek = 5 | 6 | 7;

const DAY_MS = 86_400_000;
// Longest span any loop below will walk. Ten years is far past any order.
const MAX_SPAN_DAYS = 3660;

const pad = (n: number) => String(n).padStart(2, '0');

export function toMs(d: ISODate): number {
  return Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
}

export function fromMs(ms: number): ISODate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(d: ISODate, n: number): ISODate {
  return fromMs(toMs(d) + n * DAY_MS);
}

export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((toMs(b) - toMs(a)) / DAY_MS);
}

export function isISODate(s: unknown): s is ISODate {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return fromMs(toMs(s)) === s; // rejects 2026-02-30 and friends
}

/** Today on the server's own clock (the factory's local date). */
export function todayLocal(): ISODate {
  const n = new Date();
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
}

/** The calendar date of a moment, on the server's own clock (the factory's local date). */
export function localISODate(t: Date | string): ISODate {
  const n = typeof t === 'string' ? new Date(t) : t;
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
}

export const maxDate = (a: ISODate, b: ISODate) => (a > b ? a : b);
export const minDate = (a: ISODate, b: ISODate) => (a < b ? a : b);

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
export function weekday(d: ISODate): number {
  const w = new Date(toMs(d)).getUTCDay();
  return w === 0 ? 7 : w;
}

/** 5 = Mon-Fri, 6 = Mon-Sat, 7 = every day (same meaning as the workbook). */
export function isWorkingDay(d: ISODate, ww: WorkWeek): boolean {
  const w = weekday(d);
  if (ww === 7) return true;
  if (ww === 6) return w !== 7;
  return w <= 5;
}

/** The first working day on or after d. */
export function nextWorkingDay(d: ISODate, ww: WorkWeek): ISODate {
  let x = d;
  for (let i = 0; i < 7 && !isWorkingDay(x, ww); i++) x = addDays(x, 1);
  return x;
}

/** Working days in [from, to], both ends included. 0 when to < from. */
export function workingDaysBetween(from: ISODate, to: ISODate, ww: WorkWeek): number {
  if (to < from) return 0;
  const span = Math.min(daysBetween(from, to), MAX_SPAN_DAYS);
  let n = 0;
  for (let i = 0; i <= span; i++) if (isWorkingDay(addDays(from, i), ww)) n++;
  return n;
}

/**
 * The date of the n-th working day, counting `start` itself as day 1 when it
 * is a working day. n = 1 on a working day returns that same day.
 */
export function nthWorkingDay(start: ISODate, n: number, ww: WorkWeek): ISODate {
  let x = nextWorkingDay(start, ww);
  let left = Math.max(1, n) - 1;
  for (let i = 0; left > 0 && i < MAX_SPAN_DAYS; i++) {
    x = addDays(x, 1);
    if (isWorkingDay(x, ww)) left--;
  }
  return x;
}

/**
 * Signed working-day gap from a to b: the working days after a up to and
 * including b. Positive when b is later. Used for "days early / late".
 */
export function workingDayDiff(a: ISODate, b: ISODate, ww: WorkWeek): number {
  if (a === b) return 0;
  return b > a
    ? workingDaysBetween(addDays(a, 1), b, ww)
    : -workingDaysBetween(addDays(b, 1), a, ww);
}
