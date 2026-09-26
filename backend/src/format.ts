// How every message, answer and suggestion writes a date, a number and a count.
// toLocaleString is deliberately avoided for dates: it writes "Sept" on this
// machine, and the app writes "Sep" everywhere else.

import type { ISODate } from './dates';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 21 Sep 2026 */
export const fmtDay = (d: ISODate) => `${d.slice(8, 10)} ${MONTHS[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;
/** 21 Sep - for a date in a sentence that already says the year. */
export const fmtShort = (d: ISODate) => `${d.slice(8, 10)} ${MONTHS[+d.slice(5, 7) - 1]}`;

/** 1,200. Anything with no number to show is a dash. */
export const fmtNum = (n: number | null | undefined) =>
  (n == null || !Number.isFinite(n) ? '-' : Math.round(n).toLocaleString('en-GB'));

/** "1 day" / "3 days" - the count and its word, so sentences read properly. */
export const plural = (n: number, one: string, many = `${one}s`) => `${fmtNum(n)} ${Math.round(n) === 1 ? one : many}`;
export const days = (n: number) => plural(n, 'day');
export const pieces = (n: number) => `${fmtNum(n)} pcs`;

/** 62% */
export const pct = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? '-' : `${Math.round(x * 100)}%`);
