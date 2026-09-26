// Run with: npm test
// The first three cases are the three orders in Factory_Sewing_Planning_System.xlsm
// as it was saved on 1 Sep 2026, so the web app can be checked against the sheet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nthWorkingDay, workingDayDiff, workingDaysBetween, weekday, isISODate,
} from '../src/dates';
import {
  buildCalendar, buildLineCalendar, dashboardKpis, entryRunningTotals, lineCheck, milestonesMissing, planBoard, planOrder,
  scheduleMissing, schedulingDateFor,
  type Entry, type IdleDay, type Order, type OrderPlan, type Settings,
} from '../src/planning';

const S: Settings = { workDaysPerWeek: 6 };
const AS_OF = '2026-09-01'; // a Tuesday

let nextId = 1;
const order = (o: Partial<Order>): Order => ({
  id: nextId++, orderNo: 'ORD', lineNo: 1, styleNo: '', colour: '', orderQty: 1000,
  unit: 'Pcs', planningDate: '2026-08-01', requiredDate: '2026-09-30', notes: '',
  fabricReceivedAt: null, cuttingDoneAt: null, accessoriesReceivedAt: null, packedAt: null, ...o,
});
const entry = (orderId: number, entryDate: string, qty: number, shift: Entry['shift'] = 'Day'): Entry =>
  ({ id: nextId++, entryNo: `LOG-${nextId}`, orderId, entryDate, qty, shift, remarks: '' });

// --- the workbook's own orders ---------------------------------------------

test('ORD-2026-007: pace is per DAY - 20,000 + 1,000 on one day is 21,000, not 10,500', () => {
  const o = order({ orderNo: 'ORD-2026-007', orderQty: 50000, planningDate: '2026-09-02', requiredDate: '2026-09-15' });
  const p = planOrder(o, [entry(o.id, '2026-09-01', 20000), entry(o.id, '2026-09-01', 1000)], S, AS_OF);
  assert.equal(p.produced, 21000);
  assert.equal(p.balance, 29000);
  assert.equal(p.pacePerDay, 21000);          // the sheet showed 10,500
  assert.equal(p.planFrom, '2026-09-02');     // today's output is in, so tomorrow
  assert.equal(p.daysNeeded, 2);              // ceil(29,000 / 21,000)
  assert.equal(p.projectedFinish, '2026-09-03'); // the sheet showed 4 Sep
  assert.equal(p.workingDaysLeft, 12);        // 2-15 Sep, Sundays off
  assert.equal(p.targetPerDay, 2417);         // ceil(29,000 / 12)
  assert.equal(p.bufferDays, 10);
  assert.equal(p.status, 'ON TRACK');
});

test('ORD-2026-008: two worked days average to 2,250 a day', () => {
  const o = order({ orderNo: 'ORD-2026-008', orderQty: 10000, planningDate: '2026-08-28', requiredDate: '2026-09-11' });
  const p = planOrder(o, [entry(o.id, '2026-09-01', 2500), entry(o.id, '2026-08-29', 2000)], S, AS_OF);
  assert.equal(p.pacePerDay, 2250);
  assert.equal(p.paceDaysUsed, 2);
  assert.equal(p.projectedFinish, '2026-09-04'); // same as the sheet
  assert.equal(p.targetPerDay, 612);             // ceil(5,500 / 9)
  assert.equal(p.bufferDays, 6);
  assert.equal(p.status, 'ON TRACK');
});

test('ORD-2026-009: one day of 18,000 finishes on 7 Sep, skipping Sunday', () => {
  const o = order({ orderNo: 'ORD-2026-009', orderQty: 100000, planningDate: '2026-09-01', requiredDate: '2026-09-11' });
  const p = planOrder(o, [entry(o.id, '2026-09-01', 18000)], S, AS_OF);
  assert.equal(p.daysNeeded, 5);
  assert.equal(p.projectedFinish, '2026-09-07'); // same as the sheet
  assert.equal(p.targetPerDay, 9112);            // ceil(82,000 / 9)
  assert.equal(p.status, 'ON TRACK');
});

// --- pace -----------------------------------------------------------------

test('pace averages EVERY worked day of the order, and ignores silent days', () => {
  const o = order({ orderQty: 100000 });
  const es = [
    entry(o.id, '2026-08-10', 1600), // weeks ago - still counts
    entry(o.id, '2026-08-24', 100),
    entry(o.id, '2026-08-25', 200),
    entry(o.id, '2026-08-27', 300), // 26th silent - not a zero
    entry(o.id, '2026-08-28', 400),
    entry(o.id, '2026-08-31', 500),
  ];
  const p = planOrder(o, es, S, AS_OF);
  assert.equal(p.paceDaysUsed, 6);
  assert.equal(p.pacePerDay, 3100 / 6);
  // A viewer who picks "last 3 worked days" gets 27, 28 and 31 Aug only.
  const last3 = planOrder(o, es, { ...S, paceDays: 3 }, AS_OF);
  assert.equal(last3.paceDaysUsed, 3);
  assert.equal(last3.pacePerDay, 400);
  // Asking for more days than exist just uses them all.
  assert.equal(planOrder(o, es, { ...S, paceDays: 14 }, AS_OF).pacePerDay, 3100 / 6);
});

test('pace adds Day, Night and Overtime together before averaging', () => {
  const o = order({ orderQty: 100000 });
  const p = planOrder(o, [
    entry(o.id, '2026-08-31', 600, 'Day'), entry(o.id, '2026-08-31', 400, 'Night'),
    entry(o.id, '2026-09-01', 700, 'Day'), entry(o.id, '2026-09-01', 300, 'Overtime'),
  ], S, AS_OF);
  assert.equal(p.pacePerDay, 1000);
  assert.equal(p.entryCount, 4);
  assert.equal(p.daysWorked, 2);
});

test('no pace before production starts or after it finishes', () => {
  const o = order({ orderQty: 1000 });
  assert.equal(planOrder(o, [], S, AS_OF).pacePerDay, null);
  const done = planOrder(o, [entry(o.id, '2026-08-31', 1000)], S, AS_OF);
  assert.equal(done.pacePerDay, null);
  assert.equal(done.targetPerDay, null);
  assert.equal(done.status, 'COMPLETED');
  assert.equal(done.projectedFinish, '2026-08-31'); // ends where it finished
});

// --- target per day and the plan window -----------------------------------

test('today still counts when its output has not been logged yet', () => {
  const o = order({ orderQty: 10000, requiredDate: '2026-09-05' });
  const p = planOrder(o, [entry(o.id, '2026-08-31', 1000)], S, AS_OF);
  assert.equal(p.planFrom, '2026-09-01');
  assert.equal(p.workingDaysLeft, 5); // Tue-Sat
  assert.equal(p.targetPerDay, 1800);
});

test('an order not yet started is planned from its planning date, not from today', () => {
  const o = order({ orderQty: 6000, planningDate: '2026-09-07', requiredDate: '2026-09-12' });
  const p = planOrder(o, [], S, AS_OF);
  assert.equal(p.status, 'NOT STARTED');
  assert.equal(p.planFrom, '2026-09-07');
  assert.equal(p.workingDaysLeft, 6);
  assert.equal(p.targetPerDay, 1000);
  assert.equal(p.projectedFinish, null);
});

test('nothing made and past its delivery date is BEHIND, not NOT STARTED', () => {
  const o = order({ orderQty: 5000, planningDate: '2026-08-01', requiredDate: '2026-08-31' });
  const p = planOrder(o, [], S, AS_OF);
  assert.equal(p.overdue, true);
  assert.equal(p.status, 'BEHIND SCHEDULE');
  assert.equal(p.targetPerDay, 5000); // no day left: all of it is needed now
});

test('running but past its delivery date is BEHIND even at a good pace', () => {
  const o = order({ orderQty: 5000, requiredDate: '2026-08-31' });
  const p = planOrder(o, [entry(o.id, '2026-08-31', 4000)], S, AS_OF);
  assert.equal(p.status, 'BEHIND SCHEDULE');
  assert.equal(p.bufferDays! < 0, true);
  assert.equal(p.targetPerDay, 1000); // the whole balance, never blank
});

test('AT RISK when finishing with one working day or less to spare', () => {
  const o = order({ orderQty: 3000, requiredDate: '2026-09-03' });
  const p = planOrder(o, [entry(o.id, '2026-08-31', 1000)], S, AS_OF); // needs 2 days: 1-2 Sep
  assert.equal(p.projectedFinish, '2026-09-02');
  assert.equal(p.bufferDays, 1);
  assert.equal(p.status, 'AT RISK');
});

test('an earlier as-of date does not see later production', () => {
  const o = order({ orderQty: 5000 });
  const p = planOrder(o, [entry(o.id, '2026-08-28', 1000), entry(o.id, '2026-09-01', 1000)], S, '2026-08-29');
  assert.equal(p.produced, 1000);
});

// --- idle days ---------------------------------------------------------------

const idle = (idleDate: string, portion: 0.5 | 1, lineNo: number | null = null): IdleDay =>
  ({ id: nextId++, idleDate, portion, lineNo, reason: '' });

test('a full idle day is lost time: the target rises and the finish moves out a day', () => {
  const o = order({ orderQty: 3000, requiredDate: '2026-09-05' });
  const es = [entry(o.id, '2026-08-31', 1000)];
  const before = planOrder(o, es, S, AS_OF);
  assert.equal(before.workingDaysLeft, 5);
  assert.equal(before.targetPerDay, 400);
  assert.equal(before.projectedFinish, '2026-09-02');

  const after = planOrder(o, es, S, AS_OF, [idle('2026-09-01', 1)]);
  assert.equal(after.planFrom, '2026-09-02');       // today is idle, so work resumes tomorrow
  assert.equal(after.workingDaysLeft, 4);
  assert.equal(after.targetPerDay, 500);
  assert.equal(after.projectedFinish, '2026-09-03');
});

test('a half idle day counts as half a working day', () => {
  const o = order({ orderQty: 3000, requiredDate: '2026-09-05' });
  const p = planOrder(o, [entry(o.id, '2026-08-31', 1000)], S, AS_OF, [idle('2026-09-01', 0.5)]);
  assert.equal(p.planFrom, '2026-09-01');           // half a day is still available
  assert.equal(p.workingDaysLeft, 4.5);
  assert.equal(p.targetPerDay, 445);                // ceil(2,000 / 4.5)
  assert.equal(p.projectedFinish, '2026-09-03');    // 500 on the half day, then 1,000 a day
  assert.equal(p.daysNeeded, 2.5);
});

test('idle marked for one line leaves every other line alone', () => {
  const o = order({ orderQty: 3000, requiredDate: '2026-09-05', lineNo: 3 });
  const es = [entry(o.id, '2026-08-31', 1000)];
  assert.equal(planOrder(o, es, S, AS_OF, [idle('2026-09-01', 1, 5)]).targetPerDay, 400);
  assert.equal(planOrder(o, es, S, AS_OF, [idle('2026-09-01', 1, 3)]).targetPerDay, 500);
});

test('marked for all lines and for this one, the larger portion wins', () => {
  const o = order({ orderQty: 3000, requiredDate: '2026-09-05', lineNo: 3 });
  const p = planOrder(o, [entry(o.id, '2026-08-31', 1000)], S, AS_OF,
    [idle('2026-09-01', 0.5), idle('2026-09-01', 1, 3)]);
  assert.equal(p.workingDaysLeft, 4);
});

test('pace counts a half idle day as half a day, so short output there is not "slow"', () => {
  const o = order({ orderQty: 100000 });
  const es = [entry(o.id, '2026-08-31', 1000), entry(o.id, '2026-09-01', 500)];
  assert.equal(planOrder(o, es, S, AS_OF).pacePerDay, 750);                              // no idle: plain average
  assert.equal(planOrder(o, es, S, AS_OF, [idle('2026-09-01', 0.5)]).pacePerDay, 1000);  // 1,500 / 1.5 days
});

test('idle days never turn a weekend into a working day', () => {
  const o = order({ orderQty: 2000, requiredDate: '2026-09-07' });
  const p = planOrder(o, [], S, '2026-09-05', [idle('2026-09-06', 0.5)]); // Sunday: already off
  assert.equal(p.workingDaysLeft, 2);                                      // Sat + Mon
});

test('the calendar shows idle days and each order\'s expected completion', () => {
  const o = order({ orderQty: 3000, requiredDate: '2026-09-05', lineNo: 3 });
  const es = [entry(o.id, '2026-08-31', 1000)];
  const idl = [idle('2026-09-01', 1), idle('2026-09-02', 0.5, 3)];
  const plans = new Map([[o.id, planOrder(o, es, S, AS_OF, idl)]]);
  const cal = buildCalendar([o], plans, es, S, AS_OF, AS_OF, idl);
  const at = (d: string) => cal.days.findIndex((x) => x.date === d);
  assert.equal(cal.days[at('2026-09-01')].idle, 1);     // all lines
  assert.equal(cal.days[at('2026-09-02')].idle, 0);     // only line 3, so not in the header
  assert.equal(cal.rows[0].idle[at('2026-09-01')], 1);
  assert.equal(cal.rows[0].idle[at('2026-09-02')], 0.5);
  assert.equal(cal.rows[0].projectedFinish, plans.get(o.id)!.projectedFinish);
  assert.equal(cal.rows[0].projectedFinish, '2026-09-04'); // 1 Sep idle, 2 Sep half: 500 + 1,000 + 500
});

// --- start date and pre-production -----------------------------------------------

/** A tick made at 11:00 local time on the given day. */
const tickedOn = (y: number, m: number, d: number) => new Date(y, m - 1, d, 11, 0).toISOString();

test('start date: the order at its target, run back from the required date, less 1 working day', () => {
  // 12,000 pcs, 7-19 Sep = 12 working days, so the target is 1,000 a day.
  const o = order({ orderQty: 12000, planningDate: '2026-09-07', requiredDate: '2026-09-19' });
  const p = planOrder(o, [], S, AS_OF);
  assert.equal(p.targetPerDay, 1000);
  assert.equal(p.startDays, 12);
  // 12 working days ending Sat 19 Sep begin Mon 7 Sep (Sundays off); one day of buffer makes it Sat 5 Sep.
  assert.equal(p.startDate, '2026-09-05');
});

test('fabric is expected 25 days before the start, cutting and accessories 7 days before', () => {
  const o = order({ orderQty: 12000, planningDate: '2026-09-07', requiredDate: '2026-09-19' });
  const pp = planOrder(o, [], S, AS_OF).preProduction; // start 5 Sep, today 1 Sep
  assert.equal(pp.fabric.expected, '2026-08-11');
  assert.equal(pp.cutting.expected, '2026-08-29');
  assert.equal(pp.accessories.expected, '2026-08-29');
  assert.deepEqual([pp.fabric.state, pp.fabric.days], ['overdue', -21]); // not ticked, 21 days past
  assert.deepEqual([pp.cutting.state, pp.cutting.days], ['overdue', -3]);
  assert.equal(pp.overall, 'delayed');
  assert.equal(pp.delayDays, 21);
});

test('a ticked milestone reads as days early or late against its expected date', () => {
  const o = order({
    orderQty: 12000, planningDate: '2026-09-07', requiredDate: '2026-09-19',
    fabricReceivedAt: tickedOn(2026, 8, 9),     // expected 11 Aug
    cuttingDoneAt: tickedOn(2026, 8, 31),       // expected 29 Aug
    accessoriesReceivedAt: tickedOn(2026, 8, 29),
  });
  const pp = planOrder(o, [], S, AS_OF).preProduction;
  assert.deepEqual([pp.fabric.doneOn, pp.fabric.state, pp.fabric.days], ['2026-08-09', 'early', 2]);
  assert.deepEqual([pp.cutting.state, pp.cutting.days], ['late', -2]);
  assert.deepEqual([pp.accessories.state, pp.accessories.days], ['on-time', 0]);
  assert.equal(pp.overall, 'ready');   // all three done
  assert.equal(pp.delayDays, 2);        // cutting came 2 days late
});

test('a milestone not yet due shows the days still to go', () => {
  const o = order({ orderQty: 5000, planningDate: '2026-10-21', requiredDate: '2026-10-30' });
  const pp = planOrder(o, [], S, AS_OF).preProduction;
  assert.equal(pp.fabric.state, 'due');
  assert.equal(pp.fabric.days! > 0, true);
  assert.equal(pp.overall, 'on-schedule');
});

test('a finished order has no start date to plan against', () => {
  const o = order({ orderQty: 1000 });
  const p = planOrder(o, [entry(o.id, '2026-08-31', 1000)], S, AS_OF);
  assert.equal(p.startDate, null);
  assert.equal(p.preProduction.fabric.state, 'none');
});

test('the start-date run skips idle days: a half idle day only counts half', () => {
  const o = order({ orderQty: 3000, planningDate: '2026-09-01', requiredDate: '2026-09-05' });
  const plain = planOrder(o, [], S, AS_OF);          // 1-5 Sep = 5 days, target 600, run of 5 days from Tue 1 Sep
  assert.equal(plain.startDate, '2026-08-31');
  const idled = planOrder(o, [], S, AS_OF, [idle('2026-09-03', 0.5)]); // 4.5 days, target 667, run 4.5 days
  assert.equal(idled.targetPerDay, 667);
  assert.equal(idled.startDate, '2026-08-31');
});

// --- lines: bookings, the queue, the line check ---------------------------------

// Line 1 today (Tue 1 Sep): A has made 1,000 of 10,000, at 1,000 a day. The
// other 9,000 take 1-10 Sep (Sunday off), so A holds line 1 from 31 Aug to 10 Sep.
const lineA = () => {
  const a = order({ orderNo: 'A', lineNo: 1, orderQty: 10000, planningDate: '2026-08-31', requiredDate: '2026-09-30' });
  return { a, es: [entry(a.id, '2026-08-31', 1000)] };
};
// B: 6,000 wanted by Wed 30 Sep, planned from Mon 7 Sep - 21 working days, target 286,
// start date Sat 5 Sep (7 Sep less the buffer day).
const orderB = (lineNo = 1) =>
  order({ orderNo: 'B', lineNo, orderQty: 6000, planningDate: '2026-09-07', requiredDate: '2026-09-30' });

test('an order not started books its line from its start date to its required date', () => {
  const b = orderB();
  const p = planOrder(b, [], S, AS_OF);
  assert.equal(p.targetPerDay, 286);
  assert.equal(p.startDate, '2026-09-05');
  assert.deepEqual([p.bookStart, p.bookEnd], ['2026-09-05', '2026-09-30']);
});

test('a running order books its line to its expected completion: slower pace, longer booking', () => {
  const { a, es } = lineA();
  const p = planOrder(a, es, S, AS_OF);
  assert.deepEqual([p.bookStart, p.bookEnd], ['2026-08-31', '2026-09-10']);
  const fast = planOrder(a, [entry(a.id, '2026-08-31', 3000)], S, AS_OF); // 7,000 left at 3,000 a day
  assert.equal(fast.bookEnd, '2026-09-03');
});

test('a finished order holds its line from its first to its last production day', () => {
  const o = order({ orderQty: 2000 });
  const p = planOrder(o, [entry(o.id, '2026-08-27', 1000), entry(o.id, '2026-08-29', 1000)], S, AS_OF);
  assert.deepEqual([p.bookStart, p.bookEnd], ['2026-08-27', '2026-08-29']);
});

test('nothing made and past its date: it can only begin now, so it holds just today', () => {
  const o = order({ orderQty: 5000, planningDate: '2026-08-01', requiredDate: '2026-08-31' });
  const p = planOrder(o, [], S, AS_OF);
  assert.deepEqual([p.bookStart, p.bookEnd], [AS_OF, AS_OF]);
});

test('queue: an order waits for the line - its start, target and pre-production dates move', () => {
  const { a, es } = lineA();
  const b = orderB(1);
  const plans = planBoard([a, b], es, S, AS_OF);
  const pb = plans.get(b.id)!;
  // A holds line 1 until Thu 10 Sep, so B starts Fri 11 Sep (buffer day) and is planned from Sat 12 Sep.
  assert.equal(pb.waitingFor, 'A');
  assert.equal(pb.startDate, '2026-09-11');
  assert.equal(pb.planFrom, '2026-09-12');
  assert.equal(pb.targetPerDay, 375);                     // 6,000 over 16 working days instead of 21
  assert.equal(pb.preProduction.fabric.expected, '2026-08-17'); // 25 days before the new start
  assert.deepEqual([pb.bookStart, pb.bookEnd], ['2026-09-11', '2026-09-30']);
  assert.equal(plans.get(a.id)!.waitingFor, null);
});

test('queue: a faster pace frees the line sooner and the next order keeps its own dates', () => {
  const { a } = lineA();
  const b = orderB(1);
  const plans = planBoard([a, b], [entry(a.id, '2026-08-31', 3000)], S, AS_OF); // A done by 3 Sep
  assert.equal(plans.get(b.id)!.waitingFor, null);
  assert.equal(plans.get(b.id)!.startDate, '2026-09-05');
});

test('queue: orders on different lines never wait for each other', () => {
  const { a, es } = lineA();
  const b = orderB(2);
  const pb = planBoard([a, b], es, S, AS_OF).get(b.id)!;
  assert.equal(pb.waitingFor, null);
  assert.equal(pb.startDate, '2026-09-05');
});

test('queue: two orders both logged on one line at once are flagged, not moved', () => {
  const a = order({ orderNo: 'A', lineNo: 4, orderQty: 5000 });
  const b = order({ orderNo: 'B', lineNo: 4, orderQty: 5000 });
  const plans = planBoard([a, b], [entry(a.id, '2026-08-31', 1000), entry(b.id, '2026-08-31', 1000)], S, AS_OF);
  assert.deepEqual(plans.get(a.id)!.overlaps, ['B']);
  assert.deepEqual(plans.get(b.id)!.overlaps, ['A']);
});

test('line check: a clash is refused, with the day that line is free and the lines free now', () => {
  const { a, es } = lineA();
  const other = orderB(2);                 // holds line 2 from 5 to 30 Sep
  const c = { ...orderB(1), orderNo: 'C' }; // wants line 1 for 5-30 Sep
  const r = lineCheck(c, [], [a, other], es, S, AS_OF);
  const line1 = r.lines.find((l) => l.lineNo === 1)!;
  assert.equal(line1.free, false);
  assert.deepEqual(line1.clashes.map((x) => [x.orderNo, x.start, x.end]), [['A', '2026-08-31', '2026-09-10']]);
  assert.deepEqual(line1.suggest, {
    planningDate: '2026-09-12', startDate: '2026-09-11', bookStart: '2026-09-11', bookEnd: '2026-09-30',
    targetPerDay: 375, late: false,
  });
  // Line 2 is taken until its required date, so there it could only begin after it.
  const line2 = r.lines.find((l) => l.lineNo === 2)!;
  assert.equal(line2.free, false);
  assert.equal(line2.suggest!.late, true);
  assert.equal(line2.suggest!.planningDate, '2026-10-01');
  assert.deepEqual(r.lines.filter((l) => l.free).map((l) => l.lineNo), [3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(r.plan.startDate, '2026-09-05');
});

test('line check: planned at the day it suggests, the order fits', () => {
  const { a, es } = lineA();
  const c = { ...orderB(1), orderNo: 'C', planningDate: '2026-09-12' };
  const line1 = lineCheck(c, [], [a], es, S, AS_OF).lines[0];
  assert.equal(line1.free, true);
});

test('line check: an order already running cannot be moved back, so nothing is suggested', () => {
  const { a, es } = lineA();
  const c = order({ orderNo: 'C', lineNo: 1, orderQty: 5000 });
  const line1 = lineCheck(c, [entry(c.id, '2026-09-01', 500)], [a], es, S, AS_OF).lines[0];
  assert.equal(line1.free, false);
  assert.equal(line1.suggest, null);
});

test('line calendar: each day shows the order on the line and what was made', () => {
  const { a, es } = lineA();
  const b = orderB(1);
  const plans = planBoard([a, b], es, S, AS_OF);
  const cal = buildLineCalendar([a, b], plans, es, S, AS_OF, AS_OF);
  assert.equal(cal.rows.length, 10);
  assert.equal(cal.start, '2026-08-25');            // 7 days before the plan date
  const at = (d: string) => cal.days.findIndex((x) => x.date === d);
  const line1 = cal.rows[0];
  assert.deepEqual(line1.blocks.map((x) => [x.orderNo, x.kind, x.start, x.end]),
    [['A', 'running', '2026-08-31', '2026-09-10'], ['B', 'planned', '2026-09-11', '2026-09-30']]);
  assert.deepEqual(line1.cells[at('2026-08-31')], { orderId: a.id, clash: null, qty: 1000, late: false, start: true, parts: null });
  assert.deepEqual(line1.cells[at('2026-09-01')], { orderId: a.id, clash: null, qty: null, late: false, start: false, parts: null });
  assert.equal(line1.cells[at('2026-09-06')]!.orderId, a.id);      // Sunday: still A's
  assert.deepEqual([line1.cells[at('2026-09-11')]!.orderId, line1.cells[at('2026-09-11')]!.start], [b.id, true]);
  assert.equal(line1.cells[at('2026-10-01')], null);
  assert.equal(line1.current, a.id);
  assert.equal(line1.freeFrom, '2026-10-01');
  assert.equal(cal.rows[1].freeFrom, AS_OF);                       // line 2: nothing booked
  assert.equal(cal.totals[at('2026-08-31')], 1000);
});

test('line calendar: days a slow order runs past its required date are red, the rest green', () => {
  // 10,000 wanted by Sat 5 Sep; 1,000 made, at 1,000 a day it runs to Thu 10 Sep.
  const o = order({ orderNo: 'L', lineNo: 3, orderQty: 10000, requiredDate: '2026-09-05' });
  const es = [entry(o.id, '2026-08-31', 1000)];
  const plans = planBoard([o], es, S, AS_OF);
  const cal = buildLineCalendar([o], plans, es, S, AS_OF, AS_OF);
  const row = cal.rows[2];
  const late = cal.days.filter((_, i) => row.cells[i]?.late).map((d) => d.date);
  assert.deepEqual(late, ['2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10']);
  assert.equal(row.cells[cal.days.findIndex((d) => d.date === '2026-09-05')]!.late, false);
  // Faster: 5,000 a day finishes by 2 Sep - the line is free three days sooner and nothing is red.
  const fast = [entry(o.id, '2026-08-31', 5000)];
  const row2 = buildLineCalendar([o], planBoard([o], fast, S, AS_OF), fast, S, AS_OF, AS_OF).rows[2];
  assert.equal(row2.cells.some((c) => c?.late), false);
  assert.equal(row2.freeFrom, '2026-09-02');
});

test('line calendar: one order finishing and the next starting on the same day is a changeover, shared by output', () => {
  const a = order({ orderNo: 'A', lineNo: 1, orderQty: 2000, requiredDate: '2026-08-28' }); // finishes late
  const b = order({ orderNo: 'B', lineNo: 1, orderQty: 5000 });
  const es = [entry(a.id, '2026-08-27', 1000), entry(a.id, '2026-08-31', 1000), entry(b.id, '2026-08-31', 500)];
  const plans = planBoard([a, b], es, S, AS_OF);
  assert.deepEqual([plans.get(a.id)!.overlaps, plans.get(b.id)!.overlaps], [[], []]);
  const cal = buildLineCalendar([a, b], plans, es, S, AS_OF, AS_OF);
  const day = cal.rows[0].cells[cal.days.findIndex((d) => d.date === '2026-08-31')];
  // B starts that day; the day is shared 1,000 : 500, A's part red (past 28 Aug), B's green.
  assert.deepEqual(day, {
    orderId: b.id, clash: null, qty: 1500, late: false, start: true,
    parts: [{ orderId: a.id, qty: 1000, late: true }, { orderId: b.id, qty: 500, late: false }],
  });
  // An ordinary day with one order has no parts.
  assert.equal(cal.rows[0].cells[cal.days.findIndex((d) => d.date === '2026-08-27')]!.parts, null);
  // Seen on the changeover day itself, the line is on B - A is finished and no longer counts.
  const onDay = buildLineCalendar([a, b], planBoard([a, b], es, S, '2026-08-31'), es, S, '2026-08-31', '2026-08-31');
  assert.equal(onDay.rows[0].current, b.id);
});

test('line calendar: a line whose only order has finished is free', () => {
  const a = order({ orderNo: 'A', lineNo: 2, orderQty: 2000 });
  const es = [entry(a.id, '2026-08-31', 1000), entry(a.id, '2026-09-01', 1000)]; // done today
  const row = buildLineCalendar([a], planBoard([a], es, S, AS_OF), es, S, AS_OF, AS_OF).rows[1];
  assert.equal(row.current, null);
  assert.equal(row.freeFrom, AS_OF);
  assert.equal(row.blocks[0].kind, 'done'); // still drawn on the calendar
});

test('moving an order not started: the scheduling date that makes it start on the day it was dropped', () => {
  const b = orderB(1); // scheduled 7 Sep, start date 5 Sep, required 30 Sep
  const p = schedulingDateFor(b, S, AS_OF, [], '2026-09-12');
  assert.equal(p, '2026-09-14');                        // Mon: less the buffer day it starts Sat 12 Sep
  const moved = planOrder({ ...b, planningDate: p }, [], S, AS_OF);
  assert.equal(moved.startDate, '2026-09-12');
  assert.equal(moved.targetPerDay, 400);                // 6,000 over 15 working days - later start, higher target
  assert.equal(moved.preProduction.fabric.expected, '2026-08-18');
  assert.equal(moved.bookEnd, '2026-09-30');            // the required date does not move
  // Dropped on a Sunday it starts on the Monday; dropped earlier than before it moves earlier.
  assert.equal(planOrder({ ...b, planningDate: schedulingDateFor(b, S, AS_OF, [], '2026-09-13') }, [], S, AS_OF).startDate, '2026-09-14');
  assert.equal(planOrder({ ...b, planningDate: schedulingDateFor(b, S, AS_OF, [], '2026-09-03') }, [], S, AS_OF).startDate, '2026-09-03');
});

test('peak pace: the target for the first 4 days, then the best day so far - and it only ever rises', () => {
  const P: Settings = { ...S, paceMode: 'peak' };
  const o = order({ orderQty: 50000, requiredDate: '2026-09-30' });
  const days = [
    entry(o.id, '2026-08-24', 300), entry(o.id, '2026-08-25', 350), entry(o.id, '2026-08-26', 320), entry(o.id, '2026-08-27', 310),
  ];
  const four = planOrder(o, days, P, AS_OF);
  assert.equal(four.paceBasis, 'target');
  assert.equal(four.pacePerDay, four.targetPerDay);          // 4 days in: still the target
  assert.equal(four.projectedFinish, '2026-09-30');          // at the target it finishes on the required date
  const five = [...days, entry(o.id, '2026-08-28', 500)];
  assert.deepEqual([planOrder(o, five, P, AS_OF).paceBasis, planOrder(o, five, P, AS_OF).pacePerDay], ['peak', 500]);
  const six = [...five, entry(o.id, '2026-08-29', 400)];
  assert.equal(planOrder(o, six, P, AS_OF).pacePerDay, 500); // a lower day does not bring it down
  const seven = [...six, entry(o.id, '2026-08-31', 700)];
  assert.equal(planOrder(o, seven, P, AS_OF).pacePerDay, 700); // a better day raises it
  // Day + Night on one day count together, as for the rolling average.
  assert.equal(planOrder(o, [...seven, entry(o.id, '2026-08-31', 200, 'Night')], P, AS_OF).pacePerDay, 900);
  // The rolling average is untouched: every page but the Line calendar's Peak pace view uses it.
  assert.equal(planOrder(o, seven, S, AS_OF).paceBasis, 'average');
  assert.equal(planOrder(o, seven, S, AS_OF).pacePerDay, 2880 / 7);
});

test('peak pace moves the line booking: a better peak frees the line sooner', () => {
  const o = order({ orderNo: 'P', lineNo: 5, orderQty: 20000, requiredDate: '2026-10-30' });
  const es = [800, 900, 700, 600, 1000].map((q, i) => entry(o.id, `2026-08-2${4 + i}`, q)); // 24-28 Aug
  const rolling = planBoard([o], es, S, AS_OF).get(o.id)!;
  const peak = planBoard([o], es, { ...S, paceMode: 'peak' }, AS_OF).get(o.id)!;
  assert.equal(peak.pacePerDay, 1000);
  assert.equal(rolling.pacePerDay, 800);
  assert.equal(peak.bookEnd < rolling.bookEnd, true);
});

test('moving in the Peak pace view: the days that view frees can be taken, and the same date is saved either way', () => {
  const P: Settings = { ...S, paceMode: 'peak' };
  const run = order({ orderNo: 'RUN', lineNo: 5, orderQty: 20000, requiredDate: '2026-10-30' });
  const es = [800, 900, 700, 600, 1000].map((q, i) => entry(run.id, `2026-08-2${4 + i}`, q)); // 24-28 Aug
  assert.equal(planBoard([run], es, S, AS_OF).get(run.id)!.bookEnd, '2026-09-23'); // at 800 a day
  assert.equal(planBoard([run], es, P, AS_OF).get(run.id)!.bookEnd, '2026-09-18'); // at its best day, 1,000

  // Dropped on 21 Sep: free where the peak view shows the line free, still held by the rolling average.
  const next = order({ orderNo: 'NEXT', lineNo: 5, orderQty: 3000, requiredDate: '2026-12-31' });
  const planningDate = schedulingDateFor(next, P, AS_OF, [], '2026-09-21');
  assert.equal(planningDate, '2026-09-21');
  // An order not yet started has no pace of its own, so the date saved is the same in either view.
  assert.equal(schedulingDateFor(next, S, AS_OF, [], '2026-09-21'), planningDate);
  const moved = { ...next, planningDate };
  assert.equal(planOrder(moved, [], P, AS_OF).bookStart, '2026-09-22');
  assert.equal(lineCheck(moved, [], [run], es, P, AS_OF).lines[4].free, true);
  assert.equal(lineCheck(moved, [], [run], es, S, AS_OF).lines[4].free, false);
});

test('packing is due 4 days after the order is complete', () => {
  const done = order({ orderQty: 2000 });
  const des = [entry(done.id, '2026-08-27', 1000), entry(done.id, '2026-08-31', 1000)];
  const pk = planOrder(done, des, S, AS_OF).postProduction.packing;
  assert.deepEqual([pk.expected, pk.state, pk.days], ['2026-09-04', 'due', 3]);
  const packed = planOrder({ ...done, packedAt: tickedOn(2026, 9, 3) }, des, S, AS_OF).postProduction.packing;
  assert.deepEqual([packed.state, packed.days], ['early', 1]);
  // Still running: due 4 days after its expected completion, and that moves with the pace.
  const running = order({ orderQty: 5000 });
  const rp = planOrder(running, [entry(running.id, '2026-08-31', 1000)], S, AS_OF);
  assert.equal(rp.postProduction.packing.expected, '2026-09-08'); // finishes Fri 4 Sep + 4
  // Not started: nothing is due yet.
  assert.equal(planOrder(order({}), [], S, AS_OF).postProduction.packing.state, 'none');
});

test('production needs fabric, cutting and accessories all ticked', () => {
  const t = new Date().toISOString();
  assert.deepEqual(milestonesMissing(order({})), ['fabric', 'cutting', 'accessories']);
  assert.deepEqual(milestonesMissing(order({ fabricReceivedAt: t, accessoriesReceivedAt: t })), ['cutting']);
  assert.deepEqual(milestonesMissing(order({ fabricReceivedAt: t, cuttingDoneAt: t, accessoriesReceivedAt: t })), []);
});

// --- not scheduled: no line or no expected scheduling date yet (25 Sep 2026) ------

test('an order with no line or no scheduling date is not scheduled, and says what is missing', () => {
  assert.deepEqual(scheduleMissing(order({ lineNo: null, planningDate: null })), ['Line', 'Expected Scheduling Date']);
  assert.deepEqual(scheduleMissing(order({ lineNo: 4, planningDate: null })), ['Expected Scheduling Date']);
  assert.deepEqual(scheduleMissing(order({ lineNo: null })), ['Line']);
  assert.deepEqual(scheduleMissing(order({ lineNo: 4 })), []);
  const p = planOrder(order({ lineNo: 4, planningDate: null, orderQty: 2500, requiredDate: '2026-09-30' }), [], S, AS_OF);
  assert.equal(p.scheduled, false);
  assert.equal(p.status, 'NOT STARTED');
  assert.equal(p.startDate, null);                          // nothing to count pre-production back from
  assert.equal(p.preProduction.overall, 'none');
  assert.equal(p.preProduction.fabric.expected, null);
  assert.equal(p.targetPerDay, Math.ceil(2500 / 26));       // read as if it could start today: 1-30 Sep, Sundays off
  assert.equal(planOrder(order({ lineNo: 4 }), [], S, AS_OF).scheduled, true);
});

test('not scheduled: it books no line, so it clashes with nothing and nothing queues behind it', () => {
  const waiting = order({ orderNo: 'NOT-YET', lineNo: 3, planningDate: null, orderQty: 5000, requiredDate: '2026-10-30' });
  const nextOne = order({ orderNo: 'NEXT', lineNo: 3, planningDate: '2026-09-02', orderQty: 2000, requiredDate: '2026-09-30' });
  const plans = planBoard([waiting, nextOne], [], S, AS_OF);
  assert.equal(plans.get(nextOne.id)!.waitingFor, null);
  assert.deepEqual(plans.get(waiting.id)!.overlaps, []);
  // The line check for a new order on line 3 sees NEXT only.
  const cand = order({ id: 0, lineNo: 3, planningDate: '2026-09-02', orderQty: 1000, requiredDate: '2026-10-20' });
  const check = lineCheck(cand, [], [waiting, nextOne], [], S, AS_OF);
  assert.deepEqual(check.lines[2].clashes.map((c) => c.orderNo), ['NEXT']);
  // The line calendar leaves it off every line and lists it to be scheduled, with what it is missing.
  const cal = buildLineCalendar([waiting, nextOne], plans, [], S, AS_OF, AS_OF);
  assert.deepEqual(cal.rows[2].blocks.map((b) => b.orderNo), ['NEXT']);
  assert.deepEqual(cal.unscheduled.map((u) => [u.orderNo, u.missing]), [['NOT-YET', ['Expected Scheduling Date']]]);
});

test('dragged onto a line and a day, a not-scheduled order gets both - and then books its days', () => {
  const o = order({ orderNo: 'LATER', lineNo: null, planningDate: null, orderQty: 3000, requiredDate: '2026-10-31' });
  const placed = { ...o, lineNo: 6 };
  placed.planningDate = schedulingDateFor(placed, S, AS_OF, [], '2026-09-14');
  const p = planOrder(placed, [], S, AS_OF);
  assert.equal(p.scheduled, true);
  assert.equal(p.bookStart, '2026-09-14');
  assert.ok(p.preProduction.fabric.expected);
});

// --- working days ------------------------------------------------------------

test('working-day helpers follow the work week', () => {
  assert.equal(weekday('2026-09-06'), 7);                          // Sunday
  assert.equal(workingDaysBetween('2026-09-01', '2026-09-07', 6), 6);
  assert.equal(workingDaysBetween('2026-09-01', '2026-09-07', 5), 5); // Tue-Fri + Mon
  assert.equal(workingDaysBetween('2026-09-01', '2026-09-07', 7), 7);
  assert.equal(nthWorkingDay('2026-09-05', 2, 6), '2026-09-07');   // Sat, then Mon
  assert.equal(nthWorkingDay('2026-09-05', 1, 5), '2026-09-07');   // Sat is off in a 5-day week
  assert.equal(workingDayDiff('2026-09-04', '2026-09-08', 6), 3);  // Sat, Mon, Tue
  assert.equal(workingDayDiff('2026-09-08', '2026-09-04', 6), -3);
  assert.equal(isISODate('2026-02-30'), false);
});

// --- log, dashboard, calendar -----------------------------------------------

test('running totals in the log move row by row, even on the same day', () => {
  const o = order({ orderQty: 21000 });
  const a = entry(o.id, '2026-09-01', 20000);
  const b = entry(o.id, '2026-09-01', 1000);
  const c = entry(o.id, '2026-09-01', 500);
  const m = entryRunningTotals([o], [c, b, a]);
  assert.deepEqual(m.get(a.id), { cumulative: 20000, balanceAfter: 1000, flag: '' });
  assert.deepEqual(m.get(b.id), { cumulative: 21000, balanceAfter: 0, flag: 'ORDER COMPLETE' });
  assert.equal(m.get(c.id)!.flag, 'OVER by 500');
});

test('dashboard average per day uses worked days, like order pace', () => {
  const a = order({ orderQty: 50000 });
  const b = order({ orderQty: 10000 });
  const es = [entry(a.id, '2026-08-29', 2000), entry(a.id, '2026-09-01', 20000), entry(b.id, '2026-09-01', 1500)];
  const plans = new Map<number, OrderPlan>([[a.id, planOrder(a, es.filter((e) => e.orderId === a.id), S, AS_OF)],
    [b.id, planOrder(b, es.filter((e) => e.orderId === b.id), S, AS_OF)]]);
  const k = dashboardKpis([a, b], plans, es, AS_OF);
  assert.equal(k.workedDays, 2);
  assert.equal(k.avgPerDay, 11750); // 23,500 over 2 worked days
  const last1 = dashboardKpis([a, b], plans, es, AS_OF, { ...S, paceDays: 1 });
  assert.equal(last1.workedDays, 1);
  assert.equal(last1.avgPerDay, 21500); // 1 Sep only
  assert.equal(k.counts.total, 2);
  assert.equal(k.totalBalance, 60000 - 23500);
});

test('calendar colours each day against what the order needed that morning', () => {
  const o = order({ orderQty: 6000, requiredDate: '2026-09-02' });
  const es = [entry(o.id, '2026-08-31', 1000), entry(o.id, '2026-09-01', 2500), entry(o.id, '2026-09-03', 2500)];
  const plans = new Map([[o.id, planOrder(o, es, S, '2026-09-03')]]);
  const cal = buildCalendar([o], plans, es, S, '2026-09-03', '2026-09-03');
  assert.equal(cal.start, '2026-08-31');
  const cells = cal.rows[0].cells;
  assert.deepEqual(cells[0], { qty: 1000, needed: 2000, state: 'below' }); // 6000 over 31 Aug-2 Sep
  assert.deepEqual(cells[1], { qty: 2500, needed: 2500, state: 'met' });   // 5000 over 1-2 Sep
  assert.equal(cells[3]!.state, 'late');                                   // after 2 Sep
  assert.equal(cal.totals[1], 2500);
  assert.equal(cal.end, '2027-03-02'); // always 180 days past the plan date
  assert.equal(cal.days.length, 4 + 180); // 31 Aug - 2 Sep, the plan date, then 180 days
  assert.equal(cal.days.find((d) => d.date === '2026-09-05')!.working, true);
  const old = buildCalendar([o], plans, [...es, entry(o.id, '2024-01-01', 1)], S, '2026-09-03', '2026-09-03');
  assert.equal(old.start, '2025-09-02'); // never more than 366 days back, however old the log
  const picked = buildCalendar([o], plans, es, { ...S, calendarStart: '2026-08-15' }, '2026-09-03', '2026-09-03');
  assert.equal(picked.start, '2026-08-15'); // a viewer's chosen start
  const ancient = buildCalendar([o], plans, es, { ...S, calendarStart: '2020-01-01' }, '2026-09-03', '2026-09-03');
  assert.equal(ancient.start, '2025-09-02'); // still capped at a year
  const fiveDay = buildCalendar([o], plans, es, { ...S, workDaysPerWeek: 5 }, '2026-09-03', '2026-09-03');
  assert.equal(fiveDay.days.find((d) => d.date === '2026-09-05')!.working, false);
});
