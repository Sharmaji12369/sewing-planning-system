import type { ISODate, Status } from "./api";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** 2026-09-01 -> 01 Sep 2026, the workbook's dd/mmm/yyyy without the slashes. */
export function fmtDate(d: ISODate | null | undefined): string {
  if (!d) return "—";
  return `${d.slice(8, 10)} ${MONTHS[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;
}

/** 2026-09-01 -> 1 Sep */
export function fmtDay(d: ISODate): string {
  return `${+d.slice(8, 10)} ${MONTHS[+d.slice(5, 7) - 1]}`;
}

/** An ISO timestamp as "21 Sep 2026, 14:32" in the viewer's local time. */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(t.getDate())} ${MONTHS[t.getMonth()]} ${t.getFullYear()}, ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

export function addDays(d: ISODate, n: number): ISODate {
  const t = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Calendar days from a to b (+ when b is later). */
export function daysBetween(a: ISODate, b: ISODate): number {
  const ms = (d: ISODate) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

export function weekdayName(d: ISODate): string {
  return DAYS[new Date(`${d}T00:00:00Z`).getUTCDay()];
}

// Grouped in thousands (160,000), as the workbook's #,##0 showed them.
const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export function fmtNum(n: number | null | undefined, decimals: 0 | 1 = 0): string {
  if (n == null) return "—";
  return (decimals ? nf1 : nf0).format(n);
}

export function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/** Working-day buffer as the workbook wrote it: "3 d early", "2 d late", "on time". */
export function fmtBuffer(n: number | null): string {
  if (n == null) return "—";
  if (n === 0) return "on time";
  return n > 0 ? `${n} d early` : `${-n} d late`;
}

/** The workbook's status colours, kept as they were. */
export const STATUS_STYLE: Record<Status, string> = {
  COMPLETED: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  "ON TRACK": "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  "AT RISK": "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  "BEHIND SCHEDULE": "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  "NOT STARTED": "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
};
