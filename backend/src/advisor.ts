/**
 * The advisor: where an order should go, judged the way a planner would - not
 * just "which line is free" (lineCheck does that) but which line will actually
 * make it on time, going by what each line has really produced.
 *
 * For every line it takes the earliest the order could start there, what the
 * order would need a day from then, and what that line has really made - for
 * this style on this line when it has run it before, otherwise for anything.
 * Those give a fit (comfortable / tight / stretch / beyond / unknown), working
 * days to spare, and a score; the best line is the one most likely to finish
 * on time with the least waiting.
 *
 * STYLE FAMILY (asked for 25 Sep 2026): the part of the style number before the
 * "/" - OR675/11 and OR675/12 are one family. A line that is running that
 * family now, or would run it straight before or after this order, is set up
 * for it, so it is recommended FIRST - as long as it can still make the
 * required date. Otherwise the ranking is as above. A line's record for the
 * family also stands in for its record of the exact style when that is thin.
 *
 * Used by the order form (with the line check) and by the line calendar while
 * an order is dragged. It only advises: nothing here saves anything.
 */

import { addDays, daysBetween, maxDate, type ISODate } from './dates';
import { fmtDay, fmtNum, plural } from './format';
import { lineStats, performance } from './insights';
import {
  capacityBetween, dailyTotals, finishAtPace, holdsLine, lineCheck, LINES, makeCapacity, MILESTONE_LABEL, MILESTONE_LEAD_DAYS,
  MILESTONES, planBoard, type Entry, type IdleDay, type MilestoneKey, type Order, type Settings,
} from './planning';

export type Fit = 'comfortable' | 'tight' | 'stretch' | 'beyond' | 'unknown';

/** Its usual pace beats the need by this much: comfortable. Below the need but its best day reaches it: stretch. */
export const COMFORT_MARGIN = 0.15;
/** A line's record counts once it has this many worked days. */
export const MIN_RECORD_DAYS = 2;

export interface LineAdvice {
  lineNo: number;
  available: boolean;            // can take the order - on the dates entered or from a later one
  asEntered: boolean;            // free on the dates entered
  planningDate: ISODate | null;  // the Expected Scheduling Date to use on this line
  start: ISODate | null;         // its start date there
  end: ISODate | null;           // booked through
  targetPerDay: number | null;   // what it would need a day from that start
  late: boolean;                 // the earliest it fits is past the required date
  waitDays: number;              // calendar days later than the dates entered
  busyWith: string[];            // what holds the line on the dates entered
  record: { avgPerDay: number | null; bestDay: number | null; daysWorked: number };
  /** This style on this line before - or, when that is thin, its style family. */
  style: { avgPerDay: number | null; daysWorked: number; match: 'style' | 'family' } | null;
  pace: number | null;           // what it is expected to make a day here
  fit: Fit;
  spareDays: number | null;      // working days to spare at that pace; negative = late
  /** An order of the same style family on this line: running now, straight before or after this one, or the last it ran. */
  family: { orderNo: string; styleNo: string; how: 'running' | 'before' | 'after' | 'last' } | null;
  /** That, and it still makes the required date here - so this line goes to the top. */
  familyFirst: boolean;
  score: number;
  reasons: string[];
}

export interface PlacementAdvice {
  best: LineAdvice | null;
  /** Every line, best first; lines that cannot take it at all come last. */
  ranked: LineAdvice[];
  warnings: string[];
  /** When no line's usual pace reaches the need: the date the best of them would really finish. */
  realisticDate: ISODate | null;
  /** The style the advice looked up, as matched. */
  styleNo: string | null;
  /** Its style family - the part before the "/". */
  family: string | null;
}

const FIT_SCORE: Record<Fit, number> = { comfortable: 300, tight: 200, unknown: 120, stretch: 60, beyond: 0 };
/** Above anything the rest of the score can add up to: a line set up for the family comes first. */
const FAMILY_BONUS = 2000;

/**
 * The style family: the part of the style number before the "/", ignoring
 * case and spaces - "or675/13" and "OR675/12" are both OR675. A style with no
 * "/" is its own family.
 */
export function styleFamily(style: string | null | undefined): string | null {
  const s = (style ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return null;
  const head = s.split('/')[0];
  return head || null;
}

export function fitOf(target: number | null, pace: number | null, best: number | null): Fit {
  if (!target || target <= 0) return pace ? 'comfortable' : 'unknown';
  if (!pace) return 'unknown';
  if (pace >= target * (1 + COMFORT_MARGIN)) return 'comfortable';
  if (pace >= target) return 'tight';
  if (best && best >= target) return 'stretch';
  return 'beyond';
}

const sameStyle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Where `candidate` (a new order, or an existing one being changed or moved)
 * would best go. `others` are every other order; `entries` is the whole log.
 */
export function placementAdvice(
  candidate: Order, others: Order[], entries: Entry[], s: Settings, asOf: ISODate, idle: IdleDay[] = [],
  opts: { currentLine?: number | null } = {},
): PlacementAdvice {
  const mine = entries.filter((e) => e.orderId === candidate.id);
  const theirs = entries.filter((e) => e.orderId !== candidate.id);
  const check = lineCheck(candidate, mine, others, theirs, s, asOf, idle);
  const produced = mine.filter((e) => e.entryDate <= asOf).reduce((t, e) => t + e.qty, 0);
  const balance = Math.max(0, candidate.orderQty - produced);
  const everyone = [...others, candidate];
  const records = lineStats(everyone, entries.filter((e) => e.entryDate <= asOf));
  const styleNo = candidate.styleNo.trim() || null;
  const family = styleFamily(styleNo);
  const inFamily = (o: Order) => family !== null && styleFamily(o.styleNo) === family;
  const enteredStart = check.plan.startDate ?? check.plan.bookStart;
  // Who holds each line and when, with the queues applied - to see which family each line is set up for.
  const board = family ? planBoard(others, theirs, s, asOf, idle) : null;

  const ranked = LINES.map((lineNo): LineAdvice => {
    const opt = check.lines[lineNo - 1];
    const rec = records[lineNo - 1];
    const record = { avgPerDay: rec.daysWorked >= MIN_RECORD_DAYS ? rec.avgPerDay : null, bestDay: rec.bestDay?.qty ?? null, daysWorked: rec.daysWorked };

    // This style, on this line, before - or its family, when the style itself has too few days.
    const recordFor = (match: (o: Order) => boolean) => {
      const ids = new Set(everyone.filter((o) => o.lineNo === lineNo && match(o)).map((o) => o.id));
      return performance(dailyTotals(entries.filter((e) => ids.has(e.orderId) && e.entryDate <= asOf)));
    };
    let style: LineAdvice['style'] = null;
    if (styleNo) {
      const exact = recordFor((o) => sameStyle(o.styleNo, styleNo));
      const fam = exact.daysWorked < MIN_RECORD_DAYS && family ? recordFor(inFamily) : null;
      if (fam && fam.daysWorked > exact.daysWorked) style = { avgPerDay: fam.avgPerDay, daysWorked: fam.daysWorked, match: 'family' };
      else if (exact.daysWorked) style = { avgPerDay: exact.avgPerDay, daysWorked: exact.daysWorked, match: 'style' };
    }
    const pace = style && style.daysWorked >= MIN_RECORD_DAYS ? style.avgPerDay : record.avgPerDay;

    const asEntered = opt.free;
    const pick = asEntered
      ? { planningDate: candidate.planningDate, start: opt.plan.startDate, bookStart: opt.plan.bookStart, end: opt.plan.bookEnd, target: opt.plan.targetPerDay, late: opt.plan.overdue }
      : opt.suggest
        ? { planningDate: opt.suggest.planningDate, start: opt.suggest.startDate, bookStart: opt.suggest.bookStart, end: opt.suggest.bookEnd, target: opt.suggest.targetPerDay, late: opt.suggest.late }
        : null;
    const available = pick !== null;
    const start = pick?.start ?? null;
    const target = pick?.target ?? null;
    const fit = available ? fitOf(target, pace, record.bestDay) : 'unknown';

    let spareDays: number | null = null;
    if (available && pace && start) {
      const cap = makeCapacity(s.workDaysPerWeek, idle, lineNo);
      const from = maxDate(start, asOf);
      spareDays = Math.floor(capacityBetween(from, candidate.requiredDate, cap) - balance / pace);
    }
    const waitDays = available && start && enteredStart ? Math.max(0, daysBetween(enteredStart, start)) : 0;
    const busyWith = opt.clashes.map((c) => c.orderNo);

    // The same family on this line: running now, or the booking straight before or after where this order would go.
    let fam: LineAdvice['family'] = null;
    if (board && pick) {
      const here = others.filter((o) => holdsLine(o, lineNo)).map((o) => ({ o, p: board.get(o.id)! }));
      const running = here.find(({ o, p }) => p.produced > 0 && p.status !== 'COMPLETED' && inFamily(o));
      const before = here.filter(({ p }) => p.bookEnd <= pick.bookStart).sort((a, b) => b.p.bookEnd.localeCompare(a.p.bookEnd))[0];
      const after = here.filter(({ p }) => p.status !== 'COMPLETED' && p.bookStart >= pick.end)
        .sort((a, b) => a.p.bookStart.localeCompare(b.p.bookStart))[0];
      const hit = running ? { x: running, how: 'running' as const }
        : before && inFamily(before.o) ? { x: before, how: before.p.status === 'COMPLETED' ? 'last' as const : 'before' as const }
        : after && inFamily(after.o) ? { x: after, how: 'after' as const } : null;
      if (hit) fam = { orderNo: hit.x.o.orderNo, styleNo: hit.x.o.styleNo, how: hit.how };
    }
    // First only where it can still make the date: available in time, and not beyond what the line has ever made.
    const familyFirst = !!fam && !pick!.late && fit !== 'beyond';

    const score = !available ? -10000
      : (pick!.late ? -1000 : 0) + (familyFirst ? FAMILY_BONUS : 0) + FIT_SCORE[fit] + (style ? 40 : 0)
        + (opts.currentLine === lineNo ? 15 : 0)
        - Math.min(waitDays, 60) * 4 + Math.max(-10, Math.min(15, spareDays ?? 0)) * 4;

    const reasons: string[] = [];
    if (!available) reasons.push(`Busy with ${busyWith.join(', ')} and this order cannot wait for it`);
    else if (asEntered) reasons.push('Free on the dates entered');
    else reasons.push(`Busy with ${busyWith.join(', ')} - free for this order from ${fmtDay(pick!.planningDate!)}${pick!.late ? ', after the required date' : ''}`);
    if (fam) {
      const what = `${fam.orderNo} (${fam.styleNo})`;
      reasons.push({
        running: `Running ${what} now - the same style family (${family}), so the line is already set up for it`,
        before: `Comes straight after ${what} - the same style family (${family}), so little changeover`,
        last: `Last ran ${what} - the same style family (${family}), so little changeover`,
        after: `Goes straight before ${what} - the same style family (${family}), so little changeover`,
      }[fam.how] + (familyFirst ? ''
        : pick!.late ? ' - but it only comes free after the required date'
        : ' - but it needs more a day than this line has ever made'));
    }
    if (style && style.daysWorked >= MIN_RECORD_DAYS) {
      reasons.push(`Has made ${style.match === 'style' ? styleNo : `${family} styles`} here before: `
        + `${fmtNum(style.avgPerDay)} a day over ${plural(style.daysWorked, 'worked day')}`);
    } else if (record.avgPerDay) {
      reasons.push(`Averages ${fmtNum(record.avgPerDay)} a day over ${plural(record.daysWorked, 'worked day')} (best ${fmtNum(record.bestDay)})`);
    } else {
      reasons.push(rec.daysWorked ? `Only ${plural(rec.daysWorked, 'worked day')} on record - too few to judge` : 'Has never run - no record of what it makes');
    }
    if (available && target) {
      reasons.push({
        comfortable: `Needs ${fmtNum(target)} a day${spareDays != null ? ` - about ${plural(spareDays, 'working day')} to spare` : ''}`,
        tight: `Needs ${fmtNum(target)} a day - just about what it makes`,
        stretch: `Needs ${fmtNum(target)} a day - more than it averages, though its best day was ${fmtNum(record.bestDay)}`,
        beyond: `Needs ${fmtNum(target)} a day - more than it has ever made in a day`,
        unknown: `Needs ${fmtNum(target)} a day`,
      }[fit]);
    }
    return {
      lineNo, available, asEntered, planningDate: pick?.planningDate ?? null, start, end: pick?.end ?? null,
      targetPerDay: target, late: pick?.late ?? false, waitDays, busyWith, record, style, pace, fit, spareDays,
      family: fam, familyFirst, score, reasons,
    };
  }).sort((a, b) => b.score - a.score || a.lineNo - b.lineNo);

  const best = ranked[0]?.available ? ranked[0] : null;
  const warnings: string[] = [];
  let realisticDate: ISODate | null = null;

  if (!best) {
    warnings.push('No line can take this order: every line is busy on these dates and the order is already running.');
  } else {
    if (best.late) warnings.push(`Even the best line only comes free after the required date (${fmtDay(candidate.requiredDate)}). Move the required date, or free a line.`);
    // The need, against the fastest any line has really gone.
    const fastest = ranked.filter((r) => r.available && r.pace).sort((a, b) => (b.pace ?? 0) - (a.pace ?? 0))[0];
    const everBest = Math.max(0, ...records.map((r) => r.bestDay?.qty ?? 0));
    if (best.targetPerDay && fastest && fastest.pace! < best.targetPerDay && fastest.start) {
      const cap = makeCapacity(s.workDaysPerWeek, idle, fastest.lineNo);
      realisticDate = finishAtPace(maxDate(fastest.start, asOf), balance, fastest.pace!, cap).date;
      warnings.push(`It needs ${fmtNum(best.targetPerDay)} a day, more than any line usually makes`
        + `${everBest && everBest < best.targetPerDay ? ` - and more than any line has made on its best day (${fmtNum(everBest)})` : ''}.`
        + ` At Line ${fastest.lineNo}'s usual ${fmtNum(fastest.pace)} a day it would finish about ${fmtDay(realisticDate)}.`
        + ' Give it a later required date, or split it across two lines.');
    }
    // Pre-production is due before the start: say so when that is already behind us.
    if (best.start && !produced) {
      const done: Record<MilestoneKey, string | null> = {
        fabric: candidate.fabricReceivedAt, cutting: candidate.cuttingDoneAt, accessories: candidate.accessoriesReceivedAt,
      };
      const past = MILESTONES
        .filter((k) => !done[k])
        .map((k) => ({ k, due: addDays(best.start!, -MILESTONE_LEAD_DAYS[k]) }))
        .filter((m) => m.due < asOf);
      if (past.length) {
        warnings.push(`For a ${fmtDay(best.start)} start, ${past.map((m) => `${MILESTONE_LABEL[m.k].toLowerCase()} was due ${fmtDay(m.due)}`).join(' and ')}`
          + ' - already past. Plan this start only if they are in hand; production stays locked until all three are ticked.');
      }
    }
  }
  return { best, ranked, warnings, realisticDate, styleNo, family };
}
