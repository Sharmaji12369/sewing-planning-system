// Every number the workbook calculated, as plain functions over stored rows.
// Nothing here touches the database, so all of it is covered by
// test/planning.test.ts.
//
// The rules (agreed 21 Sep 2026):
//   * PACE / DAY is the average of DAILY totals - Day, Night and Overtime
//     added together first - over EVERY day the order has been worked (the
//     base), or over its last N worked days when a viewer picks that. It
//     exists only while the order is running: started and not finished. A day
//     with no entry is missing information, not a zero. (The workbook averaged
//     individual log entries, so a Day + Night day counted twice and halved
//     the pace.)
//   * The WORKING WEEK is 6 days, Monday to Saturday, unless a viewer picks 5
//     or 7. Holidays, power cuts and half days are marked as idle days.
//   * TARGET / DAY is no longer typed in. It is what the order NEEDS per
//     working day to finish by its required delivery date:
//         balance / working days left, rounded up to a whole piece.
//     Once no working day is left before that date, all of the balance is
//     needed now, so the target is the whole balance - never blank.
//   * IDLE DAYS take working time away: a full idle day counts 0, a half day
//     0.5, for every factory or for one Factory / Line. Every date below is
//     worked out on this capacity, so an idle day moves targets and finish
//     dates. Pace divides output by the capacity of the days it came from, so
//     a half day's output is not mistaken for a slow full day.
//   * START DATE is worked back from the REQUIRED DELIVERY date: the order qty
//     at the current target per day takes that many working days, ending on
//     the required date; one more working day before that is kept as a buffer.
//   * PRE-PRODUCTION milestones are expected before the start date: fabric 25
//     calendar days before, cutting and accessories 7 days before (10 / 3 / 3
//     until 22 Sep 2026). Each is ticked when done, and reads as days early or
//     late against that. POST-PRODUCTION: packing is due 4 days after the
//     order is complete.
//
// Lines (agreed 22 Sep 2026):
//   * Every order runs on one of LINES 1-10, and a line runs ONE order at a
//     time. An order BOOKS its line for the time it needs:
//       - not started: its start date (the buffer day included) to its
//         required date - at the target it finishes on that date;
//       - running: first production day to expected completion at its pace,
//         so a slower pace books the line longer and a faster one shorter;
//       - finished: first to last production day.
//   * If work on a line runs over, the orders queued behind it wait: an order
//     not yet started is moved to begin after it, and its target, start date
//     and pre-production dates move with it (`waitingFor` names the order).
//   * A new order - or a changed one - may not be put where its booking
//     clashes with another order on that line; `lineCheck` says when each
//     line is free instead.
//
// Not scheduled (agreed 25 Sep 2026):
//   * An order can be saved without its line or its expected scheduling date,
//     when nobody knows them yet. Until BOTH are filled in it is NOT
//     SCHEDULED: it books no line, it has no start date or pre-production due
//     dates, and nothing can be entered against it - no pre-production tick,
//     no production, no packing (the API refuses; `scheduleMissing` says what
//     is still to fill in). Its target is read as if it could start today.

import { ISODate, WorkWeek, addDays, daysBetween, isWorkingDay, localISODate, maxDate, minDate } from './dates';

/**
 * The planning controls. Each viewer can change these for their own screen;
 * left alone, every one of them is the base rule.
 */
export interface Settings {
  workDaysPerWeek: WorkWeek;       // base 6 (Mon-Sat)
  paceDays?: number | null;        // null = every worked day (base); N = the last N worked days
  calendarStart?: ISODate | null;  // null = the first day anything was produced (base)
  paceMode?: PaceMode;             // 'rolling' (base) everywhere; the Line calendar can show 'peak' as well
}

/**
 * How a running order's pace is read:
 *   rolling - the average of its worked days (the base, used on every page);
 *   peak    - its target for its first PEAK_WARMUP_DAYS days of production, then
 *             the highest day it has made so far, rising whenever a day beats it.
 */
export type PaceMode = 'rolling' | 'peak';
export const PEAK_WARMUP_DAYS = 4;

export const BASE_SETTINGS: Settings = { workDaysPerWeek: 6, paceDays: null, calendarStart: null, paceMode: 'rolling' };

export const LINE_COUNT = 10;
/** Line 1 ... Line 10. */
export const LINES: number[] = Array.from({ length: LINE_COUNT }, (_, i) => i + 1);

export interface Order {
  id: number;
  orderNo: string;
  lineNo: number | null;                 // 1-10; null = not decided yet (see "Not scheduled" at the top)
  styleNo: string;
  colour: string;
  orderQty: number;
  unit: string;
  planningDate: ISODate | null;          // the Expected Scheduling Date; null = not known yet
  requiredDate: ISODate;
  notes: string;
  fabricReceivedAt: string | null;       // ISO timestamps, stamped by the tick buttons
  cuttingDoneAt: string | null;
  accessoriesReceivedAt: string | null;
  packedAt: string | null;               // post-production: ticked once the order is complete
}

export type Shift = 'Day' | 'Night' | 'Overtime';

export interface Entry {
  id: number;
  entryNo: string;
  orderId: number;
  entryDate: ISODate;
  qty: number;
  shift: Shift;
  remarks: string;
}

export interface IdleDay {
  id: number;
  idleDate: ISODate;
  lineNo: number | null;      // null = every line
  portion: 0.5 | 1;           // half day or full day
  reason: string;
}

/** The two fields an order needs before anything can be entered against it, as the order form names them. */
export const SCHEDULE_FIELDS = { lineNo: 'Line', planningDate: 'Expected Scheduling Date' } as const;
export type ScheduleField = (typeof SCHEDULE_FIELDS)[keyof typeof SCHEDULE_FIELDS];

/** What is still to fill in before the order is scheduled - empty once it is. */
export function scheduleMissing(o: Pick<Order, 'lineNo' | 'planningDate'>): ScheduleField[] {
  const out: ScheduleField[] = [];
  if (o.lineNo === null) out.push(SCHEDULE_FIELDS.lineNo);
  if (o.planningDate === null) out.push(SCHEDULE_FIELDS.planningDate);
  return out;
}

export const isScheduled = (o: Pick<Order, 'lineNo' | 'planningDate'>) => o.lineNo !== null && o.planningDate !== null;

/** Whether an order holds days on `line`: it is on it and has a scheduling date to book them from. */
export const holdsLine = (o: Order, line: number) => o.lineNo === line && o.planningDate !== null;

export const STATUSES = ['COMPLETED', 'ON TRACK', 'AT RISK', 'BEHIND SCHEDULE', 'NOT STARTED'] as const;
export type Status = (typeof STATUSES)[number];

/** Finishing this many working days early or fewer counts as AT RISK. */
export const AT_RISK_BUFFER = 1;

// ---------------------------------------------------------------------------
// Capacity: how much of a working day a date gives one line.

/** 1 = a full working day, 0.5 = half idle, 0 = off (weekend) or fully idle. */
export type Capacity = (d: ISODate) => number;

// Longest span any walk below takes. Ten years is far past any order.
const MAX_SPAN_DAYS = 3660;

/** The idle portion (0, 0.5 or 1) per date - for one line, or for all lines when lineNo is null. */
export function idleLookup(idle: IdleDay[], lineNo: number | null): (d: ISODate) => number {
  const m = new Map<ISODate, number>();
  for (const x of idle) {
    if (x.lineNo !== null && x.lineNo !== lineNo) continue;
    // Marked twice (all lines and this one)? The larger portion wins.
    m.set(x.idleDate, Math.max(m.get(x.idleDate) ?? 0, x.portion));
  }
  return (d) => m.get(d) ?? 0;
}

export function makeCapacity(ww: WorkWeek, idle: IdleDay[], lineNo: number | null): Capacity {
  const idleOn = idleLookup(idle, lineNo);
  return (d) => (isWorkingDay(d, ww) ? Math.max(0, 1 - idleOn(d)) : 0);
}

/** The first date on or after d with any working time. */
export function firstAvailable(d: ISODate, cap: Capacity): ISODate {
  let x = d;
  for (let i = 0; i < MAX_SPAN_DAYS && cap(x) <= 0; i++) x = addDays(x, 1);
  return x;
}

/** Working days in [from, to], both included - half days count 0.5. */
export function capacityBetween(from: ISODate, to: ISODate, cap: Capacity): number {
  let n = 0;
  for (let d = from, i = 0; d <= to && i < MAX_SPAN_DAYS; d = addDays(d, 1), i++) n += cap(d);
  return n;
}

/** Signed working days from a to b: the capacity after a up to and including b. + when b is later. */
export function capacityDiff(a: ISODate, b: ISODate, cap: Capacity): number {
  if (a === b) return 0;
  return b > a ? capacityBetween(addDays(a, 1), b, cap) : -capacityBetween(addDays(b, 1), a, cap);
}

/**
 * The first day of a run of `days` working days that ends on `end` (half idle
 * days count half). If `end` itself is not a working day, the run ends on the
 * last working day before it.
 */
export function spanStart(end: ISODate, days: number, cap: Capacity): ISODate {
  let acc = 0, d = end, last = end;
  for (let i = 0; i < MAX_SPAN_DAYS; i++, d = addDays(d, -1)) {
    const c = cap(d);
    if (c <= 0) continue;
    last = d;
    acc += c;
    if (acc >= days - 1e-9) return d;
  }
  return last;
}

/** The last working day strictly before d. */
export function prevAvailable(d: ISODate, cap: Capacity): ISODate {
  let x = addDays(d, -1);
  for (let i = 0; i < MAX_SPAN_DAYS && cap(x) <= 0; i++) x = addDays(x, -1);
  return x;
}

/** The last working day on or before d. */
export function lastAvailable(d: ISODate, cap: Capacity): ISODate {
  return cap(d) > 0 ? d : prevAvailable(d, cap);
}

/** The day `qty` is finished making `pace` per full working day from `start`, and the working days it takes. */
export function finishAtPace(start: ISODate, qty: number, pace: number, cap: Capacity) {
  let left = qty, used = 0, d = start;
  for (let i = 0; i < MAX_SPAN_DAYS; i++, d = addDays(d, 1)) {
    const c = cap(d);
    if (c <= 0) continue;
    left -= pace * c;
    used += c;
    // A hair of tolerance so 3 x 1/3 of a day still counts as done.
    if (left <= 1e-9) return { date: d, days: used };
  }
  return { date: d, days: used };
}

// ---------------------------------------------------------------------------

export interface OrderPlan {
  produced: number;
  balance: number;
  overBy: number;
  pctComplete: number;              // 0..1, capped at 1
  entryCount: number;
  daysWorked: number;
  firstProduction: ISODate | null;
  lastProduction: ISODate | null;
  pacePerDay: number | null;        // only while running
  paceDaysUsed: number;             // how many worked days the pace averages (all, or at most the last N)
  paceBasis: 'average' | 'target' | 'peak' | null; // what the pace is: see PaceMode
  planFrom: ISODate | null;         // first working day still available to the order
  workingDaysLeft: number | null;   // planFrom .. required date, inclusive; half idle days count 0.5
  targetPerDay: number | null;      // needed per working day to finish on time; the whole balance once overdue
  daysNeeded: number | null;        // working days at the current pace
  projectedFinish: ISODate | null;  // expected completion at the current pace; completed orders: the day they finished
  bufferDays: number | null;        // working days, + early / - late
  overdue: boolean;                 // unfinished and no working day left before the required date
  status: Status;
  scheduled: boolean;               // has its line and expected scheduling date - see "Not scheduled"
  startDays: number | null;         // working days the whole order takes at the target: qty / target
  startDate: ISODate | null;        // start of that run, ending on the required date, less 1 working day
  preProduction: PreProduction;
  postProduction: PostProduction;
  bookStart: ISODate;               // the days it holds its line - see "Lines" at the top (none while not scheduled)
  bookEnd: ISODate;
  waitingFor: string | null;        // the order on its line it has been moved back behind
  overlaps: string[];               // orders on its line booked on the same days (work logged for both at once)
}

/** Only for an order not yet started: the line is taken until the day before this, so it cannot begin earlier. */
export interface PlanOptions { notBefore?: ISODate | null }

// ---------------------------------------------------------------------------
// Pre-production milestones

export const MILESTONES = ['fabric', 'cutting', 'accessories'] as const;
export type MilestoneKey = (typeof MILESTONES)[number];
/** Calendar days before the start date each milestone is expected (changed from 10 / 3 / 3 on 22 Sep 2026). */
export const MILESTONE_LEAD_DAYS: Record<MilestoneKey, number> = { fabric: 25, cutting: 7, accessories: 7 };
/** Post-production: packing is expected this many calendar days after the order is complete. */
export const PACKING_DAYS = 4;
export const MILESTONE_LABEL: Record<MilestoneKey, string> = {
  fabric: 'Fabric received', cutting: 'Cutting', accessories: 'Accessories',
};

/** Pre-production not yet ticked. Production can be logged only once this is empty. */
export function milestonesMissing(o: Order): MilestoneKey[] {
  const done: Record<MilestoneKey, string | null> = {
    fabric: o.fabricReceivedAt, cutting: o.cuttingDoneAt, accessories: o.accessoriesReceivedAt,
  };
  return MILESTONES.filter((k) => !done[k]);
}
/** Working days kept free before the calculated start. */
export const START_BUFFER_DAYS = 1;

export type MilestoneState = 'early' | 'on-time' | 'late' | 'due' | 'overdue' | 'none';

export interface Milestone {
  expected: ISODate | null;  // start date - lead days
  doneAt: string | null;     // when it was ticked
  doneOn: ISODate | null;    // the local date of doneAt
  /**
   * Done: expected - done date (+ days early / - days late).
   * Not done: expected - today (+ days still to go / - days overdue).
   */
  days: number | null;
  state: MilestoneState;
}

export interface PreProduction {
  fabric: Milestone;
  cutting: Milestone;
  accessories: Milestone;
  /** ready = all three done; delayed = something done late or overdue (by `delayDays`); on-schedule = nothing late yet. */
  overall: 'ready' | 'delayed' | 'on-schedule' | 'none';
  delayDays: number;
}

/**
 * Post-production. Packing is due PACKING_DAYS after the order's completion -
 * the day it finished, or while it is still running, its expected completion.
 * Nothing is due before production starts.
 */
export interface PostProduction { packing: Milestone }

export function postProduction(order: Order, completion: ISODate | null, today: ISODate): PostProduction {
  return { packing: milestone(completion ? addDays(completion, PACKING_DAYS) : null, order.packedAt, today) };
}

export function milestone(expected: ISODate | null, doneAt: string | null, today: ISODate): Milestone {
  const doneOn = doneAt ? localISODate(doneAt) : null;
  if (!expected) return { expected, doneAt, doneOn, days: null, state: 'none' };
  if (doneOn) {
    const days = daysBetween(doneOn, expected);
    return { expected, doneAt, doneOn, days, state: days > 0 ? 'early' : days < 0 ? 'late' : 'on-time' };
  }
  const days = daysBetween(today, expected);
  return { expected, doneAt, doneOn, days, state: days < 0 ? 'overdue' : 'due' };
}

export function preProduction(order: Order, startDate: ISODate | null, today: ISODate): PreProduction {
  const exp = (k: MilestoneKey) => (startDate ? addDays(startDate, -MILESTONE_LEAD_DAYS[k]) : null);
  const fabric = milestone(exp('fabric'), order.fabricReceivedAt, today);
  const cutting = milestone(exp('cutting'), order.cuttingDoneAt, today);
  const accessories = milestone(exp('accessories'), order.accessoriesReceivedAt, today);
  const all = [fabric, cutting, accessories];
  const delayDays = Math.max(0, ...all.map((m) => (m.state === 'late' || m.state === 'overdue' ? -m.days! : 0)));
  const overall = all.every((m) => m.doneAt) ? 'ready'
    : delayDays > 0 ? 'delayed'
    : all.some((m) => m.expected) ? 'on-schedule' : 'none';
  return { fabric, cutting, accessories, overall, delayDays };
}

/** Sum entries into one total per date, oldest first. */
export function dailyTotals(entries: Entry[]): { date: ISODate; qty: number }[] {
  const m = new Map<ISODate, number>();
  for (const e of entries) m.set(e.entryDate, (m.get(e.entryDate) ?? 0) + e.qty);
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, qty]) => ({ date, qty }));
}

/**
 * Average output per FULL working day over every worked day - or only the
 * last `lastN` of them when given: output divided by the capacity those days
 * had. A day with production always counts as at least a full day unless it
 * was half idle - work logged on a weekend or on a day marked fully idle was
 * clearly a working day after all.
 */
export function averagePace(
  allDays: { date?: ISODate; qty: number }[], cap?: Capacity, lastN?: number | null,
): { pace: number | null; used: number } {
  const days = lastN ? allDays.slice(-lastN) : allDays;
  if (!days.length) return { pace: null, used: 0 };
  const weight = (d: { date?: ISODate }) => {
    if (!cap || !d.date) return 1;
    const c = cap(d.date);
    return c > 0 ? c : 1;
  };
  const qty = days.reduce((s, d) => s + d.qty, 0);
  const worked = days.reduce((s, d) => s + weight(d), 0);
  return { pace: qty / worked, used: days.length };
}

export function planOrder(
  order: Order, orderEntries: Entry[], s: Settings, asOf: ISODate, idle: IdleDay[] = [], opts: PlanOptions = {},
): OrderPlan {
  const cap = makeCapacity(s.workDaysPerWeek, idle, order.lineNo);
  // Re-planning from an earlier as-of date must not see production logged after it.
  const entries = orderEntries.filter((e) => e.entryDate <= asOf);
  const days = dailyTotals(entries);

  const produced = days.reduce((sum, d) => sum + d.qty, 0);
  const balance = Math.max(0, order.orderQty - produced);
  const overBy = Math.max(0, produced - order.orderQty);
  const started = produced > 0;
  const completed = produced >= order.orderQty;
  const firstProduction = days.length ? days[0].date : null;
  const lastProduction = days.length ? days[days.length - 1].date : null;

  const base = {
    produced, balance, overBy,
    pctComplete: Math.min(1, produced / order.orderQty),
    entryCount: entries.length,
    daysWorked: days.length,
    firstProduction, lastProduction,
  };

  if (completed) {
    // Finished work ends where it finished.
    return {
      ...base,
      pacePerDay: null, paceDaysUsed: 0, paceBasis: null,
      planFrom: null, workingDaysLeft: null, targetPerDay: null, daysNeeded: null,
      projectedFinish: lastProduction,
      bufferDays: capacityDiff(lastProduction!, order.requiredDate, cap),
      overdue: false,
      status: 'COMPLETED',
      scheduled: isScheduled(order),
      startDays: null, startDate: null,
      preProduction: preProduction(order, null, asOf),
      postProduction: postProduction(order, lastProduction, asOf),
      bookStart: firstProduction!, bookEnd: lastProduction!, waitingFor: null, overlaps: [],
    };
  }

  // First working day the order can still use. A running order continues
  // from today, or from tomorrow once today's output is already logged. An
  // order not yet started cannot begin before its expected scheduling date
  // (planningDate) - nor while its line is still taken. One not scheduled yet
  // is read as if it could start today.
  const scheduled = isScheduled(order);
  const planningDate = order.planningDate ?? asOf;
  const planFrom = started
    ? firstAvailable(maxDate(asOf, addDays(lastProduction!, 1)), cap)
    : firstAvailable(maxDate(maxDate(asOf, planningDate), opts.notBefore ?? planningDate), cap);

  const workingDaysLeft = capacityBetween(planFrom, order.requiredDate, cap);
  const overdue = workingDaysLeft === 0;
  const targetPerDay = Math.ceil(balance / Math.max(1, workingDaysLeft));

  let pace: number | null = null, used = 0;
  let paceBasis: OrderPlan['paceBasis'] = null;
  if (started && s.paceMode === 'peak') {
    // Peak pace: the target until enough days are in to judge, then the best day so far.
    used = days.length;
    if (days.length <= PEAK_WARMUP_DAYS) [pace, paceBasis] = [targetPerDay, 'target'];
    else [pace, paceBasis] = [Math.max(...days.map((d) => d.qty)), 'peak'];
  } else if (started) {
    ({ pace, used } = averagePace(days, cap, s.paceDays));
    paceBasis = 'average';
  }
  const finish = pace ? finishAtPace(planFrom, balance, pace, cap) : null;
  const projectedFinish = finish?.date ?? null;
  const daysNeeded = finish?.days ?? null;
  const bufferDays = projectedFinish ? capacityDiff(projectedFinish, order.requiredDate, cap) : null;

  let status: Status;
  if (!started) status = overdue ? 'BEHIND SCHEDULE' : 'NOT STARTED';
  else if (overdue || projectedFinish! > order.requiredDate) status = 'BEHIND SCHEDULE';
  else if (bufferDays! <= AT_RISK_BUFFER) status = 'AT RISK';
  else status = 'ON TRACK';

  // At the target, the whole order takes qty / target working days. Run that
  // back from the required date, then keep one more working day spare.
  const startDays = order.orderQty / targetPerDay;
  let startDate = spanStart(order.requiredDate, startDays, cap);
  for (let i = 0; i < START_BUFFER_DAYS; i++) startDate = prevAvailable(startDate, cap);

  // The days it holds its line. With no working day left before the required
  // date it can only begin now, so it holds just that day.
  let bookStart: ISODate, bookEnd: ISODate;
  if (started) [bookStart, bookEnd] = [firstProduction!, projectedFinish!];
  else if (overdue) [bookStart, bookEnd] = [planFrom, planFrom];
  else [bookStart, bookEnd] = [startDate, maxDate(startDate, lastAvailable(order.requiredDate, cap))];

  // Not scheduled and not started: no start date to count pre-production back from yet.
  const shownStart = started || scheduled ? startDate : null;
  return {
    ...base,
    pacePerDay: pace, paceDaysUsed: used, paceBasis,
    planFrom, workingDaysLeft, targetPerDay, daysNeeded,
    projectedFinish, bufferDays, overdue, status, scheduled,
    startDays, startDate: shownStart,
    preProduction: preProduction(order, shownStart, asOf),
    postProduction: postProduction(order, projectedFinish, asOf),
    bookStart, bookEnd, waitingFor: null, overlaps: [],
  };
}

// ---------------------------------------------------------------------------
// Lines: who holds each line when, and the queue behind them.

export interface Booking { orderId: number; orderNo: string; start: ISODate; end: ISODate }

const bookingOf = (o: Order, p: OrderPlan): Booking =>
  ({ orderId: o.id, orderNo: o.orderNo, start: p.bookStart, end: p.bookEnd });

const clash = (a: { start: ISODate; end: ISODate }, b: { start: ISODate; end: ISODate }) =>
  a.start <= b.end && b.start <= a.end;

/** One order's last day is the next one's first: a changeover on the line, not a clash. */
const changeover = (a: { start: ISODate; end: ISODate }, b: { start: ISODate; end: ISODate }) =>
  a.end === b.start || b.end === a.start;

function entriesByOrder(entries: Entry[]): Map<number, Entry[]> {
  const m = new Map<number, Entry[]>();
  for (const e of entries) {
    if (!m.has(e.orderId)) m.set(e.orderId, []);
    m.get(e.orderId)!.push(e);
  }
  return m;
}

/**
 * Plans an order not yet started so that it misses every booking in `busy`:
 * where it clashes, it tries again from the day after the clashing booking,
 * until it fits. Returns that plan and the booking that held it back last
 * (null when it fitted where it was). An order already started stays put.
 */
export function fitAround(
  order: Order, orderEntries: Entry[], s: Settings, asOf: ISODate, idle: IdleDay[], busy: Booking[],
): { plan: OrderPlan; blockedBy: Booking | null } {
  let notBefore = null as ISODate | null;
  let blockedBy: Booking | null = null;
  for (let i = 0; ; i++) {
    const plan = planOrder(order, orderEntries, s, asOf, idle, { notBefore });
    const mine = { start: plan.bookStart, end: plan.bookEnd };
    const hit = busy.filter((b) => clash(b, mine)).sort((a, b) => (a.end < b.end ? 1 : -1))[0];
    if (!hit || plan.produced > 0 || i >= MAX_SPAN_DAYS) return { plan, blockedBy };
    blockedBy = hit;
    // Start the day after it ends; still clashing (the buffer day), a day later again.
    const after = addDays(hit.end, 1);
    notBefore = notBefore && notBefore >= after ? addDays(notBefore, 1) : after;
  }
}

/**
 * For moving an order not yet started on the line calendar: the expected
 * scheduling date that makes it begin on `start` - or on the first working
 * day it can after that. The start date runs a buffer day ahead of the
 * scheduling date, so this looks for it rather than guessing.
 */
export function schedulingDateFor(
  order: Order, s: Settings, asOf: ISODate, idle: IdleDay[], start: ISODate,
): ISODate {
  let plan = planOrder(order, [], s, asOf, idle);
  for (let p = addDays(start, -7), i = 0; i < MAX_SPAN_DAYS; p = addDays(p, 1), i++) {
    plan = planOrder({ ...order, planningDate: p }, [], s, asOf, idle);
    if (plan.bookStart >= start) break;
  }
  return plan.planFrom!;
}

/**
 * Every order planned, with each line's queue applied: work already started
 * stays where it is, and the orders not yet started take their turn - earliest
 * start first - each moved back behind whatever is ahead of it on its line.
 */
export function planBoard(
  orders: Order[], entries: Entry[], s: Settings, asOf: ISODate, idle: IdleDay[] = [],
): Map<number, OrderPlan> {
  const byOrder = entriesByOrder(entries);
  const plans = new Map<number, OrderPlan>();
  for (const o of orders) plans.set(o.id, planOrder(o, byOrder.get(o.id) ?? [], s, asOf, idle));

  for (const line of LINES) {
    const onLine = orders.filter((o) => holdsLine(o, line));
    if (!onLine.length) continue;
    const busy = onLine.filter((o) => plans.get(o.id)!.produced > 0).map((o) => bookingOf(o, plans.get(o.id)!));
    const waiting = onLine.filter((o) => plans.get(o.id)!.produced === 0)
      .sort((a, b) => plans.get(a.id)!.bookStart.localeCompare(plans.get(b.id)!.bookStart) || a.id - b.id);
    for (const o of waiting) {
      const { plan, blockedBy } = fitAround(o, byOrder.get(o.id) ?? [], s, asOf, idle, busy);
      plans.set(o.id, { ...plan, waitingFor: blockedBy?.orderNo ?? null });
      busy.push(bookingOf(o, plan));
    }
    // Only work already logged can still clash - two orders produced on one line
    // at once. Finishing one and starting the next on the same day does not count.
    for (const o of onLine) {
      const mine = bookingOf(o, plans.get(o.id)!);
      const overlaps = onLine
        .filter((x) => {
          if (x.id === o.id) return false;
          const theirs = bookingOf(x, plans.get(x.id)!);
          return clash(mine, theirs) && !changeover(mine, theirs);
        })
        .map((x) => x.orderNo);
      if (overlaps.length) plans.set(o.id, { ...plans.get(o.id)!, overlaps });
    }
  }
  return plans;
}

export interface LineOption {
  lineNo: number;
  free: boolean;                        // the order fits on this line as entered
  /** The order on this line as entered (its idle days are this line's). */
  plan: Pick<OrderPlan, 'startDate' | 'targetPerDay' | 'bookStart' | 'bookEnd' | 'overdue'>;
  clashes: Booking[];                   // what it would clash with
  /** Not free and not started yet: the earliest it could go on this line instead. */
  suggest: {
    planningDate: ISODate; startDate: ISODate | null; bookStart: ISODate; bookEnd: ISODate;
    targetPerDay: number | null; late: boolean;
  } | null;
}

export interface LineCheck {
  plan: Pick<OrderPlan, 'startDate' | 'targetPerDay' | 'bookStart' | 'bookEnd' | 'workingDaysLeft' | 'overdue' | 'produced'>;
  lines: LineOption[];
}

/**
 * Where an order (new, or being changed) can go: for every line, whether it
 * fits as entered, what it would clash with, and if not, the earliest planning
 * date that fits. `others` is every other order, with their own queues applied.
 * The candidate needs a planning date (the caller puts in today when none was
 * entered); orders among `others` that are not scheduled take no line's days.
 */
export function lineCheck(
  candidate: Order, candidateEntries: Entry[], others: Order[], otherEntries: Entry[],
  s: Settings, asOf: ISODate, idle: IdleDay[] = [],
): LineCheck {
  const plans = planBoard(others, otherEntries, s, asOf, idle);
  const lines = LINES.map((lineNo): LineOption => {
    const here = { ...candidate, lineNo };
    const p = planOrder(here, candidateEntries, s, asOf, idle);
    const busy = others.filter((o) => holdsLine(o, lineNo)).map((o) => bookingOf(o, plans.get(o.id)!));
    const clashes = busy.filter((b) => clash(b, { start: p.bookStart, end: p.bookEnd }))
      .sort((a, b) => a.start.localeCompare(b.start));
    let suggest: LineOption['suggest'] = null;
    if (clashes.length && p.produced === 0) {
      const fit = fitAround(here, candidateEntries, s, asOf, idle, busy).plan;
      suggest = {
        planningDate: fit.planFrom!, startDate: fit.startDate, bookStart: fit.bookStart, bookEnd: fit.bookEnd,
        targetPerDay: fit.targetPerDay, late: fit.overdue,
      };
    }
    return {
      lineNo, free: !clashes.length, clashes, suggest,
      plan: { startDate: p.startDate, targetPerDay: p.targetPerDay, bookStart: p.bookStart, bookEnd: p.bookEnd, overdue: p.overdue },
    };
  });
  const p = planOrder(candidate, candidateEntries, s, asOf, idle);
  return {
    plan: {
      startDate: p.startDate, targetPerDay: p.targetPerDay, bookStart: p.bookStart, bookEnd: p.bookEnd,
      workingDaysLeft: p.workingDaysLeft, overdue: p.overdue, produced: p.produced,
    },
    lines,
  };
}

// ---------------------------------------------------------------------------
// Production log: running total per order, in the order the work was done.

export interface EntryCalc {
  cumulative: number;
  balanceAfter: number;
  flag: string; // '', 'ORDER COMPLETE' or 'OVER by 1,234'
}

/**
 * Running total per order, by date and then by entry id. (The workbook
 * summed "everything up to this date", so two entries on the same day both
 * showed the day-end total.)
 */
export function entryRunningTotals(orders: Order[], entries: Entry[]): Map<number, EntryCalc> {
  const qtyOf = new Map(orders.map((o) => [o.id, o.orderQty]));
  const sorted = [...entries].sort((a, b) =>
    a.entryDate === b.entryDate ? a.id - b.id : a.entryDate < b.entryDate ? -1 : 1);
  const run = new Map<number, number>();
  const out = new Map<number, EntryCalc>();
  for (const e of sorted) {
    const cum = (run.get(e.orderId) ?? 0) + e.qty;
    run.set(e.orderId, cum);
    const target = qtyOf.get(e.orderId) ?? 0;
    const flag = cum > target
      ? `OVER by ${(cum - target).toLocaleString('en-US')}`
      : cum === target ? 'ORDER COMPLETE' : '';
    out.set(e.id, { cumulative: cum, balanceAfter: Math.max(0, target - cum), flag });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dashboard

export interface DashboardKpis {
  totalQty: number;
  totalProduced: number;
  totalBalance: number;
  pctComplete: number;
  workedDays: number;         // days anything was produced, factory-wide (all, or at most the last N)
  avgPerDay: number;          // output / those days - same rule as order pace
  neededPerDay: number;       // sum of every open order's target per day, overdue ones included
  overdueBalance: number;     // the part of it on orders with no working day left
  counts: Record<Status, number> & { total: number };
}

export function dashboardKpis(
  orders: Order[], plans: Map<number, OrderPlan>, entries: Entry[], asOf: ISODate, s: Settings = BASE_SETTINGS,
): DashboardKpis {
  const counts = { total: orders.length } as DashboardKpis['counts'];
  for (const st of STATUSES) counts[st] = 0;
  let totalQty = 0, totalProduced = 0, totalBalance = 0, neededPerDay = 0, overdueBalance = 0;
  for (const o of orders) {
    const p = plans.get(o.id)!;
    counts[p.status]++;
    totalQty += o.orderQty;
    totalProduced += p.produced;
    totalBalance += p.balance;
    if (p.targetPerDay != null) neededPerDay += p.targetPerDay;
    if (p.overdue) overdueBalance += p.balance;
  }
  const factoryDays = dailyTotals(entries.filter((e) => e.entryDate <= asOf));
  const { pace, used } = averagePace(factoryDays, undefined, s.paceDays);
  return {
    totalQty, totalProduced, totalBalance,
    pctComplete: totalQty ? (totalQty - totalBalance) / totalQty : 0,
    workedDays: used, avgPerDay: pace ?? 0,
    neededPerDay, overdueBalance, counts,
  };
}

// ---------------------------------------------------------------------------
// Production calendar: one row per order, one column per day.

export type CellState = 'met' | 'below' | 'late';

export interface CalendarDay {
  date: ISODate; working: boolean; today: boolean;
  idle: number; // idle portion marked for EVERY line (0, 0.5, 1)
}
export interface CalendarCell { qty: number; needed: number | null; state: CellState }
export interface CalendarRow {
  orderId: number; orderNo: string; lineNo: number | null; styleNo: string;
  orderQty: number; requiredDate: ISODate; status: Status;
  pacePerDay: number | null; targetPerDay: number | null; overdue: boolean;
  projectedFinish: ISODate | null;
  cells: (CalendarCell | null)[];
  idle: number[]; // idle portion on each working day for this order's line
}

/** The calendar always runs this many days past the plan date. */
export const CALENDAR_FUTURE_DAYS = 180;
/** And never reaches further back than this, however old the log is. */
export const CALENDAR_MAX_PAST_DAYS = 366;

function calendarDays(start: ISODate, horizon: ISODate, ww: WorkWeek, today: ISODate, idle: IdleDay[]): CalendarDay[] {
  const idleAll = idleLookup(idle, null);
  const days: CalendarDay[] = [];
  for (let d = start; d <= horizon; d = addDays(d, 1)) {
    const working = isWorkingDay(d, ww);
    days.push({ date: d, working, today: d === today, idle: working ? idleAll(d) : 0 });
  }
  return days;
}

export function buildCalendar(
  orders: Order[], plans: Map<number, OrderPlan>, entries: Entry[], s: Settings, asOf: ISODate,
  today: ISODate, idle: IdleDay[] = [],
) {
  const ww = s.workDaysPerWeek;
  const firstLogged = entries.reduce<ISODate | null>((m, e) => (m === null || e.entryDate < m ? e.entryDate : m), null);
  const start = maxDate(s.calendarStart ?? firstLogged ?? asOf, addDays(asOf, -CALENDAR_MAX_PAST_DAYS));
  const days = calendarDays(start, addDays(asOf, CALENDAR_FUTURE_DAYS), ww, today, idle);
  const col = new Map(days.map((d, i) => [d.date, i]));
  const byOrder = entriesByOrder(entries);

  const totals = days.map(() => 0);
  const rows: CalendarRow[] = orders.map((o) => {
    const p = plans.get(o.id)!;
    const cap = makeCapacity(ww, idle, o.lineNo);
    const idleHere = idleLookup(idle, o.lineNo);
    const cells: (CalendarCell | null)[] = days.map(() => null);
    let before = 0; // produced before the day being looked at
    for (const d of dailyTotals(byOrder.get(o.id) ?? [])) {
      const i = col.get(d.date);
      if (i !== undefined) {
        // What the order needed that morning to still make its date.
        const left = Math.max(0, o.orderQty - before);
        const needed = left === 0 ? 0 : Math.ceil(left / Math.max(1, capacityBetween(d.date, o.requiredDate, cap)));
        const state: CellState = d.date > o.requiredDate ? 'late' : d.qty >= needed ? 'met' : 'below';
        cells[i] = { qty: d.qty, needed, state };
        totals[i] += d.qty;
      }
      before += d.qty;
    }
    return {
      orderId: o.id, orderNo: o.orderNo, lineNo: o.lineNo, styleNo: o.styleNo,
      orderQty: o.orderQty, requiredDate: o.requiredDate, status: p.status,
      pacePerDay: p.pacePerDay, targetPerDay: p.targetPerDay, overdue: p.overdue,
      projectedFinish: p.projectedFinish,
      cells,
      idle: days.map((d) => (d.working ? idleHere(d.date) : 0)),
    };
  });

  return { start, end: days.length ? days[days.length - 1].date : start, days, rows, totals };
}

// ---------------------------------------------------------------------------
// Line calendar: one row per line, one column per day, each day showing the
// order booked on that line.

/** Days before the plan date the line calendar always starts from (older ones fold away on the page). */
export const LINE_CALENDAR_RECENT_DAYS = 7;

export interface LineBlock {
  orderId: number; orderNo: string; styleNo: string; colour: string; orderQty: number; unit: string;
  status: Status; kind: 'done' | 'running' | 'planned';
  start: ISODate; end: ISODate; requiredDate: ISODate; planFrom: ISODate | null;
  produced: number; balance: number; pacePerDay: number | null; targetPerDay: number | null;
  waitingFor: string | null; overlaps: string[];
  paceBasis: OrderPlan['paceBasis']; daysWorked: number;
}

export interface LineCell {
  orderId: number;        // the order booked that day (the earlier one, if two clash)
  clash: number | null;   // a second order booked on the same day
  qty: number | null;     // made that day on this line - the only number the page shows
  late: boolean;          // past that order's required date: a red day, otherwise green
  start: boolean;         // first day of that booking
  /**
   * More than one order made something that day (one finishing, the next
   * starting): what each made, in line order, so the day can be shared out
   * in proportion. null on an ordinary day.
   */
  parts: { orderId: number; qty: number; late: boolean }[] | null;
}

export interface LineRow {
  lineNo: number;
  blocks: LineBlock[];            // its bookings, earliest first
  cells: (LineCell | null)[];
  idle: number[];                 // idle portion per day for this line
  current: number | null;         // order running or booked on the plan date - never a finished one
  freeFrom: ISODate;              // first working day after its last unfinished booking - the plan date when there is none
}

/** An order waiting for its line or its scheduling date - shown above the line calendar, to be dragged onto it. */
export interface UnscheduledOrder {
  orderId: number; orderNo: string; styleNo: string; colour: string; orderQty: number; unit: string;
  requiredDate: ISODate; lineNo: number | null; planningDate: ISODate | null;
  missing: ScheduleField[]; targetPerDay: number | null; overdue: boolean;
}

export function buildLineCalendar(
  orders: Order[], plans: Map<number, OrderPlan>, entries: Entry[], s: Settings, asOf: ISODate,
  today: ISODate, idle: IdleDay[] = [],
) {
  const ww = s.workDaysPerWeek;
  const lined = orders.filter((o) => o.lineNo !== null && holdsLine(o, o.lineNo));
  const unscheduled: UnscheduledOrder[] = orders
    .filter((o) => !isScheduled(o) && plans.get(o.id)!.status !== 'COMPLETED')
    .map((o) => {
      const p = plans.get(o.id)!;
      return {
        orderId: o.id, orderNo: o.orderNo, styleNo: o.styleNo, colour: o.colour, orderQty: o.orderQty, unit: o.unit,
        requiredDate: o.requiredDate, lineNo: o.lineNo, planningDate: o.planningDate,
        missing: scheduleMissing(o), targetPerDay: p.targetPerDay, overdue: p.overdue,
      };
    })
    .sort((a, b) => a.requiredDate.localeCompare(b.requiredDate) || a.orderNo.localeCompare(b.orderNo));
  const earliest = lined.reduce<ISODate | null>((m, o) => {
    const b = plans.get(o.id)!.bookStart;
    return m === null || b < m ? b : m;
  }, null);
  const start = maxDate(
    s.calendarStart ?? minDate(earliest ?? asOf, addDays(asOf, -LINE_CALENDAR_RECENT_DAYS)),
    addDays(asOf, -CALENDAR_MAX_PAST_DAYS));
  const horizon = addDays(asOf, CALENDAR_FUTURE_DAYS);
  const days = calendarDays(start, horizon, ww, today, idle);
  const col = new Map(days.map((d, i) => [d.date, i]));
  const byOrder = entriesByOrder(entries.filter((e) => e.entryDate <= asOf));
  const totals = days.map(() => 0);

  const rows: LineRow[] = LINES.map((lineNo) => {
    const cap = makeCapacity(ww, idle, lineNo);
    const idleHere = idleLookup(idle, lineNo);
    const blocks = lined.filter((o) => o.lineNo === lineNo).map((o): LineBlock => {
      const p = plans.get(o.id)!;
      return {
        orderId: o.id, orderNo: o.orderNo, styleNo: o.styleNo, colour: o.colour, orderQty: o.orderQty, unit: o.unit,
        status: p.status, kind: p.status === 'COMPLETED' ? 'done' : p.produced > 0 ? 'running' : 'planned',
        start: p.bookStart, end: p.bookEnd, requiredDate: o.requiredDate, planFrom: p.planFrom,
        produced: p.produced, balance: p.balance, pacePerDay: p.pacePerDay, targetPerDay: p.targetPerDay,
        waitingFor: p.waitingFor, overlaps: p.overlaps,
        paceBasis: p.paceBasis, daysWorked: p.daysWorked,
      };
    }).sort((a, b) => a.start.localeCompare(b.start) || a.orderId - b.orderId);

    const cells: (LineCell | null)[] = days.map(() => null);
    const endOf = new Map<number, ISODate>();
    const madeOn = new Map<number, { orderId: number; qty: number; late: boolean }[]>(); // day index -> each order's output
    for (const b of blocks) {
      endOf.set(b.orderId, b.end);
      for (let d = maxDate(b.start, start), n = 0; d <= minDate(b.end, horizon) && n < MAX_SPAN_DAYS; d = addDays(d, 1), n++) {
        const i = col.get(d)!;
        const c = cells[i];
        if (c && c.orderId !== b.orderId) {
          // The day one order finishes and this one begins is a changeover: the day
          // belongs to this order from now on, and `parts` shares it out.
          if (d === b.start && endOf.get(c.orderId) === d && c.clash === null) {
            cells[i] = { ...c, orderId: b.orderId, late: d > b.requiredDate, start: true };
          } else {
            c.clash = b.orderId;
          }
          continue;
        }
        cells[i] = { orderId: b.orderId, clash: null, qty: null, late: d > b.requiredDate, start: d === b.start, parts: null };
      }
      for (const day of dailyTotals(byOrder.get(b.orderId) ?? [])) {
        const i = col.get(day.date);
        if (i === undefined) continue;
        const c = cells[i] ?? (cells[i] = {
          orderId: b.orderId, clash: null, qty: null, late: day.date > b.requiredDate, start: false, parts: null,
        });
        c.qty = (c.qty ?? 0) + day.qty;
        totals[i] += day.qty;
        if (!madeOn.has(i)) madeOn.set(i, []);
        madeOn.get(i)!.push({ orderId: b.orderId, qty: day.qty, late: day.date > b.requiredDate });
      }
    }
    for (const [i, made] of madeOn) if (made.length > 1) cells[i]!.parts = made;

    // A finished order no longer holds the line: what is on it is the order
    // running (or booked) today, and it is free once no such order is left.
    const open = blocks.filter((b) => b.kind !== 'done');
    const current = open.find((b) => b.start <= asOf && asOf <= b.end)?.orderId ?? null;
    const lastEnd = open.reduce<ISODate | null>((m, b) => (m === null || b.end > m ? b.end : m), null);
    const freeFrom = lastEnd && lastEnd >= asOf ? firstAvailable(addDays(lastEnd, 1), cap) : asOf;
    return {
      lineNo, blocks, cells, current, freeFrom,
      idle: days.map((d) => (d.working ? idleHere(d.date) : 0)),
    };
  });

  return { start, end: days.length ? days[days.length - 1].date : start, days, rows, totals, unscheduled };
}
