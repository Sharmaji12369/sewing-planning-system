// Run with: npm test
// The advisor: which line an order should go on, judged by what each line has
// really made. And the AI's plumbing that can be checked without the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitOf, placementAdvice, styleFamily } from '../src/advisor';
import { AiError, askModel, boardBrief, cleanReply, isFollowUp, takeAiTurn, AI_PER_HOUR, wantsWriting } from '../src/ai';
import { planBoard, type Entry, type Order, type Settings } from '../src/planning';

const S: Settings = { workDaysPerWeek: 6 };
const AS_OF = '2026-09-01'; // a Tuesday

let nextId = 1;
const order = (o: Partial<Order>): Order => ({
  id: nextId++, orderNo: 'ORD', lineNo: 1, styleNo: '', colour: '', orderQty: 1000,
  unit: 'Pcs', planningDate: '2026-08-01', requiredDate: '2026-09-30', notes: '',
  fabricReceivedAt: '2026-07-01T06:00:00Z', cuttingDoneAt: '2026-07-20T06:00:00Z',
  accessoriesReceivedAt: '2026-07-20T06:00:00Z', packedAt: null, ...o,
});
const entry = (orderId: number, entryDate: string, qty: number): Entry =>
  ({ id: nextId++, entryNo: `LOG-${nextId}`, orderId, entryDate, qty, shift: 'Day', remarks: '' });
const days = (id: number, qtys: number[], from = 24) => qtys.map((q, i) => entry(id, `2026-08-${from + i}`, q));

/**
 * Line 2 has made style ST/9 at 1,000 a day; Line 5 averages 400; Line 3 is
 * busy with a long run to mid-October; every other line has never run.
 */
function factory() {
  const a = order({ orderNo: 'A', lineNo: 2, styleNo: 'ST/9', orderQty: 4000, requiredDate: '2026-08-31' });
  const b = order({ orderNo: 'B', lineNo: 5, orderQty: 1600, requiredDate: '2026-08-31' });
  const c = order({ orderNo: 'C', lineNo: 3, orderQty: 40000, requiredDate: '2026-10-31' });
  const es = [...days(a.id, [900, 1000, 1100, 1000]), ...days(b.id, [400, 400, 400, 400]), ...days(c.id, [800, 800])];
  return { orders: [a, b, c], entries: es };
}
const newOrder = (o: Partial<Order>) => order({
  id: 0, orderNo: 'NEW', lineNo: null, orderQty: 24000, planningDate: '2026-09-02', requiredDate: '2026-10-10',
  fabricReceivedAt: null, cuttingDoneAt: null, accessoriesReceivedAt: null, ...o,
});
const byLine = (adv: ReturnType<typeof placementAdvice>, n: number) => adv.ranked.find((r) => r.lineNo === n)!;

test('fit: comfortable, tight, stretch, beyond - and unknown with no record', () => {
  assert.equal(fitOf(1000, 1200, 1300), 'comfortable');   // 20% over the need
  assert.equal(fitOf(1000, 1050, 1300), 'tight');         // just over it
  assert.equal(fitOf(1000, 900, 1100), 'stretch');        // below on average, but its best day made it
  assert.equal(fitOf(1000, 900, 950), 'beyond');          // never made it in a day
  assert.equal(fitOf(1000, null, null), 'unknown');
});

test('the best line is the free one whose own record makes the target comfortably', () => {
  const { orders, entries } = factory();
  const adv = placementAdvice(newOrder({}), orders, entries, S, AS_OF);
  assert.equal(adv.best!.lineNo, 2);
  assert.equal(adv.best!.fit, 'comfortable');            // 1,000 a day against roughly 730 needed
  assert.equal(adv.best!.asEntered, true);
  assert.equal(adv.best!.spareDays! > 0, true);
  assert.match(adv.best!.reasons.join(' | '), /Free on the dates entered/);
  assert.match(adv.best!.reasons.join(' | '), /Averages 1,000 a day over 4 worked days/);
  // A slow line is judged against its own record, not ranked above a proven one.
  assert.equal(byLine(adv, 5).fit, 'beyond');
  assert.match(byLine(adv, 5).reasons.join(' | '), /more than it has ever made in a day/);
  // A line that never ran says so, and sits between the proven and the slow.
  assert.equal(byLine(adv, 7).fit, 'unknown');
  assert.match(byLine(adv, 7).reasons.join(' | '), /never run/);
  const order_ = adv.ranked.map((r) => r.lineNo);
  assert.equal(order_.indexOf(2) < order_.indexOf(7) && order_.indexOf(7) < order_.indexOf(5), true);
});

test('a busy line is offered from the day it comes free, with the wait counted against it', () => {
  const { orders, entries } = factory();
  const adv = placementAdvice(newOrder({}), orders, entries, S, AS_OF);
  const three = byLine(adv, 3);
  assert.equal(three.asEntered, false);
  assert.deepEqual(three.busyWith, ['C']);
  assert.match(three.reasons[0], /Busy with C - free for this order from/);
  assert.equal(three.planningDate! > '2026-09-02', true);
});

test('the same style run before on a line counts for that line', () => {
  const { orders, entries } = factory();
  const adv = placementAdvice(newOrder({ styleNo: 'st/9' }), orders, entries, S, AS_OF); // case does not matter
  assert.equal(adv.best!.lineNo, 2);
  assert.equal(adv.best!.style!.daysWorked, 4);
  assert.match(adv.best!.reasons.join(' | '), /Has made st\/9 here before: 1,000 a day over 4 worked days/);
  assert.equal(adv.styleNo, 'st/9');
});

test('a target no line reaches is flagged, with the date the fastest line would really finish', () => {
  const { orders, entries } = factory();
  const adv = placementAdvice(newOrder({ orderQty: 80000 }), orders, entries, S, AS_OF);
  assert.ok(adv.realisticDate && adv.realisticDate > '2026-10-10');
  assert.match(adv.warnings.join(' '), /more than any line usually makes/);
  assert.match(adv.warnings.join(' '), /more than any line has made on its best day \(1,100\)/);
  assert.match(adv.warnings.join(' '), /At Line 2's usual 1,000 a day it would finish about/);
});

test('fabric due before today for the start it would get is warned about', () => {
  const { orders, entries } = factory();
  const soon = placementAdvice(newOrder({ orderQty: 3000, requiredDate: '2026-09-20' }), orders, entries, S, AS_OF);
  assert.match(soon.warnings.join(' '), /fabric received was due .* already past/);
  // Ticked, and it is not raised.
  const ticked = placementAdvice(newOrder({ orderQty: 3000, requiredDate: '2026-09-20', fabricReceivedAt: '2026-08-01T06:00:00Z',
    cuttingDoneAt: '2026-08-20T06:00:00Z', accessoriesReceivedAt: '2026-08-20T06:00:00Z' }), orders, entries, S, AS_OF);
  assert.doesNotMatch(ticked.warnings.join(' '), /was due/);
});

test('moving an order: its own line gets a nudge, so a tie keeps it where it is', () => {
  const x = order({ orderNo: 'X', lineNo: 8, orderQty: 3000, planningDate: '2026-09-10', requiredDate: '2026-11-30' });
  const adv = placementAdvice(x, [], [], S, AS_OF, [], { currentLine: 8 });
  assert.equal(adv.best!.lineNo, 8);           // every line is empty and unknown: stay put
});

// --- style family: the part before "/" (asked for 25 Sep 2026) ------------------

test('style family is the part before the "/", whatever the case or spacing', () => {
  assert.equal(styleFamily('or675/13'), 'OR675');
  assert.equal(styleFamily(' OR675 / 12 '), 'OR675');
  assert.equal(styleFamily('TRY'), 'TRY');
  assert.equal(styleFamily(''), null);
  assert.equal(styleFamily('/12'), null);
});

/** Line 6 is running OR675/11 at 500 a day and finishes in two days; Line 2 is the proven fast line. */
function withFamily() {
  const f = factory();
  const run = order({ orderNo: 'F', lineNo: 6, styleNo: 'OR675/11', orderQty: 2000, requiredDate: '2026-09-30' });
  return { orders: [...f.orders, run], entries: [...f.entries, ...days(run.id, [500, 500], 27)], run };
}

test('a line running the same style family goes first when it can make the date', () => {
  const { orders, entries } = withFamily();
  const plain = placementAdvice(newOrder({ orderQty: 6000, styleNo: 'XX/1' }), orders, entries, S, AS_OF);
  assert.equal(plain.best!.lineNo, 2);                           // without the family, the fast free line wins
  const adv = placementAdvice(newOrder({ orderQty: 6000, styleNo: 'or675/12' }), orders, entries, S, AS_OF);
  assert.equal(adv.family, 'OR675');
  assert.equal(adv.best!.lineNo, 6);
  assert.equal(adv.best!.familyFirst, true);
  assert.deepEqual(adv.best!.family, { orderNo: 'F', styleNo: 'OR675/11', how: 'running' });
  assert.match(adv.best!.reasons.join(' | '), /Running F \(OR675\/11\) now - the same style family \(OR675\)/);
  assert.equal(adv.ranked[1].lineNo, 2);                         // then as before
});

test('the family line is not put first when it cannot make the date - and says why', () => {
  const { orders, entries } = withFamily();
  // Too big for Line 6's 500 a day in the time: needs more than it has ever made.
  const big = placementAdvice(newOrder({ orderQty: 30000, styleNo: 'OR675/12' }), orders, entries, S, AS_OF);
  const six = byLine(big, 6);
  assert.equal(six.familyFirst, false);
  assert.notEqual(big.best!.lineNo, 6);
  assert.match(six.reasons.join(' | '), /same style family \(OR675\).* but it needs more a day than this line has ever made/);
  // Busy past the required date: a long OR675 run on Line 4.
  const long = order({ orderNo: 'G', lineNo: 4, styleNo: 'OR675/9', orderQty: 40000, requiredDate: '2026-11-30' });
  const es = [...entries, ...days(long.id, [800, 800], 27)];
  const late = placementAdvice(newOrder({ orderQty: 3000, styleNo: 'OR675/12', requiredDate: '2026-09-25' }),
    [...orders, long], es, S, AS_OF);
  const four = byLine(late, 4);
  assert.equal(four.late, true);
  assert.equal(four.familyFirst, false);
  assert.match(four.reasons.join(' | '), /but it only comes free after the required date/);
});

test('a family order queued on a line counts too: straight before this one', () => {
  const { orders, entries } = factory();
  const queued = order({ orderNo: 'H', lineNo: 8, styleNo: 'OR675/99', orderQty: 2000, planningDate: '2026-09-01',
    requiredDate: '2026-09-19', fabricReceivedAt: null });
  const adv = placementAdvice(newOrder({ orderQty: 5000, styleNo: 'OR675/12', requiredDate: '2026-10-31' }),
    [...orders, queued], entries, S, AS_OF);
  assert.equal(adv.best!.lineNo, 8);
  assert.equal(adv.best!.family!.how, 'before');
  assert.match(adv.best!.reasons.join(' | '), /Comes straight after H \(OR675\/99\)/);
});

test("a line's record of the family stands in when the exact style is new to it", () => {
  const { orders, entries } = factory();
  // Line 2 made ST/9 (finished); a new ST/10 has no record of its own anywhere.
  const adv = placementAdvice(newOrder({ styleNo: 'ST/10' }), orders, entries, S, AS_OF);
  assert.equal(adv.best!.lineNo, 2);
  assert.equal(adv.best!.style!.match, 'family');
  assert.equal(adv.best!.family!.how, 'last');
  assert.match(adv.best!.reasons.join(' | '), /Last ran A \(ST\/9\) - the same style family \(ST\)/);
  assert.match(adv.best!.reasons.join(' | '), /Has made ST styles here before: 1,000 a day over 4 worked days/);
});

// --- the AI's plumbing -----------------------------------------------------

test('writing and judgment go to the AI; plain lookups stay with the board', () => {
  for (const q of ['Write a status update for the manager', 'why is ORD-2026-011 late?', 'what should we do this week?',
    'suggest a better plan for line 4', 'summarise the week', 'how can we finish 012 on time']) {
    assert.equal(wantsWriting(q), true, q);
  }
  for (const q of ['what is late?', 'which lines are free?', 'how much did we make today?', 'status of 011']) {
    assert.equal(wantsWriting(q), false, q);
  }
});

test('the brief carries the board, and nothing that is not the board', () => {
  const { orders, entries } = factory();
  const b = { orders, entries, plans: planBoard(orders, entries, S, AS_OF), idle: [], settings: S, asOf: AS_OF, today: AS_OF };
  const brief = boardBrief(b);
  assert.match(brief, /^BOARD - planned as of 01 Sep 2026/);
  for (const o of orders) assert.match(brief, new RegExp(`- ${o.orderNo} \\|`));
  assert.match(brief, /Line 2: nothing running/);
  assert.match(brief, /record: 1,000\/day average over 4 worked days/);
  assert.match(brief, /RAISED BY THE BOARD/);
  assert.doesNotMatch(brief, /password|AUTH_|DATABASE_URL|OLLAMA/i);
});

test('a reply is cleaned: reasoning tags out, look-alike hyphens and spaces made plain', () => {
  assert.equal(cleanReply('<think>let me see</think>\n\nLine 3 is best.'), 'Line 3 is best.');
  // gpt-oss writes ORD‑2026‑016 with non-breaking hyphens and "Line 4" with a no-break space.
  assert.equal(cleanReply('Move ORD‑2026‑016 to Line 4 on 24 Sep'), 'Move ORD-2026-016 to Line 4 on 24 Sep');
  assert.match(cleanReply('ORD‑2026‑011'), /^ORD-2026-011$/);
});

test('a follow-up to the AI goes back to the AI', () => {
  for (const q of ['and which of those is most at risk?', 'what about Line 4?', 'why not the first one?', 'so which should go first']) {
    assert.equal(isFollowUp(q), true, q);
  }
  for (const q of ['what is late?', 'how is ORD-2026-011 doing?', 'which lines are free?']) assert.equal(isFollowUp(q), false, q);
});

test('each person gets a fair share of AI questions an hour', () => {
  const t = 1_000_000_000;
  for (let i = 0; i < AI_PER_HOUR; i++) assert.equal(takeAiTurn(99, t + i), true);
  assert.equal(takeAiTurn(99, t + AI_PER_HOUR), false);      // one too many
  assert.equal(takeAiTurn(98, t), true);                     // someone else is unaffected
  assert.equal(takeAiTurn(99, t + 3_600_001), true);         // an hour later it is back
});

test('the model is asked with the brief and the board answer, and its errors are explained', async () => {
  const real = globalThis.fetch;
  const cfg = { host: 'https://example.test', key: 'k', model: 'm' };
  let sent: { model: string; messages: { role: string; content: string }[] } | null = null;
  try {
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ message: { content: 'Use Line 2.' } }), { status: 200 });
    }) as typeof fetch;
    const r = await askModel({ question: 'Where?', brief: 'BOARD - x', boardAnswer: 'Line 2 is free', cfg });
    assert.equal(r.text, 'Use Line 2.');
    assert.equal(sent!.model, 'm');
    assert.equal(sent!.messages[1].content, 'BOARD - x');
    assert.match(sent!.messages.at(-1)!.content, /Where\?[\s\S]*Line 2 is free/);

    for (const [status, pattern] of [[402, /not in this Ollama plan/], [429, /usage limit/], [401, /refused/]] as const) {
      globalThis.fetch = (async () => new Response('{}', { status })) as unknown as typeof fetch;
      await assert.rejects(askModel({ question: 'q', brief: 'b', cfg }), (e: unknown) => e instanceof AiError && pattern.test(e.message));
    }
    await assert.rejects(askModel({ question: 'q', brief: 'b', cfg: { ...cfg, key: null } }), /not set up/);
  } finally {
    globalThis.fetch = real;
  }
});
