// Run with: npm test
// The Assistant: what the board learns from the days logged, what it raises,
// and what it answers. Nothing here touches the network or the database.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ask } from '../src/assistant';
import {
  forecast, learned, lineStats, performance, rampUp, suggestions, whenPhrase,
  type Board,
} from '../src/insights';
import { planBoard, type Entry, type IdleDay, type Order, type Settings } from '../src/planning';

const S: Settings = { workDaysPerWeek: 6 };
const AS_OF = '2026-09-01'; // a Tuesday

let nextId = 1;
const order = (o: Partial<Order>): Order => ({
  id: nextId++, orderNo: 'ORD-2026-001', lineNo: 1, styleNo: 'ST/1', colour: '', orderQty: 10000,
  unit: 'Pcs', planningDate: '2026-08-01', requiredDate: '2026-09-30', notes: '',
  fabricReceivedAt: '2026-07-01T06:00:00Z', cuttingDoneAt: '2026-07-20T06:00:00Z',
  accessoriesReceivedAt: '2026-07-20T06:00:00Z', packedAt: null, ...o,
});
const entry = (orderId: number, entryDate: string, qty: number): Entry =>
  ({ id: nextId++, entryNo: `LOG-${nextId}`, orderId, entryDate, qty, shift: 'Day', remarks: '' });

function board(orders: Order[], entries: Entry[], idle: IdleDay[] = [], asOf = AS_OF): Board {
  return { orders, entries, plans: planBoard(orders, entries, S, asOf, idle), idle, settings: S, asOf, today: asOf };
}
const kinds = (b: Board) => suggestions(b).map((s) => s.kind);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmt = (d: string) => `${d.slice(8, 10)} ${MON[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;
const find = (b: Board, kind: string) => suggestions(b).find((s) => s.kind === kind);

// --- what a run of days says about itself ----------------------------------

test('performance: the average, the best and worst day, and which way it is going', () => {
  const days = [400, 500, 600, 700, 800, 900].map((qty, i) => ({ date: `2026-08-2${i + 1}`, qty }));
  const p = performance(days);
  assert.equal(p.daysWorked, 6);
  assert.equal(p.produced, 3900);
  assert.equal(p.avgPerDay, 650);
  assert.deepEqual([p.bestDay!.qty, p.worstDay!.qty], [900, 400]);
  assert.equal(p.trend, 'rising');                       // the last half beats the first
  assert.equal(performance([...days].reverse().map((d, i) => ({ ...d, date: `2026-08-2${i + 1}` }))).trend, 'falling');
  assert.equal(performance(days.map((d) => ({ ...d, qty: 650 }))).trend, 'steady');
  assert.equal(performance([]).daysWorked, 0);
  assert.equal(performance([{ date: '2026-08-21', qty: 500 }]).trend, null); // one day is not a trend
  // A steady line swings less than a wild one.
  assert.equal(performance(days.map((d) => ({ ...d, qty: 650 }))).swing, 0);
  assert.equal(p.swing! > 0.2, true);
});

test('each line keeps its own record, and a line that never ran says so', () => {
  const a = order({ orderNo: 'A', lineNo: 2, orderQty: 5000 });
  const c = order({ orderNo: 'C', lineNo: 7, orderQty: 5000 });
  const es = [entry(a.id, '2026-08-27', 1000), entry(a.id, '2026-08-28', 1400), entry(c.id, '2026-08-28', 600)];
  const lines = lineStats([a, c], es);
  assert.equal(lines.length, 10);
  assert.equal(lines[1].lineNo, 2);
  assert.equal(lines[1].avgPerDay, 1200);
  assert.equal(lines[1].bestDay!.qty, 1400);
  assert.equal(lines[1].orders, 1);
  assert.equal(lines[6].avgPerDay, 600);
  assert.equal(lines[0].daysWorked, 0);                  // Line 1 has never run
  assert.equal(lines[0].avgPerDay, null);
});

test('the build-up curve is learned from every order that has run', () => {
  const a = order({ orderNo: 'A', orderQty: 9999 });
  const c = order({ orderNo: 'C', lineNo: 2, orderQty: 9999 });
  const es = [
    entry(a.id, '2026-08-24', 500), entry(a.id, '2026-08-25', 750), entry(a.id, '2026-08-26', 1000),
    entry(c.id, '2026-08-24', 300), entry(c.id, '2026-08-25', 450), entry(c.id, '2026-08-26', 600),
  ];
  const ramp = rampUp([a, c], es);
  assert.equal(ramp[0].day, 1);
  assert.equal(ramp[0].sample, 2);
  assert.equal(Math.round(ramp[0].share * 100), 50);     // day one is half of the best day
  assert.equal(Math.round(ramp[1].share * 100), 75);
  assert.equal(Math.round(ramp[2].share * 100), 100);
  assert.equal(rampUp([a], [entry(a.id, '2026-08-24', 500)]).length, 0); // one day tells nothing
});

test('a forecast is the plan, its best day and its worst day', () => {
  const o = order({ orderQty: 10000, requiredDate: '2026-09-30' });
  const es = [entry(o.id, '2026-08-27', 500), entry(o.id, '2026-08-28', 1500), entry(o.id, '2026-08-29', 1000)];
  const b = board([o], es);
  const f = forecast(o, es, b.plans.get(o.id)!, S, [], AS_OF)!;
  assert.equal(f.likely!.pace, 1000);                    // the plan's own average
  assert.equal(f.optimistic!.pace, 1500);
  assert.equal(f.cautious!.pace, 500);
  assert.equal(f.optimistic!.date < f.likely!.date, true);
  assert.equal(f.cautious!.date > f.likely!.date, true);
  assert.equal(forecast(o, [], b.plans.get(o.id)!, S, [], AS_OF), null); // nothing logged, nothing to forecast
});

// --- what it raises --------------------------------------------------------

test('a tidy board raises nothing but the lines standing empty', () => {
  const o = order({ orderNo: 'CALM', orderQty: 3000, requiredDate: '2026-10-31', planningDate: '2026-08-20' });
  const es = [entry(o.id, '2026-08-31', 1000), entry(o.id, '2026-09-01', 1000)];
  const b = board([o], es);
  assert.deepEqual(kinds(b), ['idle-capacity']);            // nothing is wrong; 9 lines hold nothing
  const s = find(b, 'idle-capacity')!;
  assert.equal(s.severity, 'watch');
  assert.match(s.title, /9 lines have nothing booked/);
  assert.match(s.detail, /Line 2, Line 3/);
});

test('open orders asking for more a day than the factory has ever made is raised once', () => {
  const o = order({ orderNo: 'HUGE', lineNo: 5, orderQty: 90000, requiredDate: '2026-10-31' });
  const es = [500, 600, 550, 500].map((q, i) => entry(o.id, `2026-08-2${5 + i}`, q)); // about 540 a day
  const b = board([o], es);
  const s = find(b, 'capacity-short')!;
  assert.match(s.title, /open orders need \d+% more a day than the factory has averaged/);
  assert.match(s.detail, /1 open order need[s]? [\d,]+ a day/);
  assert.match(s.detail, /averaged 538 a day over 4 worked days/);
  assert.equal(s.page, '/');
  // A factory keeping up is not told it is behind.
  const easy = order({ orderNo: 'EASY', lineNo: 5, orderQty: 3000, requiredDate: '2026-12-31' });
  assert.equal(find(board([easy], [entry(easy.id, '2026-08-31', 900), entry(easy.id, '2026-09-01', 900)]), 'capacity-short'), undefined);
});

test('an order that will miss its date says by how much, and what it would take', () => {
  const o = order({ orderNo: 'SLOW', orderQty: 20000, requiredDate: '2026-09-10' });
  const es = [entry(o.id, '2026-08-31', 500), entry(o.id, '2026-09-01', 500)];
  const b = board([o], es);
  const s = find(b, 'will-miss-date')!;
  assert.equal(s.severity, 'urgent');
  assert.match(s.title, /SLOW \(ST\/1\) will miss 10 Sep 2026 by \d+ days/);
  assert.match(s.detail, /19,000 left at 500 a day/);
  assert.match(s.detail, /needs 2,375 a day/);            // 19,000 over the 8 working days left
  assert.equal(s.orderId, o.id);
  assert.equal(s.page, '/orders');
});

test('production blocked: the start day is here and a tick is missing', () => {
  const o = order({ orderNo: 'LOCKED', orderQty: 2000, requiredDate: '2026-09-12', planningDate: '2026-08-25', cuttingDoneAt: null });
  const b = board([o], []);
  const s = find(b, 'production-blocked')!;
  assert.match(s.title, /LOCKED .* cannot start: Cutting not ticked/);
  assert.equal(s.page, '/pre-production');
  // Ticked, and the same order raises nothing about being blocked.
  assert.equal(find(board([{ ...o, cuttingDoneAt: '2026-08-20T06:00:00Z' }], []), 'production-blocked'), undefined);
});

test('a milestone past its due date is urgent, and fabric is judged 25 days before the start', () => {
  const o = order({ orderNo: 'FAB', orderQty: 5000, requiredDate: '2026-09-20', planningDate: '2026-09-05', fabricReceivedAt: null });
  const b = board([o], []);
  const s = find(b, 'milestone-late') ?? find(b, 'milestone-due')!;
  assert.match(s.title, /Fabric received/);
  assert.equal(s.page, '/pre-production');
  const expected = b.plans.get(o.id)!.preProduction.fabric.expected!;
  assert.equal(expected < b.plans.get(o.id)!.startDate!, true);
});

test('each missing tick is given its own due date - fabric weeks before cutting and accessories', () => {
  // Starts about 10 Sep: fabric was due ~16 Aug (25 days before), cutting and accessories ~3 Sep (7 days before) - all past.
  const o = order({ orderNo: 'ALL3', orderQty: 4000, planningDate: '2026-09-11', requiredDate: '2026-09-20',
    fabricReceivedAt: null, cuttingDoneAt: null, accessoriesReceivedAt: null });
  const b = board([o], [], [], '2026-09-06');
  const p = b.plans.get(o.id)!.preProduction;
  const s = find(b, 'milestone-late')!;
  assert.notEqual(p.fabric.expected, p.cutting.expected);
  assert.ok(s.detail.includes(`Fabric received was due ${fmt(p.fabric.expected!)}`), s.detail);
  assert.ok(s.detail.includes(`Cutting and Accessories were due ${fmt(p.cutting.expected!)}`), s.detail);
});

test('a target no line has ever reached is called optimistic, with the line record behind it', () => {
  const runner = order({ orderNo: 'PAST', lineNo: 3, orderQty: 6000, requiredDate: '2026-09-30' });
  const es = [800, 900, 700, 850].map((q, i) => entry(runner.id, `2026-08-2${4 + i}`, q)); // Line 3 averages 812
  const hungry = order({ orderNo: 'BIG', lineNo: 3, orderQty: 60000, requiredDate: '2026-10-31', planningDate: '2026-09-01' });
  const b = board([runner, hungry], es);
  const s = suggestions(b).find((x) => x.kind === 'target-optimistic' && x.orderNo === 'BIG')!;
  assert.match(s.title, /BIG .* needs \d+% more than Line 3 has averaged/);
  assert.match(s.detail, /Line 3 has averaged 813 a day over 4 worked days/);
  assert.equal(s.lineNo, 3);
});

test('a free line that would start a queued order earlier is offered, never taken', () => {
  const running = order({ orderNo: 'RUN', lineNo: 4, orderQty: 30000, requiredDate: '2026-12-31' });
  const es = [600, 700, 650].map((q, i) => entry(running.id, `2026-08-2${6 + i}`, q));
  const waiting = order({ orderNo: 'WAIT', lineNo: 4, orderQty: 3000, requiredDate: '2026-11-30', planningDate: '2026-09-01' });
  const b = board([running, waiting], es);
  const s = find(b, 'line-idle')!;
  assert.match(s.title, /WAIT could start \d+ days earlier on Line \d+/);
  assert.match(s.advice, /Drag it to Line \d+ on the Line calendar/);   // advice only
  assert.notEqual(s.lineNo, 4);
  assert.equal(s.orderId, waiting.id);
});

test('packing is raised once an order is finished, and dropped once it is ticked', () => {
  const o = order({ orderNo: 'DONE', orderQty: 2000, requiredDate: '2026-09-30' });
  const es = [entry(o.id, '2026-08-27', 1000), entry(o.id, '2026-08-28', 1000)];
  assert.equal(find(board([o], es), 'packing-due')!.severity, 'soon');            // due 1 Sep, and today is 1 Sep
  assert.equal(find(board([o], es, [], '2026-09-05'), 'packing-due')!.severity, 'urgent'); // four days past it
  assert.match(find(board([o], es, [], '2026-09-05'), 'packing-due')!.title, /past its packing date/);
  assert.equal(find(board([{ ...o, packedAt: '2026-08-31T06:00:00Z' }], es), 'packing-due'), undefined);
});

test('whenPhrase reads the way a person would say it', () => {
  assert.equal(whenPhrase('2026-09-01', '2026-09-01'), 'today');
  assert.equal(whenPhrase('2026-09-01', '2026-09-02'), 'tomorrow');
  assert.equal(whenPhrase('2026-09-01', '2026-08-31'), 'yesterday');
  assert.equal(whenPhrase('2026-09-01', '2026-09-08'), 'in 7 days');
  assert.equal(whenPhrase('2026-09-01', '2026-08-25'), '7 days ago');
});

// --- what it answers -------------------------------------------------------

/** A board with a bit of everything: one running, one late, one waiting, one done. */
function busyBoard() {
  nextId = 500;
  const run = order({ orderNo: 'ORD-2026-011', lineNo: 4, styleNo: 'OR51/99', orderQty: 20000, requiredDate: '2026-10-31' });
  const late = order({ orderNo: 'ORD-2026-012', lineNo: 6, styleNo: 'OR99/102', orderQty: 30000, requiredDate: '2026-09-15' });
  const soon = order({ orderNo: 'ORD-2026-013', lineNo: 2, styleNo: 'ZZ/7', orderQty: 4000, requiredDate: '2026-11-30', planningDate: '2026-09-01' });
  const done = order({ orderNo: 'ORD-2026-008', lineNo: 9, styleNo: 'OR51/99', orderQty: 2000, requiredDate: '2026-09-30' });
  const es = [
    entry(run.id, '2026-08-27', 900), entry(run.id, '2026-08-28', 1100), entry(run.id, '2026-08-31', 1000),
    entry(late.id, '2026-08-31', 400), entry(late.id, '2026-09-01', 600),
    entry(done.id, '2026-08-26', 1200), entry(done.id, '2026-08-27', 800),
  ];
  return board([run, late, soon, done], es);
}

test('an order is recognised however it is typed', () => {
  const b = busyBoard();
  for (const q of ['How is ORD-2026-011 doing?', 'how is ord 2026 011', 'status of 011', 'tell me about order 11']) {
    const a = ask(q, b);
    assert.equal(a.intent, 'order-status', q);
    assert.match(a.headline, /ORD-2026-011/, q);
  }
  // The style number finds it too.
  assert.match(ask('what pace is OR51/99 running at', b).headline, /a day/);
});

test('when will it finish: the plan, with the range its own days allow', () => {
  const b = busyBoard();
  const a = ask('When will ORD-2026-011 finish?', b);
  assert.equal(a.intent, 'order-finish');
  const p = b.plans.get(b.orders[0].id)!;
  assert.match(a.headline, new RegExp(p.projectedFinish!.slice(8, 10)));  // the plan's own date
  assert.match(a.lines.join(' '), /At its best day \(1,100\).*at its slowest \(900\)/);
  assert.equal(a.confidence, 'exact');
});

test('what is late lists the orders that will not make their date', () => {
  const b = busyBoard();
  const a = ask('what is late?', b);
  assert.equal(a.intent, 'late');
  assert.match(a.headline, /order/);
  assert.match(a.table!.rows.map((r) => r[0]).join(','), /ORD-2026-012/);
  // and it agrees with the board
  const behind = [...b.plans.values()].filter((p) => p.status === 'BEHIND SCHEDULE' || p.status === 'AT RISK').length;
  assert.equal(a.table!.rows.length, behind);
});

test('which lines are free, and when the busy ones come back', () => {
  const b = busyBoard();
  const a = ask('which lines are free?', b);
  assert.equal(a.intent, 'lines-free');
  assert.equal(a.table!.rows.length, 10);
  assert.match(a.headline, /free now|Every line is busy/);
  // Line 4 is running ORD-2026-011, so it is not offered as free.
  assert.equal(/Line 4\b/.test(a.headline.split(':')[1] ?? ''), false);
});

test('one line: what it is running, what it has averaged and what is queued', () => {
  const b = busyBoard();
  const a = ask('what is line 4 doing', b);
  assert.equal(a.intent, 'line-status');
  assert.match(a.headline, /Line 4 is running ORD-2026-011/);
  assert.match(a.lines.join(' '), /1,000 a day/);       // (900 + 1,100 + 1,000) / 3
});

test('production over a period, and for one line', () => {
  const b = busyBoard();
  const today = ask('how much did we make today?', b);
  assert.equal(today.intent, 'production');
  assert.match(today.headline, /600 pcs/);               // only ORD-2026-012 logged on 1 Sep
  const week = ask('how much did we make this week?', b);
  assert.match(week.headline, /this week/);
  const line = ask('how much did line 4 make in the last 7 days?', b);
  assert.match(line.headline, /on Line 4/);
  assert.match(line.headline, /3,000 pcs/);
});

test('where to put a new order: only lines that are really free, best first', () => {
  const b = busyBoard();
  const a = ask('where can I put 5,000 pieces by 20 Dec?', b);
  assert.equal(a.intent, 'place');
  assert.equal(a.table!.rows.length, 10);
  assert.match(a.headline, /5,000 pcs by 20 Dec 2026/);
  assert.match(a.lines.join(' '), /would need [\d,]+ a day over the \d+ working days between now and then/);
  // A busy line is quoted the day it really comes free - the last of its bookings, not the first.
  const busy = a.table!.rows.find((r) => r[1].startsWith('busy until'))!;
  assert.match(busy[1], /busy until \d{1,2} \w{3}/);
});

test('what needs attention hands back the same list the page shows', () => {
  const b = busyBoard();
  const a = ask('what needs my attention?', b);
  assert.equal(a.intent, 'advice');
  assert.equal(a.suggestions!.length, suggestions(b).length);
  assert.equal(a.suggestions![0].severity, 'urgent');
});

test('what it has learned is drawn from the logged days, and says so', () => {
  const b = busyBoard();
  const a = ask('what have you learned?', b);
  assert.equal(a.intent, 'learned');
  const l = learned(b);
  assert.match(a.headline, new RegExp(`${l.basis.workedDays} worked days`));
  assert.match(a.lines.join(' '), /Factory average [\d,]+ a day/);
});

test('a question it cannot place says so, and offers the ones it knows', () => {
  const b = busyBoard();
  const a = ask('what is the weather in Kolkata tomorrow', b);
  assert.equal(a.intent, 'none');
  assert.equal(a.confidence, 'none');
  assert.match(a.headline, /could not place/);
  assert.equal(a.followUps.length > 0, true);
  assert.equal(ask('   ', b).intent, 'none');
});

test('every answer carries what it understood, so a wrong reading is obvious', () => {
  const b = busyBoard();
  for (const q of ['what is late?', 'which lines are free?', 'how is ORD-2026-011 doing?', 'what needs my attention?']) {
    const a = ask(q, b);
    assert.equal(typeof a.understood, 'string');
    assert.equal(a.understood.length > 0, true, q);
    assert.equal(a.headline.length > 0, true, q);
  }
});

test('an order with no line or date yet is raised, never given pre-production dates, and the status says so', () => {
  const o = order({ orderNo: 'ORD-2026-020', lineNo: null, planningDate: null, styleNo: 'OR675/12', orderQty: 6000,
    requiredDate: '2026-10-31', fabricReceivedAt: null, cuttingDoneAt: null, accessoriesReceivedAt: null });
  const b = board([o], []);
  const s = find(b, 'not-scheduled')!;
  assert.equal(s.orderNo, 'ORD-2026-020');
  assert.match(s.title, /is not scheduled yet/);
  assert.match(s.detail, /No Line and no Expected Scheduling Date/);
  assert.match(s.advice, /drag it onto the Line calendar/);
  // Nothing about pre-production being late or due: there is no start date to count back from.
  assert.equal(kinds(b).some((k) => k.startsWith('milestone') || k === 'production-blocked'), false);
  const a = ask('how is ORD-2026-020 doing?', b);
  assert.match(a.headline, /not scheduled yet/);
  assert.match(a.lines.join(' '), /fill in its Line and Expected Scheduling Date/);
  assert.equal(a.table!.rows.find((r) => r[0] === 'Expected scheduling date')![1], 'not set yet');
});
