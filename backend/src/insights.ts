/**
 * What the board has learned from the production logged so far, and what it
 * would say about it.
 *
 * Nothing here is a trained model. Every number is worked out from the
 * entries themselves - each line's real output per day, how a new order
 * builds up over its first days, how much a day swings either side of the
 * average - so any answer can be traced back to the days that produced it,
 * and it sharpens by itself as more days are logged. That is deliberate: a
 * factory this size has tens of worked days, not the tens of thousands a
 * fitted model would need to say anything honest.
 *
 * Everything is a pure function of the orders, the entries and the plans, so
 * `npm test` can check the advice the same way it checks the planning.
 */

import { addDays, type ISODate } from './dates';
import { fmtDay, fmtNum, pct, plural } from './format';
import {
  dailyTotals, finishAtPace, holdsLine, isScheduled, LINES, makeCapacity, MILESTONE_LABEL, milestonesMissing, planOrder,
  scheduleMissing, type Entry, type IdleDay, type MilestoneKey, type Order, type OrderPlan, type Settings,
} from './planning';

/** "Lately" is the last this many days anything was made. */
export const RECENT_WORKED_DAYS = 7;
/** A trend only counts once there are this many worked days to compare. */
export const TREND_MIN_DAYS = 4;
/** Lately has to beat (or trail) the days before it by this much to be called a trend. */
export const TREND_BAND = 0.1;
/** A target above the line's own average by this much is called optimistic. */
export const OPTIMISTIC_BAND = 0.15;
/** How many days of a new order's build-up the ramp-up curve describes. */
export const RAMP_DAYS = 6;
/** Moving an order to a free line is only worth saying if it starts this many days earlier. */
export const WORTH_MOVING_DAYS = 3;

export interface DayQty { date: ISODate; qty: number }

// ---------------------------------------------------------------------------
// What a set of worked days says about itself

export interface Performance {
  daysWorked: number;
  produced: number;
  avgPerDay: number | null;
  bestDay: DayQty | null;
  worstDay: DayQty | null;
  recentAvg: number | null;        // the last RECENT_WORKED_DAYS worked days
  earlierAvg: number | null;       // everything before them
  trend: 'rising' | 'steady' | 'falling' | null;
  swing: number | null;            // how far a day typically sits from the average, as a share of it
  firstWorked: ISODate | null;
  lastWorked: ISODate | null;
}

const EMPTY: Performance = {
  daysWorked: 0, produced: 0, avgPerDay: null, bestDay: null, worstDay: null,
  recentAvg: null, earlierAvg: null, trend: null, swing: null, firstWorked: null, lastWorked: null,
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/** Everything a run of worked days can be asked about, from one day upwards. */
export function performance(days: DayQty[]): Performance {
  if (!days.length) return { ...EMPTY };
  const qtys = days.map((d) => d.qty);
  const avg = mean(qtys)!;
  const sorted = [...days].sort((a, b) => a.qty - b.qty);
  const recent = days.slice(-RECENT_WORKED_DAYS);
  const earlier = days.slice(0, Math.max(0, days.length - RECENT_WORKED_DAYS));
  const recentAvg = mean(recent.map((d) => d.qty));
  const earlierAvg = earlier.length ? mean(earlier.map((d) => d.qty)) : null;

  // A trend needs enough days to compare, and a gap wide enough to mean something.
  let trend: Performance['trend'] = null;
  if (days.length >= TREND_MIN_DAYS) {
    const half = Math.floor(days.length / 2);
    const late = mean(qtys.slice(-half))!;
    const early = mean(qtys.slice(0, half))!;
    trend = late > early * (1 + TREND_BAND) ? 'rising' : late < early * (1 - TREND_BAND) ? 'falling' : 'steady';
  }
  const variance = mean(qtys.map((q) => (q - avg) ** 2))!;
  return {
    daysWorked: days.length,
    produced: qtys.reduce((s, q) => s + q, 0),
    avgPerDay: avg,
    bestDay: sorted[sorted.length - 1],
    worstDay: sorted[0],
    recentAvg, earlierAvg, trend,
    swing: avg > 0 ? Math.sqrt(variance) / avg : null,
    firstWorked: days[0].date,
    lastWorked: days[days.length - 1].date,
  };
}

// ---------------------------------------------------------------------------
// Per line and per style

export interface LineStats extends Performance {
  lineNo: number;
  orders: number;          // orders that have ever run on it
  running: number;         // orders on it now, started and unfinished
  booked: number;          // orders on it not started yet
}

/** Each line's own record: what it has actually made, day by day. */
export function lineStats(orders: Order[], entries: Entry[], plans?: Map<number, OrderPlan>): LineStats[] {
  const lineOf = new Map(orders.map((o) => [o.id, o.lineNo]));
  return LINES.map((lineNo) => {
    const mine = entries.filter((e) => lineOf.get(e.orderId) === lineNo);
    const here = orders.filter((o) => holdsLine(o, lineNo));
    const ran = new Set(mine.map((e) => e.orderId));
    const state = (o: Order) => plans?.get(o.id);
    return {
      lineNo,
      ...performance(dailyTotals(mine)),
      orders: ran.size,
      running: here.filter((o) => { const p = state(o); return p ? p.produced > 0 && p.status !== 'COMPLETED' : false; }).length,
      booked: here.filter((o) => { const p = state(o); return p ? p.produced === 0 : false; }).length,
    };
  });
}

export interface StyleStats extends Performance { styleNo: string; orders: number }

/** The same for a style, which is what repeats: the next order of it starts where the last one left off. */
export function styleStats(orders: Order[], entries: Entry[]): StyleStats[] {
  const byStyle = new Map<string, { ids: Set<number>; entries: Entry[] }>();
  for (const o of orders) {
    const key = o.styleNo.trim();
    if (!key) continue;
    if (!byStyle.has(key)) byStyle.set(key, { ids: new Set(), entries: [] });
    byStyle.get(key)!.ids.add(o.id);
  }
  for (const e of entries) {
    for (const [, v] of byStyle) if (v.ids.has(e.orderId)) v.entries.push(e);
  }
  return [...byStyle.entries()]
    .map(([styleNo, v]) => ({ styleNo, orders: v.ids.size, ...performance(dailyTotals(v.entries)) }))
    .filter((s) => s.daysWorked > 0)
    .sort((a, b) => b.produced - a.produced);
}

// ---------------------------------------------------------------------------
// The build-up curve: what a new order makes on its first days

export interface RampUpDay {
  day: number;             // 1 = the first day anything was made on the order
  share: number;           // what that day made, as a share of that order's best day
  sample: number;          // how many orders that average is drawn from
}

/**
 * Learned across every order that has ever run: a first day usually makes
 * some share of what the order later reaches, the second day more, and so on.
 * Used to say whether a new order's first days are normal or slow.
 */
export function rampUp(orders: Order[], entries: Entry[], maxDays = RAMP_DAYS): RampUpDay[] {
  const shares: number[][] = Array.from({ length: maxDays }, () => []);
  for (const o of orders) {
    const days = dailyTotals(entries.filter((e) => e.orderId === o.id));
    if (days.length < 2) continue;                       // one day says nothing about a build-up
    const best = Math.max(...days.map((d) => d.qty));
    if (best <= 0) continue;
    days.slice(0, maxDays).forEach((d, i) => shares[i].push(d.qty / best));
  }
  return shares
    .map((xs, i) => ({ day: i + 1, share: mean(xs) ?? 0, sample: xs.length }))
    .filter((d) => d.sample > 0);
}

// ---------------------------------------------------------------------------
// Three ways an order that is running could finish

export interface Forecast {
  optimistic: { date: ISODate; pace: number } | null;  // if every day matched its best day
  likely: { date: ISODate; pace: number } | null;      // at the average it is actually running
  cautious: { date: ISODate; pace: number } | null;    // if it slipped to its slowest day
  requiredDate: ISODate;
}

/**
 * The plan's own answer is the likely one; the other two are the same sum at
 * the order's best and worst day so far, which is the honest width of what
 * can be said from a handful of days.
 */
export function forecast(
  order: Order, orderEntries: Entry[], plan: OrderPlan, s: Settings, idle: IdleDay[], asOf: ISODate,
): Forecast | null {
  if (plan.status === 'COMPLETED' || plan.produced === 0 || !plan.planFrom) return null;
  const perf = performance(dailyTotals(orderEntries.filter((e) => e.entryDate <= asOf)));
  if (!perf.daysWorked) return null;
  const cap = makeCapacity(s.workDaysPerWeek, idle, order.lineNo);
  const at = (pace: number | null | undefined) =>
    (pace && pace > 0 ? { date: finishAtPace(plan.planFrom!, plan.balance, pace, cap).date, pace } : null);
  return {
    optimistic: at(perf.bestDay?.qty),
    likely: at(plan.pacePerDay),
    cautious: at(perf.worstDay?.qty),
    requiredDate: order.requiredDate,
  };
}

// ---------------------------------------------------------------------------
// Suggestions: what the board would raise, and why

export type SuggestionKind =
  | 'production-blocked' | 'milestone-late' | 'milestone-due' | 'will-miss-date' | 'pace-falling'
  | 'target-optimistic' | 'not-started' | 'not-scheduled' | 'line-idle' | 'overlap' | 'packing-due'
  | 'idle-capacity' | 'capacity-short';

export interface Suggestion {
  id: string;                  // stable between refreshes, so a dismissed one stays dismissed
  kind: SuggestionKind;
  severity: 'urgent' | 'soon' | 'watch';
  title: string;
  detail: string;              // the numbers it is drawn from
  advice: string;              // what to do about it - the agent never does it itself
  orderId?: number;
  orderNo?: string;
  lineNo?: number;
  page: string;                // where in the app to act on it
}

export interface Board {
  orders: Order[];
  entries: Entry[];
  plans: Map<number, OrderPlan>;
  idle: IdleDay[];
  settings: Settings;
  asOf: ISODate;
  today: ISODate;
}

const RANK: Record<Suggestion['severity'], number> = { urgent: 0, soon: 1, watch: 2 };

const entriesOf = (b: Board, orderId: number) => b.entries.filter((e) => e.orderId === orderId);
const daysUntil = (from: ISODate, to: ISODate) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

/** In N days / today / N days ago, as a sentence would say it. */
export function whenPhrase(from: ISODate, to: ISODate): string {
  const n = daysUntil(from, to);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${plural(n, 'day')}` : `${plural(-n, 'day')} ago`;
}

/**
 * Everything worth raising, worst first. Each one carries the figures behind
 * it so it can be argued with - the agent advises, it never changes anything.
 */
export function suggestions(b: Board): Suggestion[] {
  const out: Suggestion[] = [];
  const lines = lineStats(b.orders, b.entries, b.plans);
  const statsOf = (lineNo: number | null) => (lineNo ? lines[lineNo - 1] : null);

  for (const o of b.orders) {
    const p = b.plans.get(o.id)!;
    const where = `${o.orderNo}${o.styleNo ? ` (${o.styleNo})` : ''}`;
    const line = statsOf(o.lineNo);

    // No line or no scheduling date yet: it books nothing, and nothing can be entered for it.
    const unset = scheduleMissing(o);
    if (unset.length && p.status !== 'COMPLETED' && p.produced === 0) {
      out.push({
        id: `not-scheduled:${o.id}`, kind: 'not-scheduled', severity: p.overdue ? 'urgent' : 'soon',
        title: `${where} is not scheduled yet`,
        detail: `No ${unset.join(' and no ')}, so it books no line, has no pre-production dates, and nothing can be `
          + `ticked or logged for it. ${fmtNum(o.orderQty)} ${o.unit} due ${fmtDay(o.requiredDate)}`
          + `${p.targetPerDay ? ` - started today it would need ${fmtNum(p.targetPerDay)} a day` : ''}.`,
        advice: `Fill in its ${unset.join(' and ')} in Orders (the form suggests the best line), `
          + 'or drag it onto the Line calendar from "Not scheduled".',
        orderId: o.id, orderNo: o.orderNo, lineNo: o.lineNo ?? undefined, page: '/lines',
      });
    }

    // Pre-production: production cannot be logged until all three are ticked.
    const missing = milestonesMissing(o);
    if (missing.length && p.status !== 'COMPLETED') {
      const start = p.startDate;
      const due = missing
        .map((k) => ({ k, date: p.preProduction[k].expected }))
        .filter((m): m is { k: MilestoneKey; date: ISODate } => m.date !== null)
        .sort((x, y) => x.date.localeCompare(y.date));
      const late = due.filter((m) => m.date < b.today);
      const soon = due.filter((m) => m.date >= b.today && daysUntil(b.today, m.date) <= 7);
      const names = (xs: typeof due) => xs.map((m) => MILESTONE_LABEL[m.k]).join(', ');
      // Each with its own date: fabric is due weeks before cutting and accessories, and
      // quoting the earliest for all of them was wrong (and the AI repeated it).
      const dueDates = (xs: typeof due, verb: 'was' | 'is') => {
        const byDate = new Map<ISODate, MilestoneKey[]>();
        for (const m of xs) byDate.set(m.date, [...(byDate.get(m.date) ?? []), m.k]);
        return [...byDate.entries()].map(([d, ks]) =>
          `${ks.map((k) => MILESTONE_LABEL[k]).join(' and ')} ${ks.length === 1 ? verb : verb === 'was' ? 'were' : 'are'} due ${fmtDay(d)}`).join('; ');
      };
      if (late.length) {
        out.push({
          id: `milestone-late:${o.id}`, kind: 'milestone-late', severity: 'urgent',
          title: `${where}: ${names(late)} ${late.length === 1 ? 'is' : 'are'} past due`,
          detail: `${dueDates(late, 'was')}${start ? ` - for a start on ${fmtDay(start)}` : ''}.`,
          advice: 'Chase it and tick it in Pre-production. Production cannot be logged for this order until all three are ticked.',
          orderId: o.id, orderNo: o.orderNo, lineNo: o.lineNo ?? undefined, page: '/pre-production',
        });
      } else if (soon.length) {
        out.push({
          id: `milestone-due:${o.id}`, kind: 'milestone-due', severity: 'soon',
          title: `${where}: ${names(soon)} due ${whenPhrase(b.today, soon[0].date)}`,
          detail: `${dueDates(soon, 'is')}${start ? `, so the order can start ${fmtDay(start)}` : ''}.`,
          advice: 'Tick it in Pre-production as it arrives.',
          orderId: o.id, orderNo: o.orderNo, lineNo: o.lineNo ?? undefined, page: '/pre-production',
        });
      }
      // The start day is here and it is still not ticked: the line will stand idle.
      if (start && start <= addDays(b.today, 1) && p.produced === 0) {
        out.push({
          id: `production-blocked:${o.id}`, kind: 'production-blocked', severity: 'urgent',
          title: `${where} cannot start: ${missing.map((k) => MILESTONE_LABEL[k]).join(', ')} not ticked`,
          detail: `It should start ${fmtDay(start)} (${whenPhrase(b.today, start)}) on `
            + `${o.lineNo ? `Line ${o.lineNo}` : 'no line'}, but production is locked until all three ticks are in.`,
          advice: 'Tick what has arrived in Pre-production, or move the order back on the Line calendar.',
          orderId: o.id, orderNo: o.orderNo, lineNo: o.lineNo ?? undefined, page: '/pre-production',
        });
      }
    }

    // Started, and the pace it is running at does not reach the date.
    if (p.produced > 0 && p.status !== 'COMPLETED' && p.projectedFinish && p.projectedFinish > o.requiredDate) {
      const over = daysUntil(o.requiredDate, p.projectedFinish);
      out.push({
        id: `will-miss-date:${o.id}`, kind: 'will-miss-date', severity: 'urgent',
        title: `${where} will miss ${fmtDay(o.requiredDate)} by ${plural(over, 'day')}`,
        detail: `${fmtNum(p.balance)} left at ${fmtNum(p.pacePerDay)} a day (${plural(p.daysWorked, 'day')} worked) `
          + `finishes ${fmtDay(p.projectedFinish)}. To make the date it needs ${fmtNum(p.targetPerDay)} a day`
          + `${p.workingDaysLeft ? ` over the ${plural(p.workingDaysLeft, 'working day')} left` : ''}.`,
        advice: `Lift the line to ${fmtNum(p.targetPerDay)} a day, add a shift, or move the required date.`,
        orderId: o.id, orderNo: o.orderNo, lineNo: o.lineNo ?? undefined, page: '/orders',
      });
    }

    // Running, and lately slower than it was.
    if (p.produced > 0 && p.status !== 'COMPLETED') {
      const perf = performance(dailyTotals(entriesOf(b, o.id).filter((e) => e.entryDate <= b.asOf)));
      if (perf.trend === 'falling' && perf.recentAvg && perf.earlierAvg) {
        out.push({
          id: `pace-falling:${o.id}`, kind: 'pace-falling', severity: 'watch',
          title: `${where} is slowing`,
          detail: `Lately ${fmtNum(perf.recentAvg)} a day against ${fmtNum(perf.earlierAvg)} earlier`
            + ` (best day ${fmtNum(perf.bestDay?.qty)} on ${fmtDay(perf.bestDay!.date)}).`,
          advice: 'Worth asking the line what changed - the booking on the Line calendar grows as the pace drops.',
          orderId: o.id, orderNo: o.orderNo, lineNo: o.lineNo ?? undefined, page: '/lines',
        });
      }
    }

    // What it is asked to do, against what its line has ever done (a target read from today means nothing unscheduled).
    if (p.status !== 'COMPLETED' && p.scheduled && p.targetPerDay && line && line.avgPerDay && line.daysWorked >= 3) {
      if (p.targetPerDay > line.avgPerDay * (1 + OPTIMISTIC_BAND)) {
        const over = p.targetPerDay / line.avgPerDay - 1;
        out.push({
          id: `target-optimistic:${o.id}`, kind: 'target-optimistic', severity: p.produced > 0 ? 'watch' : 'soon',
          title: `${where} needs ${pct(over)} more than Line ${o.lineNo} has averaged`,
          detail: `It needs ${fmtNum(p.targetPerDay)} a day. Line ${o.lineNo} has averaged ${fmtNum(line.avgPerDay)} a day `
            + `over ${plural(line.daysWorked, 'worked day')}, its best day ${fmtNum(line.bestDay?.qty)}.`,
          advice: 'Give it longer, split it across two lines, or plan on the line making more than it ever has.',
          orderId: o.id, orderNo: o.orderNo, lineNo: o.lineNo ?? undefined, page: '/lines',
        });
      }
    }

    // Its start day has gone by with nothing logged.
    if (p.produced === 0 && p.startDate && p.startDate < b.today && !missing.length) {
      out.push({
        id: `not-started:${o.id}`, kind: 'not-started', severity: p.overdue ? 'urgent' : 'soon',
        title: `${where} should have started ${fmtDay(p.startDate)}`,
        detail: `${plural(daysUntil(p.startDate, b.today), 'day')} late to start`
          + `${p.overdue ? ', and there is no working day left before its required date' : ''}. `
          + `${fmtNum(o.orderQty)} ${o.unit} due ${fmtDay(o.requiredDate)}.`,
        advice: p.overdue
          ? 'It cannot make its date as planned: change the required date in Orders, or split the order.'
          : 'Log what has been made, or move it on the Line calendar to the day it will really start.',
        orderId: o.id, orderNo: o.orderNo, lineNo: o.lineNo ?? undefined, page: '/lines',
      });
    }

    // Two orders logged on one line on the same days.
    if (p.overlaps.length) {
      out.push({
        id: `overlap:${o.id}`, kind: 'overlap', severity: 'soon',
        title: `Line ${o.lineNo} is running ${o.orderNo} and ${p.overlaps.join(', ')} at once`,
        detail: `Both have production logged on the same days, so neither booking is the whole line.`,
        advice: 'If that is right, nothing to do - the pace of each is read from its own entries. If not, one of them belongs on another line.',
        orderId: o.id, orderNo: o.orderNo, lineNo: o.lineNo ?? undefined, page: '/lines',
      });
    }

    // Finished, waiting to be packed.
    const packing = p.postProduction.packing;
    if (p.status === 'COMPLETED' && !o.packedAt && packing.expected) {
      const late = packing.expected < b.today;
      if (late || daysUntil(b.today, packing.expected) <= 2) {
        out.push({
          id: `packing-due:${o.id}`, kind: 'packing-due', severity: late ? 'urgent' : 'soon',
          title: `${where} is ${late ? 'past its packing date' : `due to be packed ${whenPhrase(b.today, packing.expected)}`}`,
          detail: `Finished ${fmtDay(p.lastProduction!)}, packing due ${fmtDay(packing.expected)}`
            + `${late ? ` - ${whenPhrase(b.today, packing.expected)}` : ''}.`,
          advice: 'Tick packing in Post-production once it is done.',
          orderId: o.id, orderNo: o.orderNo, lineNo: o.lineNo ?? undefined, page: '/post-production',
        });
      }
    }
  }

  // A line standing free while an order elsewhere waits its turn.
  out.push(...idleLineSuggestions(b, lines));
  // Capacity: lines with nothing on them at all, and what every open order asks of the factory.
  out.push(...capacitySuggestions(b, lines));

  return out.sort((x, y) => RANK[x.severity] - RANK[y.severity] || x.kind.localeCompare(y.kind) || x.id.localeCompare(y.id));
}

/**
 * The two things only the whole board can see: lines holding nothing at all,
 * and open orders asking for more a day than the factory has ever made.
 */
function capacitySuggestions(b: Board, lines: LineStats[]): Suggestion[] {
  const out: Suggestion[] = [];
  const booked = bookingsByLine(b);
  const empty = LINES.filter((n) => !(booked.get(n) ?? []).length);
  if (empty.length) {
    const known = empty.map((n) => lines[n - 1]).filter((s) => s.avgPerDay);
    const spare = known.reduce((s, x) => s + (x.avgPerDay ?? 0), 0);
    out.push({
      id: `idle-capacity:${empty.join('-')}`, kind: 'idle-capacity', severity: 'watch',
      title: `${plural(empty.length, 'line')} ${empty.length === 1 ? 'has' : 'have'} nothing booked`,
      detail: `${empty.map((n) => `Line ${n}`).join(', ')} hold no order now or ahead. `
        + (known.length
          ? `${known.length === empty.length ? 'They have' : `${plural(known.length, 'of them has', 'of them have')}`} `
            + `averaged ${fmtNum(spare)} a day between them when running.`
          : 'None of them has ever had production logged, so there is no record of what they can make.'),
      advice: 'Spare capacity: a new order can go straight on, or work queued on a busy line can be moved across on the Line calendar.',
      page: '/lines',
    });
  }

  const open = b.orders.filter((o) => {
    const p = b.plans.get(o.id)!;
    return p.status !== 'COMPLETED' && p.targetPerDay;
  });
  const needed = open.reduce((s, o) => s + (b.plans.get(o.id)!.targetPerDay ?? 0), 0);
  const factory = performance(dailyTotals(b.entries.filter((e) => e.entryDate <= b.asOf)));
  if (needed && factory.avgPerDay && factory.daysWorked >= 3 && needed > factory.avgPerDay * (1 + OPTIMISTIC_BAND)) {
    out.push({
      id: 'capacity-short', kind: 'capacity-short', severity: 'soon',
      title: `The open orders need ${pct(needed / factory.avgPerDay - 1)} more a day than the factory has averaged`,
      detail: `${plural(open.length, 'open order')} need ${fmtNum(needed)} a day between them to make their dates. `
        + `The factory has averaged ${fmtNum(factory.avgPerDay)} a day over ${plural(factory.daysWorked, 'worked day')}, `
        + `its best day ${fmtNum(factory.bestDay?.qty)}.`,
      advice: 'Something has to give: more lines on the work, overtime, or later delivery dates on the orders that can take them.',
      page: '/',
    });
  }
  return out;
}

/** Bookings held on each line, so a free one can be told from a busy one. */
function bookingsByLine(b: Board) {
  const m = new Map<number, { start: ISODate; end: ISODate }[]>();
  for (const o of b.orders) {
    if (o.lineNo === null || !holdsLine(o, o.lineNo)) continue;
    const p = b.plans.get(o.id)!;
    if (p.status === 'COMPLETED') continue;
    if (!m.has(o.lineNo)) m.set(o.lineNo, []);
    m.get(o.lineNo)!.push({ start: p.bookStart, end: p.bookEnd });
  }
  return m;
}

/**
 * An order queued behind another one, while a line sits free: what moving it
 * would buy, in days. It only says so - the move is the user's to make, on
 * the Line calendar.
 */
function idleLineSuggestions(b: Board, lines: LineStats[]): Suggestion[] {
  const booked = bookingsByLine(b);
  const free = LINES.filter((n) => !(booked.get(n) ?? []).some((x) => x.end >= b.today));
  if (!free.length) return [];
  const out: Suggestion[] = [];

  for (const o of b.orders) {
    const p = b.plans.get(o.id)!;
    if (p.produced > 0 || p.status === 'COMPLETED' || !isScheduled(o)) continue;
    for (const lineNo of free) {
      if (lineNo === o.lineNo) continue;
      // The same order on the free line, planned from today.
      const alt = planOrder({ ...o, lineNo, planningDate: b.today }, [], b.settings, b.asOf, b.idle);
      const clash = (booked.get(lineNo) ?? []).some((x) => x.start <= alt.bookEnd && alt.bookStart <= x.end);
      const gain = daysUntil(alt.bookStart, p.bookStart);
      if (clash || gain < WORTH_MOVING_DAYS) continue;
      const stats = lines[lineNo - 1];
      out.push({
        id: `line-idle:${o.id}:${lineNo}`, kind: 'line-idle', severity: 'watch',
        title: `${o.orderNo} could start ${plural(gain, 'day')} earlier on Line ${lineNo}`,
        detail: `It is booked to start ${fmtDay(p.bookStart)} on Line ${o.lineNo}`
          + `${p.waitingFor ? `, waiting for ${p.waitingFor}` : ''}. Line ${lineNo} is free now`
          + `${stats.daysWorked ? ` and has averaged ${fmtNum(stats.avgPerDay)} a day over ${plural(stats.daysWorked, 'worked day')}` : ' and has no record yet'}`
          + `, so the same order could start ${fmtDay(alt.bookStart)}.`,
        advice: `Drag it to Line ${lineNo} on the Line calendar if that line can take the style.`,
        orderId: o.id, orderNo: o.orderNo, lineNo, page: '/lines',
      });
      break; // one line is enough to make the point
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

export interface Learned {
  lines: LineStats[];
  styles: StyleStats[];
  factory: Performance;
  rampUp: RampUpDay[];
  /** What the numbers rest on, so the page can say how much to trust them. */
  basis: { workedDays: number; entries: number; orders: number; ordersRun: number; since: ISODate | null };
}

/** Everything the board has learned, as the Assistant page shows it. */
export function learned(b: Board): Learned {
  const entries = b.entries.filter((e) => e.entryDate <= b.asOf);
  const factory = performance(dailyTotals(entries));
  const ran = new Set(entries.map((e) => e.orderId));
  return {
    lines: lineStats(b.orders, entries, b.plans),
    styles: styleStats(b.orders, entries),
    factory,
    rampUp: rampUp(b.orders, entries),
    basis: {
      workedDays: factory.daysWorked, entries: entries.length,
      orders: b.orders.length, ordersRun: ran.size, since: factory.firstWorked,
    },
  };
}
