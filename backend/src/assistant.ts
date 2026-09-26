/**
 * "Ask the board": questions typed in plain words, answered from the same
 * functions that draw every screen.
 *
 * It makes NO network call and needs no key. The point is that an answer can
 * never disagree with the board - it is the board, asked a different way. It
 * understands the app's own vocabulary (orders, lines, pace, target, delivery,
 * fabric, cutting, accessories, packing, idle days); anything it cannot place
 * it says so and offers the nearest questions it does know, rather than
 * guessing.
 *
 * Adding a question means adding one entry to INTENTS below and one case to
 * test/assistant.test.ts.
 */

import { addDays, isISODate, type ISODate } from './dates';
import { days as nDays, fmtDay, fmtNum, fmtShort, pct, pieces, plural } from './format';
import {
  forecast, learned, performance, suggestions, whenPhrase,
  type Board, type LineStats, type Suggestion,
} from './insights';
import { placementAdvice } from './advisor';
import {
  dailyTotals, holdsLine, LINES, lineCheck, MILESTONE_LABEL, MILESTONES, milestonesMissing, scheduleMissing,
  type MilestoneKey, type Order, type OrderPlan,
} from './planning';

// ---------------------------------------------------------------------------

export interface AnswerTable { columns: string[]; rows: string[][]; numeric?: number[] }

export interface Answer {
  question: string;
  /** The question as the agent read it - shown so a wrong reading is obvious. */
  understood: string;
  intent: string;
  confidence: 'exact' | 'partial' | 'none';
  headline: string;
  lines: string[];
  table?: AnswerTable;
  links: { label: string; page: string; orderId?: number }[];
  followUps: string[];
  /** Raised only when the question asked for advice. */
  suggestions?: Suggestion[];
}

interface Ask {
  raw: string;
  text: string;            // lower case, punctuation flattened
  words: string[];
  order: Order | null;     // the order named, if any
  orders: Order[];         // every order named
  lineNo: number | null;
  styleNo: string | null;
  qty: number | null;
  period: Period | null;
  date: ISODate | null;
}

interface Period { from: ISODate; to: ISODate; label: string }

// ---------------------------------------------------------------------------
// Reading the question

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9/\-.,: ]+/g, ' ').replace(/\s+/g, ' ').trim();
/** ORD-2026-011, ord2026011, 011 and 11 all come down to the same key. */
const keyOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const has = (t: string, ...ws: string[]) => ws.some((w) => t.includes(w));

function findOrders(text: string, orders: Order[]): Order[] {
  const k = keyOf(text);
  const hits = new Map<number, Order>();
  for (const o of orders) {
    const ok = keyOf(o.orderNo);
    if (ok && k.includes(ok)) { hits.set(o.id, o); continue; }
    // The tail on its own: "011", "order 11", "#11".
    const tail = ok.replace(/^[a-z]*/, '').replace(/^0*(\d{4})/, ''); // drop the year
    if (tail.length >= 2) {
      const m = text.match(/(?:^|[^0-9])0*(\d{1,4})(?:[^0-9]|$)/g) ?? [];
      for (const raw of m) {
        const n = raw.replace(/[^0-9]/g, '');
        if (n && (n === tail || n === tail.replace(/^0+/, ''))) hits.set(o.id, o);
      }
    }
  }
  return [...hits.values()];
}

function findStyle(text: string, orders: Order[]): string | null {
  const k = keyOf(text);
  const styles = [...new Set(orders.map((o) => o.styleNo).filter(Boolean))];
  return styles.find((s) => keyOf(s).length >= 3 && k.includes(keyOf(s))) ?? null;
}

/** "20 oct", "oct 20", "20/10/2026", "2026-10-20". Day and month only: this year, or next if it has gone. */
function findDate(text: string, today: ISODate): ISODate | null {
  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso && isISODate(iso[0])) return iso[0];
  const slash = text.match(/\b(\d{1,2})[/\-](\d{1,2})(?:[/\-](\d{2,4}))?\b/);
  if (slash) {
    const [d, m] = [+slash[1], +slash[2]];
    const y = slash[3] ? (slash[3].length === 2 ? 2000 + +slash[3] : +slash[3]) : +today.slice(0, 4);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const named = text.match(new RegExp(`\\b(\\d{1,2})\\s*(?:st|nd|rd|th)?\\s+(${MONTHS.join('|')})|\\b(${MONTHS.join('|')})\\s+(\\d{1,2})\\b`));
  if (named) {
    const d = +(named[1] ?? named[4]);
    const mon = MONTHS.indexOf((named[2] ?? named[3]).slice(0, 3)) + 1;
    if (d >= 1 && d <= 31 && mon >= 1) {
      const yearHint = text.match(/\b(20\d{2})\b/);
      let y = yearHint ? +yearHint[1] : +today.slice(0, 4);
      const made = `${y}-${String(mon).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (!yearHint && made < today) y += 1; // a month already gone means next year
      return `${y}-${String(mon).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  return null;
}

/** Monday of the week a date falls in - the working week here starts on Monday. */
function weekStart(d: ISODate): ISODate {
  const dow = (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = Monday
  return addDays(d, -dow);
}

function findPeriod(text: string, today: ISODate): Period | null {
  if (has(text, 'today', 'so far today')) return { from: today, to: today, label: 'today' };
  if (has(text, 'yesterday')) return { from: addDays(today, -1), to: addDays(today, -1), label: 'yesterday' };
  if (has(text, 'tomorrow')) return { from: addDays(today, 1), to: addDays(today, 1), label: 'tomorrow' };
  if (has(text, 'this week')) return { from: weekStart(today), to: addDays(weekStart(today), 6), label: 'this week' };
  if (has(text, 'last week', 'past week', 'previous week')) {
    const s = addDays(weekStart(today), -7);
    return { from: s, to: addDays(s, 6), label: 'last week' };
  }
  if (has(text, 'next week')) {
    const s = addDays(weekStart(today), 7);
    return { from: s, to: addDays(s, 6), label: 'next week' };
  }
  if (has(text, 'this month')) {
    const s = `${today.slice(0, 7)}-01`;
    return { from: s, to: addDays(addDays(s, 31).slice(0, 8) + '01', -1), label: 'this month' };
  }
  const lastN = text.match(/\b(?:last|past)\s+(\d{1,3})\s*(?:days?|d)\b/);
  if (lastN) return { from: addDays(today, -(+lastN[1]) + 1), to: today, label: `the last ${nDays(+lastN[1])}` };
  const nextN = text.match(/\b(?:next|coming|in)\s+(\d{1,3})\s*(?:days?|d)\b/);
  if (nextN) return { from: today, to: addDays(today, +nextN[1]), label: `the next ${nDays(+nextN[1])}` };
  return null;
}

function findQty(text: string): number | null {
  const m = text.match(/\b(\d[\d,]{2,})\s*(?:pcs|pieces|pc|units)?\b/);
  if (m) {
    const n = +m[1].replace(/,/g, '');
    if (n >= 100) return n;                     // below that it is a line number or a date
  }
  const k = text.match(/\b(\d{1,3})\s*k\b/);
  return k ? +k[1] * 1000 : null;
}

function read(raw: string, b: Board): Ask {
  const text = clean(raw);
  const styleNo = findStyle(text, b.orders);
  let orders = findOrders(text, b.orders);
  if (!orders.length && styleNo) {
    // A style names its orders: the one still running, else the latest of them.
    const ofStyle = b.orders.filter((o) => o.styleNo === styleNo);
    const running = ofStyle.filter((o) => { const p = b.plans.get(o.id)!; return p.produced > 0 && p.status !== 'COMPLETED'; });
    orders = running.length ? running : ofStyle;
  }
  const line = text.match(/\bline\s*#?\s*(\d{1,2})\b/);
  const lineNo = line && +line[1] >= 1 && +line[1] <= LINES.length ? +line[1] : null;
  return {
    raw, text, words: text.split(' ').filter(Boolean),
    order: orders[0] ?? null, orders, lineNo,
    styleNo,
    qty: findQty(text),
    period: findPeriod(text, b.today),
    date: findDate(text, b.today),
  };
}

// ---------------------------------------------------------------------------
// Bits every answer uses

const ORDERS_PAGE = '/orders';
const LINES_PAGE = '/lines';

const planOf = (b: Board, o: Order) => b.plans.get(o.id)!;
const entriesOf = (b: Board, id: number) => b.entries.filter((e) => e.orderId === id && e.entryDate <= b.asOf);
const openOrders = (b: Board) => b.orders.filter((o) => planOf(b, o).status !== 'COMPLETED');
const lineLabel = (n: number | null) => (n ? `Line ${n}` : 'no line');
const orderLink = (o: Order) => ({ label: o.orderNo, page: ORDERS_PAGE, orderId: o.id });

/** What an order is doing, in one sentence. */
function oneLine(b: Board, o: Order): string {
  const p = planOf(b, o);
  const made = `${fmtNum(p.produced)} of ${fmtNum(o.orderQty)} (${pct(p.pctComplete)})`;
  if (p.status === 'COMPLETED') return `${o.orderNo} finished ${fmtDay(p.lastProduction!)} - ${made}.`;
  const unset = scheduleMissing(o);
  if (unset.length && p.produced === 0) {
    return `${o.orderNo}: not scheduled yet - no ${unset.join(' and no ')} - due ${fmtDay(o.requiredDate)}.`;
  }
  if (p.produced > 0) {
    return `${o.orderNo} on ${lineLabel(o.lineNo)}: ${made}, ${fmtNum(p.pacePerDay)} a day, `
      + `expected ${fmtDay(p.projectedFinish!)} against ${fmtDay(o.requiredDate)}.`;
  }
  return `${o.orderNo} on ${lineLabel(o.lineNo)}: not started, booked to start ${p.startDate ? fmtDay(p.startDate) : '-'}, `
    + `due ${fmtDay(o.requiredDate)}.`;
}

/** The free / busy picture of every line today. */
function lineState(b: Board) {
  return LINES.map((lineNo) => {
    const here = b.orders.filter((o) => holdsLine(o, lineNo));
    const running = here.find((o) => { const p = planOf(b, o); return p.produced > 0 && p.status !== 'COMPLETED'; });
    const booked = here
      .filter((o) => planOf(b, o).produced === 0 && planOf(b, o).status !== 'COMPLETED')
      .sort((x, y) => planOf(b, x).bookStart.localeCompare(planOf(b, y).bookStart));
    const held = here.map((o) => planOf(b, o)).filter((p) => p.status !== 'COMPLETED' && p.bookEnd >= b.today);
    const freeFrom = held.length ? addDays(held.reduce((m, p) => (p.bookEnd > m ? p.bookEnd : m), held[0].bookEnd), 1) : b.today;
    return { lineNo, running: running ?? null, booked, free: !held.some((p) => p.bookStart <= b.today), freeFrom };
  });
}

const totalIn = (b: Board, from: ISODate, to: ISODate, filter?: (id: number) => boolean) =>
  b.entries.filter((e) => e.entryDate >= from && e.entryDate <= to && (!filter || filter(e.orderId)))
    .reduce((s, e) => s + e.qty, 0);

const trendWord = (s: LineStats) =>
  (s.trend === 'rising' ? 'rising' : s.trend === 'falling' ? 'slowing' : s.trend === 'steady' ? 'steady' : 'too early to say');

// ---------------------------------------------------------------------------
// The questions it knows

interface Intent {
  key: string;
  label: (q: Ask, b: Board) => string;
  examples: string[];
  /** Highest score wins; 0 means it does not apply. */
  score: (q: Ask, b: Board) => number;
  answer: (q: Ask, b: Board) => Omit<Answer, 'question' | 'understood' | 'intent' | 'confidence'>;
}

const HELP_EXAMPLES = [
  'How is ORD-2026-011 doing?',
  'When will ORD-2026-011 finish?',
  'What is late?',
  'Which lines are free?',
  'What is Line 4 running?',
  'How much did we make this week?',
  'What needs my attention?',
  'Which line is fastest?',
  'What fabric is due in the next 7 days?',
  'Where can I put 5,000 pieces by 20 Dec?',
  'What is blocked?',
  'How much is left to make?',
];

const INTENTS: Intent[] = [
  // ---------------------------------------------------------------- help
  {
    key: 'help',
    label: () => 'What can be asked',
    examples: ['What can you tell me?', 'help'],
    score: (q) => (has(q.text, 'what can you', 'what do you know', 'how do i use', 'what can i ask')
      || /^help\b/.test(q.text) ? 1 : 0),
    answer: () => ({
      headline: 'Ask about any order, any line, what is late, what was made, or what needs attention.',
      lines: [
        'Everything is answered from the board itself, so an answer can never disagree with the screens.',
        'Nothing is sent anywhere: this runs on the same machine as the app.',
      ],
      links: [],
      followUps: HELP_EXAMPLES,
    }),
  },

  // ---------------------------------------------------------- suggestions
  {
    key: 'advice',
    label: () => 'What needs attention',
    examples: ['What needs my attention?', 'Any suggestions?', 'What should I do today?'],
    score: (q) => (has(q.text, 'suggest', 'advice', 'advise', 'attention', 'what should i', 'priorit',
      'anything wrong', 'problems', 'issues', 'worry', 'concern', 'recommend') ? 1 : 0),
    answer: (q, b) => {
      const all = suggestions(b);
      const mine = q.order ? all.filter((s) => s.orderId === q.order!.id)
        : q.lineNo ? all.filter((s) => s.lineNo === q.lineNo) : all;
      const urgent = mine.filter((s) => s.severity === 'urgent');
      return {
        headline: mine.length
          ? `${plural(mine.length, 'thing')} worth looking at${urgent.length ? `, ${urgent.length} urgent` : ''}.`
          : 'Nothing is asking for attention: every order is on track, and no milestone is overdue.',
        lines: mine.slice(0, 6).map((s) => `${s.title} - ${s.detail}`),
        links: [...new Set(mine.slice(0, 6).map((s) => s.page))].map((page) => ({ label: `Open ${page.replace('/', '') || 'dashboard'}`, page })),
        followUps: ['What is late?', 'What is blocked?', 'Which lines are free?'],
        suggestions: mine,
      };
    },
  },

  // -------------------------------------------------------- when finished
  {
    key: 'order-finish',
    label: (q) => `When ${q.order?.orderNo ?? 'the order'} finishes`,
    examples: ['When will ORD-2026-011 finish?'],
    score: (q) => (q.order && has(q.text, 'finish', 'complete', 'done', 'ready', 'delivery date', 'how long')
      && !has(q.text, 'how much', 'how many') ? 1 : 0),
    answer: (q, b) => {
      const o = q.order!, p = planOf(b, o);
      if (p.status === 'COMPLETED') {
        return {
          headline: `${o.orderNo} finished on ${fmtDay(p.lastProduction!)}, ${fmtNum(p.produced)} ${o.unit} in ${plural(p.daysWorked, 'worked day')}.`,
          lines: [`Required ${fmtDay(o.requiredDate)} - ${p.bufferDays! >= 0 ? `${nDays(p.bufferDays!)} early` : `${nDays(-p.bufferDays!)} late`}.`,
            o.packedAt ? `Packed ${fmtDay(o.packedAt.slice(0, 10))}.` : `Packing due ${p.postProduction.packing.expected ? fmtDay(p.postProduction.packing.expected) : '-'}.`],
          links: [orderLink(o), { label: 'Post-production', page: '/post-production' }],
          followUps: ['What is late?', 'What needs my attention?'],
        };
      }
      if (p.produced === 0) {
        return {
          headline: `${o.orderNo} has not started. Booked to start ${p.startDate ? fmtDay(p.startDate) : '-'} on ${lineLabel(o.lineNo)} and finish by ${fmtDay(o.requiredDate)}.`,
          lines: [
            `That needs ${fmtNum(p.targetPerDay)} a day over ${plural(p.workingDaysLeft ?? 0, 'working day')}.`,
            p.waitingFor ? `It is waiting for ${p.waitingFor} to finish on ${lineLabel(o.lineNo)}.` : '',
            milestonesMissing(o).length ? `Production is locked until ${milestonesMissing(o).map((k) => MILESTONE_LABEL[k]).join(', ')} ${milestonesMissing(o).length === 1 ? 'is' : 'are'} ticked.` : '',
          ].filter(Boolean),
          links: [orderLink(o), { label: 'Line calendar', page: LINES_PAGE }],
          followUps: [`What is blocked?`, `What is Line ${o.lineNo ?? 1} running?`],
        };
      }
      const f = forecast(o, entriesOf(b, o.id), p, b.settings, b.idle, b.asOf)!;
      const miss = p.projectedFinish! > o.requiredDate;
      return {
        headline: `${o.orderNo} should finish ${fmtDay(p.projectedFinish!)}, `
          + `${miss ? `${nDays(Math.abs(p.bufferDays!))} past` : `${nDays(p.bufferDays!)} inside`} its required date of ${fmtDay(o.requiredDate)}.`,
        lines: [
          `${fmtNum(p.balance)} left of ${fmtNum(o.orderQty)}, running at ${fmtNum(p.pacePerDay)} a day over ${plural(p.daysWorked, 'worked day')}.`,
          f.optimistic && f.cautious
            ? `At its best day (${fmtNum(f.optimistic.pace)}) it lands ${fmtDay(f.optimistic.date)}; at its slowest (${fmtNum(f.cautious.pace)}), ${fmtDay(f.cautious.date)}.`
            : '',
          miss ? `To make the date it needs ${fmtNum(p.targetPerDay)} a day.` : '',
        ].filter(Boolean),
        links: [orderLink(o), { label: 'Line calendar', page: LINES_PAGE }],
        followUps: [`How is ${o.orderNo} doing?`, 'What is late?'],
      };
    },
  },

  // ---------------------------------------------------------- order pace
  {
    key: 'order-pace',
    label: (q) => `${q.order?.orderNo ?? 'Order'} pace`,
    examples: ['What pace is ORD-2026-011 running at?'],
    score: (q) => (q.order && has(q.text, 'pace', 'speed', 'rate', 'per day', 'a day', 'output', 'productivity') ? 1 : 0),
    answer: (q, b) => {
      const o = q.order!, p = planOf(b, o);
      const perf = performance(dailyTotals(entriesOf(b, o.id)));
      if (!perf.daysWorked) {
        return {
          headline: `${o.orderNo} has no production logged yet, so it has no pace.`,
          lines: [`It will need ${fmtNum(p.targetPerDay)} a day to finish by ${fmtDay(o.requiredDate)}.`],
          links: [orderLink(o)], followUps: [`When will ${o.orderNo} finish?`],
        };
      }
      return {
        headline: `${o.orderNo} is averaging ${fmtNum(perf.avgPerDay)} a day over ${plural(perf.daysWorked, 'worked day')}; it needs ${fmtNum(p.targetPerDay)}.`,
        lines: [
          `Best day ${fmtNum(perf.bestDay!.qty)} on ${fmtDay(perf.bestDay!.date)}, slowest ${fmtNum(perf.worstDay!.qty)} on ${fmtDay(perf.worstDay!.date)}.`,
          perf.trend ? `Lately it is ${perf.trend === 'rising' ? 'rising' : perf.trend === 'falling' ? 'slowing' : 'steady'}${perf.recentAvg && perf.earlierAvg ? ` - ${fmtNum(perf.recentAvg)} a day against ${fmtNum(perf.earlierAvg)} before` : ''}.` : 'Too few days yet to call a trend.',
          `A day swings about ${pct(perf.swing ?? 0)} either side of the average.`,
        ],
        table: {
          columns: ['Day', 'Made'],
          rows: dailyTotals(entriesOf(b, o.id)).slice(-7).map((d) => [fmtDay(d.date), fmtNum(d.qty)]),
          numeric: [1],
        },
        links: [orderLink(o), { label: 'Production Log', page: '/log' }],
        followUps: [`When will ${o.orderNo} finish?`, 'Which line is fastest?'],
      };
    },
  },

  // -------------------------------------------------------- order status
  {
    key: 'order-status',
    label: (q) => `${q.order?.orderNo ?? 'Order'} status`,
    examples: ['How is ORD-2026-011 doing?', 'Tell me about ORD-2026-015'],
    score: (q) => {
      if (!q.order) return 0;
      // Asked plainly about the order it is; otherwise the catch-all for anything naming one.
      return has(q.text, 'how is', 'how s', 'hows', 'status', 'tell me about', 'about', 'doing', 'update on', 'where is') ? 1 : 0.8;
    },
    answer: (q, b) => {
      const o = q.order!, p = planOf(b, o);
      const missing = milestonesMissing(o);
      const rows: string[][] = [
        ['Line', lineLabel(o.lineNo)],
        ['Quantity', `${fmtNum(o.orderQty)} ${o.unit}`],
        ['Made', `${fmtNum(p.produced)} (${pct(p.pctComplete)})`],
        ['Left', fmtNum(p.balance)],
        ['Required delivery', fmtDay(o.requiredDate)],
        ['Expected scheduling date', o.planningDate ? fmtDay(o.planningDate) : 'not set yet'],
        ['Start date', p.startDate ? fmtDay(p.startDate) : '-'],
        ['Pace', p.pacePerDay ? `${fmtNum(p.pacePerDay)} a day` : 'not started'],
        ['Needs', p.targetPerDay ? `${fmtNum(p.targetPerDay)} a day` : '-'],
        ['Expected completion', p.projectedFinish ? fmtDay(p.projectedFinish) : '-'],
        ['Status', p.status],
      ];
      return {
        headline: oneLine(b, o),
        lines: [
          scheduleMissing(o).length && p.produced === 0
            ? `Not scheduled yet: fill in its ${scheduleMissing(o).join(' and ')} before anything can be ticked or logged for it.`
            : '',
          missing.length
            ? `Production is locked: ${missing.map((k) => MILESTONE_LABEL[k]).join(', ')} not ticked.`
            : 'Fabric, cutting and accessories are all ticked, so production can be logged.',
          p.waitingFor ? `Waiting for ${p.waitingFor} to finish on ${lineLabel(o.lineNo)}.` : '',
          p.overlaps.length ? `Sharing ${lineLabel(o.lineNo)} with ${p.overlaps.join(', ')}.` : '',
        ].filter(Boolean),
        table: { columns: ['Field', 'Value'], rows },
        links: [orderLink(o), { label: 'Line calendar', page: LINES_PAGE }],
        followUps: [`When will ${o.orderNo} finish?`, `What pace is ${o.orderNo} running at?`, 'What needs my attention?'],
      };
    },
  },

  // ------------------------------------------------------------ one line
  {
    key: 'line-status',
    label: (q) => `Line ${q.lineNo}`,
    examples: ['What is Line 4 running?', 'When is Line 6 free?'],
    score: (q) => (q.lineNo ? 0.9 : 0),
    answer: (q, b) => {
      const n = q.lineNo!;
      const st = lineState(b).find((x) => x.lineNo === n)!;
      const stats = learned(b).lines[n - 1];
      const queue = st.booked.map((o) => `${o.orderNo} from ${fmtDay(planOf(b, o).bookStart)}`);
      const headline = st.running
        ? `Line ${n} is running ${st.running.orderNo} - ${oneLine(b, st.running).replace(/^\S+ on Line \d+: /, '')}`
        : st.free ? `Line ${n} is free now${st.booked.length ? `, next up ${st.booked[0].orderNo} on ${fmtDay(planOf(b, st.booked[0]).bookStart)}` : ' with nothing booked'}.`
          : `Line ${n} is booked from ${fmtDay(planOf(b, st.booked[0]).bookStart)} by ${st.booked[0].orderNo}.`;
      return {
        headline,
        lines: [
          st.freeFrom > b.today ? `Free from ${fmtDay(st.freeFrom)}.` : 'Free from today.',
          stats.daysWorked
            ? `It has made ${fmtNum(stats.produced)} over ${plural(stats.daysWorked, 'worked day')} - ${fmtNum(stats.avgPerDay)} a day on average, best ${fmtNum(stats.bestDay!.qty)} on ${fmtDay(stats.bestDay!.date)}, ${trendWord(stats)}.`
            : 'Nothing has ever been logged on it, so it has no record yet.',
          queue.length ? `Queued: ${queue.join(', ')}.` : '',
        ].filter(Boolean),
        links: [{ label: 'Line calendar', page: LINES_PAGE }],
        followUps: ['Which lines are free?', 'Which line is fastest?', 'What is late?'],
      };
    },
  },

  // --------------------------------------------------------- free lines
  {
    key: 'lines-free',
    label: () => 'Lines free',
    examples: ['Which lines are free?', 'Is any line free?'],
    score: (q) => (has(q.text, 'free', 'available', 'empty', 'idle', 'spare') && has(q.text, 'line', 'lines') ? 1 : 0),
    answer: (_q, b) => {
      const st = lineState(b);
      const free = st.filter((x) => x.free);
      const soon = st.filter((x) => !x.free).sort((a, c) => a.freeFrom.localeCompare(c.freeFrom));
      return {
        headline: free.length
          ? `${plural(free.length, 'line')} free now: ${free.map((x) => `Line ${x.lineNo}`).join(', ')}.`
          : `Every line is busy. The first to come free is Line ${soon[0].lineNo} on ${fmtDay(soon[0].freeFrom)}.`,
        lines: soon.slice(0, 5).map((x) => `Line ${x.lineNo} free from ${fmtDay(x.freeFrom)}${x.running ? ` (running ${x.running.orderNo})` : ''}.`),
        table: {
          columns: ['Line', 'Now', 'Free from'],
          rows: st.map((x) => [`Line ${x.lineNo}`, x.running ? x.running.orderNo : x.free ? 'free' : 'booked', fmtDay(x.freeFrom)]),
        },
        links: [{ label: 'Line calendar', page: LINES_PAGE }],
        followUps: ['Where can I put 5,000 pieces by 20 Dec?', 'Which line is fastest?'],
      };
    },
  },

  // -------------------------------------------------------------- late
  {
    key: 'late',
    label: () => 'What is late',
    examples: ['What is late?', 'Which orders will miss their date?'],
    score: (q) => (has(q.text, 'late', 'behind', 'miss', 'delay', 'overdue', 'slip', 'at risk', 'risk', 'in trouble') ? 1 : 0),
    answer: (_q, b) => {
      const bad = openOrders(b)
        .map((o) => ({ o, p: planOf(b, o) }))
        .filter((x) => x.p.status === 'BEHIND SCHEDULE' || x.p.status === 'AT RISK')
        .sort((a, c) => (a.p.bufferDays ?? -99) - (c.p.bufferDays ?? -99));
      return {
        headline: bad.length
          ? `${plural(bad.length, 'order')} will not make their date comfortably.`
          : 'Nothing is late: every open order is expected inside its required date.',
        lines: bad.slice(0, 6).map(({ o, p }) =>
          `${o.orderNo} on ${lineLabel(o.lineNo)}: ${p.status.toLowerCase()}, expected ${p.projectedFinish ? fmtDay(p.projectedFinish) : 'not started'} against ${fmtDay(o.requiredDate)}`
          + `${p.targetPerDay ? ` - needs ${fmtNum(p.targetPerDay)} a day` : ''}.`),
        table: bad.length ? {
          columns: ['Order', 'Line', 'Status', 'Expected', 'Required', 'Needs / day'],
          rows: bad.map(({ o, p }) => [o.orderNo, lineLabel(o.lineNo), p.status,
            p.projectedFinish ? fmtShort(p.projectedFinish) : '-', fmtShort(o.requiredDate), fmtNum(p.targetPerDay)]),
          numeric: [5],
        } : undefined,
        links: [{ label: 'Orders', page: ORDERS_PAGE }],
        followUps: ['What needs my attention?', 'What is blocked?'],
      };
    },
  },

  // -------------------------------------------------------- what is blocked
  {
    key: 'blocked',
    label: () => 'Orders that cannot be logged',
    examples: ['What is blocked?', 'Which orders cannot log production?'],
    score: (q) => (has(q.text, 'block', 'locked', 'cannot log', 'cant log', 'can t log', 'stuck', 'not ticked', 'missing tick') ? 1 : 0),
    answer: (_q, b) => {
      const blocked = openOrders(b).map((o) => ({ o, missing: milestonesMissing(o) })).filter((x) => x.missing.length);
      return {
        headline: blocked.length
          ? `${plural(blocked.length, 'order')} cannot have production logged yet.`
          : 'Nothing is blocked: every open order has fabric, cutting and accessories ticked.',
        lines: blocked.map(({ o, missing }) => {
          const p = planOf(b, o);
          return `${o.orderNo} on ${lineLabel(o.lineNo)}: ${missing.map((k) => MILESTONE_LABEL[k]).join(', ')} not ticked`
            + `${p.startDate ? `, and it is due to start ${fmtDay(p.startDate)} (${whenPhrase(b.today, p.startDate)})` : ''}.`;
        }),
        links: [{ label: 'Pre-production', page: '/pre-production' }],
        followUps: ['What is due this week?', 'What needs my attention?'],
      };
    },
  },

  // --------------------------------------------------- milestones due
  {
    key: 'due',
    label: (q) => `What is due${q.period ? ` ${q.period.label}` : ''}`,
    examples: ['What fabric is due in the next 7 days?', 'What is due this week?'],
    score: (q) => {
      const about = has(q.text, 'fabric', 'cutting', 'accessor', 'packing', 'pre production', 'pre-production', 'post production', 'milestone');
      const due = has(q.text, 'due', 'expected', 'when', 'need', 'arriv', 'coming');
      return about && due ? 1 : about ? 0.85 : 0;
    },
    answer: (q, b) => {
      const to = q.period?.to ?? addDays(b.today, 14);
      const label = q.period?.label ?? 'the next 14 days';
      const only: MilestoneKey[] = has(q.text, 'fabric') ? ['fabric']
        : has(q.text, 'cutting') ? ['cutting'] : has(q.text, 'accessor') ? ['accessories'] : [...MILESTONES];
      const wantPacking = has(q.text, 'packing', 'post production', 'post-production');

      const rows: string[][] = [];
      for (const o of b.orders) {
        const p = planOf(b, o);
        if (!wantPacking) {
          for (const k of only) {
            const m = p.preProduction[k];
            if (m.doneAt || !m.expected || m.expected > to) continue;
            rows.push([o.orderNo, MILESTONE_LABEL[k], fmtDay(m.expected), m.expected < b.today ? `${whenPhrase(b.today, m.expected)} - overdue` : whenPhrase(b.today, m.expected)]);
          }
        }
        if (wantPacking || has(q.text, 'everything', 'all')) {
          const m = p.postProduction.packing;
          if (!m.doneAt && m.expected && m.expected <= to) {
            rows.push([o.orderNo, 'Packing', fmtDay(m.expected), m.expected < b.today ? `${whenPhrase(b.today, m.expected)} - overdue` : whenPhrase(b.today, m.expected)]);
          }
        }
      }
      rows.sort((x, y) => x[2].localeCompare(y[2]));
      return {
        headline: rows.length
          ? `${plural(rows.length, 'thing')} due by ${fmtDay(to)}${q.period ? ` (${label})` : ''}.`
          : `Nothing ${wantPacking ? 'to pack' : 'due'} in ${label}.`,
        lines: rows.slice(0, 8).map((r) => `${r[0]}: ${r[1]} due ${r[2]} (${r[3]}).`),
        table: rows.length ? { columns: ['Order', 'What', 'Due', 'When'], rows } : undefined,
        links: [{ label: 'Pre-production', page: '/pre-production' }, { label: 'Post-production', page: '/post-production' }],
        followUps: ['What is blocked?', 'What needs my attention?'],
      };
    },
  },

  // --------------------------------------------------------- production
  {
    key: 'production',
    label: (q) => `Production ${q.period?.label ?? 'so far'}`,
    examples: ['How much did we make today?', 'Production this week', 'How much did Line 4 make yesterday?'],
    score: (q) => {
      // "how much is left to make" is about the balance, not about a day's output.
      if (has(q.text, 'left to make', 'still to make', 'left to go', 'remaining', 'balance', 'how much is left')) return 0;
      const made = has(q.text, 'made', 'make', 'making', 'produce', 'production', 'output', 'logged', 'done today');
      const howMuch = has(q.text, 'how much', 'how many', 'what did', 'total');
      if (made && (howMuch || q.period)) return 1;
      return made ? 0.85 : 0;
    },
    answer: (q, b) => {
      const period = q.period ?? { from: b.asOf, to: b.asOf, label: 'today' };
      const forLine = q.lineNo;
      const ids = new Set(b.orders.filter((o) => (!forLine || o.lineNo === forLine) && (!q.order || o.id === q.order.id)).map((o) => o.id));
      const total = totalIn(b, period.from, period.to, (id) => ids.has(id));
      const byDay = dailyTotals(b.entries.filter((e) => e.entryDate >= period.from && e.entryDate <= period.to && ids.has(e.orderId)));
      const who = q.order ? ` on ${q.order.orderNo}` : forLine ? ` on Line ${forLine}` : '';
      const byOrder = new Map<number, number>();
      for (const e of b.entries) {
        if (e.entryDate < period.from || e.entryDate > period.to || !ids.has(e.orderId)) continue;
        byOrder.set(e.orderId, (byOrder.get(e.orderId) ?? 0) + e.qty);
      }
      return {
        headline: total
          ? `${pieces(total)}${who} ${period.from === period.to ? `on ${fmtDay(period.from)}` : `${period.label} (${fmtShort(period.from)} - ${fmtShort(period.to)})`}`
            + `${byDay.length > 1 ? `, ${fmtNum(total / byDay.length)} a day over ${plural(byDay.length, 'day')}` : ''}.`
          : `Nothing was logged${who} ${period.from === period.to ? `on ${fmtDay(period.from)}` : `in ${period.label}`}.`,
        lines: [...byOrder.entries()]
          .sort((a, c) => c[1] - a[1])
          .map(([id, qty]) => {
            const o = b.orders.find((x) => x.id === id)!;
            return `${o.orderNo} on ${lineLabel(o.lineNo)}: ${fmtNum(qty)}.`;
          }),
        table: byDay.length > 1 ? { columns: ['Day', 'Made'], rows: byDay.map((d) => [fmtDay(d.date), fmtNum(d.qty)]), numeric: [1] } : undefined,
        links: [{ label: 'Production Log', page: '/log' }],
        followUps: ['How much did we make this week?', 'Which line is fastest?', 'What is late?'],
      };
    },
  },

  // ----------------------------------------------------------- best line
  {
    key: 'best',
    label: () => 'Best and worst',
    examples: ['Which line is fastest?', 'What was our best day?'],
    score: (q) => (has(q.text, 'best', 'fastest', 'quickest', 'worst', 'slowest', 'top', 'most productive', 'highest', 'record') ? 1 : 0),
    answer: (q, b) => {
      const l = learned(b);
      const ran = l.lines.filter((x) => x.daysWorked > 0).sort((a, c) => (c.avgPerDay ?? 0) - (a.avgPerDay ?? 0));
      const wantDay = has(q.text, 'day', 'ever', 'record');
      if (!ran.length) {
        return { headline: 'No production has been logged yet, so there is nothing to compare.', lines: [], links: [], followUps: HELP_EXAMPLES.slice(0, 3) };
      }
      const best = ran[0], worst = ran[ran.length - 1];
      const bestDay = l.factory.bestDay!;
      return {
        headline: wantDay
          ? `The best day so far was ${fmtDay(bestDay.date)}: ${pieces(bestDay.qty)} across the factory.`
          : `Line ${best.lineNo} is the fastest - ${fmtNum(best.avgPerDay)} a day over ${plural(best.daysWorked, 'worked day')}.`,
        lines: [
          `Factory average ${fmtNum(l.factory.avgPerDay)} a day over ${plural(l.factory.daysWorked, 'worked day')}.`,
          ran.length > 1 ? `Slowest of the lines that have run: Line ${worst.lineNo} at ${fmtNum(worst.avgPerDay)} a day.` : '',
          `Best single day on a line: ${fmtNum(Math.max(...ran.map((x) => x.bestDay!.qty)))}.`,
        ].filter(Boolean),
        table: {
          columns: ['Line', 'Average / day', 'Best day', 'Worked days', 'Lately'],
          rows: ran.map((x) => [`Line ${x.lineNo}`, fmtNum(x.avgPerDay), fmtNum(x.bestDay!.qty), fmtNum(x.daysWorked), trendWord(x)]),
          numeric: [1, 2, 3],
        },
        links: [{ label: 'Line calendar', page: LINES_PAGE }],
        followUps: ['Which lines are free?', 'How much did we make this week?'],
      };
    },
  },

  // -------------------------------------------------------- where to put
  {
    key: 'place',
    label: (q) => `Where to put ${q.qty ? fmtNum(q.qty) : 'an order'}`,
    examples: ['Where can I put 5,000 pieces by 20 Dec?'],
    score: (q) => (has(q.text, 'where can', 'where should', 'which line should', 'which line can', 'room for', 'fit', 'place', 'put') ? 1 : 0),
    answer: (q, b) => {
      const qty = q.qty ?? 1000;
      const required = q.date ?? addDays(b.today, 30);
      const candidate: Order = {
        id: 0, orderNo: 'new order', lineNo: 1, styleNo: q.styleNo ?? '', colour: '', orderQty: qty,
        unit: 'Pcs', planningDate: b.today, requiredDate: required, notes: '',
        fabricReceivedAt: null, cuttingDoneAt: null, accessoriesReceivedAt: null, packedAt: null,
      };
      if (required < b.today) {
        return { headline: `${fmtDay(required)} has already gone - give a date in the future.`, lines: [], links: [], followUps: ['Where can I put 5,000 pieces by 20 Dec?'] };
      }
      const check = lineCheck(candidate, [], b.orders, b.entries, b.settings, b.asOf, b.idle);
      const stats = learned(b).lines;
      const free = check.lines.filter((l) => l.free)
        .sort((a, c) => (stats[c.lineNo - 1].avgPerDay ?? 0) - (stats[a.lineNo - 1].avgPerDay ?? 0));
      const target = check.plan.targetPerDay;
      // The advisor's pick, which puts a line already on the same style family first.
      const pick = placementAdvice({ ...candidate, lineNo: null }, b.orders, b.entries, b.settings, b.asOf, b.idle).best;
      const reach = free.filter((l) => {
        const s = stats[l.lineNo - 1];
        return !s.avgPerDay || !target || s.avgPerDay >= target;
      });
      return {
        headline: free.length
          ? `${plural(free.length, 'line')} can take ${pieces(qty)} by ${fmtDay(required)}: ${free.map((l) => `Line ${l.lineNo}`).join(', ')}.`
          : `No line is free for ${pieces(qty)} by ${fmtDay(required)}.`,
        lines: [
          // Not the start date: worked back from the required date it can land before today, which reads oddly here.
          target ? `It would need ${fmtNum(target)} a day over the ${plural(check.plan.workingDaysLeft ?? 0, 'working day')} between now and then.` : '',
          pick ? `Best pick: Line ${pick.lineNo}${pick.asEntered ? '' : ` from ${fmtDay(pick.planningDate!)}`} (${pick.fit})`
            + ` - ${pick.reasons.slice(1, 3).join('; ')}.` : '',
          reach.length && reach.length < free.length
            ? `Of those, ${reach.map((l) => `Line ${l.lineNo}`).join(', ')} ${reach.length === 1 ? 'has' : 'have'} averaged that pace before.`
            : '',
          !free.length ? check.lines.filter((l) => l.suggest).slice(0, 3)
            .map((l) => `Line ${l.lineNo} could take it from ${fmtDay(l.suggest!.planningDate)}${l.suggest!.late ? ' - past the date' : ''}.`).join(' ') : '',
        ].filter(Boolean),
        table: {
          columns: ['Line', 'Free for this', 'Averaged / day', 'Best day'],
          rows: check.lines.map((l) => {
            const s = stats[l.lineNo - 1];
            // The last of the clashes, not the first: that is the day the line really comes free.
            const until = l.clashes.reduce((m, c) => (c.end > m ? c.end : m), l.clashes[0]?.end ?? '');
            return [`Line ${l.lineNo}`, l.free ? 'yes' : `busy until ${fmtShort(until)}`,
              s.avgPerDay ? fmtNum(s.avgPerDay) : 'no record', s.bestDay ? fmtNum(s.bestDay.qty) : '-'];
          }),
          numeric: [2, 3],
        },
        links: [{ label: 'Add an order', page: ORDERS_PAGE }, { label: 'Line calendar', page: LINES_PAGE }],
        followUps: ['Which lines are free?', 'Which line is fastest?'],
      };
    },
  },

  // -------------------------------------------------------- what we know
  {
    key: 'learned',
    label: () => 'What the board has learned',
    examples: ['What have you learned?', 'Show me the averages'],
    score: (q) => (has(q.text, 'learn', 'average', 'trend', 'history', 'performance', 'statistic', 'ramp', 'build up', 'build-up') ? 1 : 0),
    answer: (_q, b) => {
      const l = learned(b);
      const ramp = l.rampUp;
      return {
        headline: l.basis.workedDays
          ? `Drawn from ${plural(l.basis.workedDays, 'worked day')} and ${plural(l.basis.entries, 'log entry', 'log entries')} across ${plural(l.basis.ordersRun, 'order')}, since ${fmtDay(l.basis.since!)}.`
          : 'Nothing has been logged yet, so there is nothing to learn from.',
        lines: [
          `Factory average ${fmtNum(l.factory.avgPerDay)} a day, best ${fmtNum(l.factory.bestDay?.qty)} on ${l.factory.bestDay ? fmtDay(l.factory.bestDay.date) : '-'}.`,
          `A day swings about ${pct(l.factory.swing ?? 0)} either side of that.`,
          ramp.length >= 2
            ? `A new order builds up: day 1 makes about ${pct(ramp[0].share)} of what it later reaches, day 2 ${pct(ramp[1].share)}${ramp[2] ? `, day 3 ${pct(ramp[2].share)}` : ''} (from ${plural(ramp[0].sample, 'order')}).`
            : 'Not enough finished runs yet to say how a new order builds up.',
          l.styles.length ? `Best style so far: ${l.styles[0].styleNo} at ${fmtNum(l.styles[0].avgPerDay)} a day.` : '',
        ].filter(Boolean),
        table: {
          columns: ['Line', 'Average / day', 'Best day', 'Worked days', 'Lately'],
          rows: l.lines.filter((x) => x.daysWorked).map((x) => [`Line ${x.lineNo}`, fmtNum(x.avgPerDay), fmtNum(x.bestDay!.qty), fmtNum(x.daysWorked), trendWord(x)]),
          numeric: [1, 2, 3],
        },
        links: [{ label: 'Line calendar', page: LINES_PAGE }],
        followUps: ['Which line is fastest?', 'What needs my attention?'],
      };
    },
  },

  // ------------------------------------------------------------- totals
  {
    key: 'totals',
    label: () => 'Where everything stands',
    examples: ['How much is left to make?', 'How many orders are open?'],
    score: (q) => (has(q.text, 'how many order', 'total', 'overall', 'summary', 'left to make', 'remaining', 'balance',
      'how are we doing', 'where are we', 'how is the factory', 'everything') ? 1 : 0),
    answer: (_q, b) => {
      const open = openOrders(b);
      const qty = b.orders.reduce((s, o) => s + o.orderQty, 0);
      const made = b.orders.reduce((s, o) => s + planOf(b, o).produced, 0);
      const left = b.orders.reduce((s, o) => s + planOf(b, o).balance, 0);
      const needed = open.reduce((s, o) => s + (planOf(b, o).targetPerDay ?? 0), 0);
      const l = learned(b);
      return {
        headline: `${fmtNum(made)} of ${fmtNum(qty)} made (${pct(qty ? made / qty : 0)}), ${fmtNum(left)} left across ${plural(open.length, 'open order')}.`,
        lines: [
          `Those orders need ${fmtNum(needed)} a day between them; the factory has averaged ${fmtNum(l.factory.avgPerDay)} a day over ${plural(l.factory.daysWorked, 'worked day')}.`,
          needed > (l.factory.avgPerDay ?? 0)
            ? `That is ${pct(needed / (l.factory.avgPerDay || 1) - 1)} more than the factory has ever averaged.`
            : 'That is inside what the factory has been making.',
          `${b.orders.filter((o) => planOf(b, o).status === 'COMPLETED').length} completed, ${b.orders.filter((o) => planOf(b, o).produced === 0).length} not started.`,
        ],
        table: {
          columns: ['Order', 'Line', 'Made', 'Left', 'Required', 'Status'],
          rows: b.orders.map((o) => {
            const p = planOf(b, o);
            return [o.orderNo, lineLabel(o.lineNo), fmtNum(p.produced), fmtNum(p.balance), fmtShort(o.requiredDate), p.status];
          }),
          numeric: [2, 3],
        },
        links: [{ label: 'Dashboard', page: '/' }, { label: 'Orders', page: ORDERS_PAGE }],
        followUps: ['What is late?', 'What needs my attention?'],
      };
    },
  },
];

// ---------------------------------------------------------------------------

/** How close two sets of words are - used only to offer a nearer question. */
function overlap(a: string[], b: string[]): number {
  const s = new Set(b);
  return a.filter((w) => w.length > 2 && s.has(w)).length / Math.max(1, a.length);
}

/**
 * Answers a typed question from the board. Never throws on a question it
 * cannot place: it says so, and offers the questions it does understand.
 */
export function ask(question: string, b: Board): Answer {
  const q = read(question, b);
  if (!q.text) {
    return {
      question, understood: 'nothing', intent: 'none', confidence: 'none',
      headline: 'Ask a question about an order, a line, what is late, or what was made.',
      lines: [], links: [], followUps: HELP_EXAMPLES,
    };
  }

  const scored = INTENTS.map((i) => ({ i, s: i.score(q, b) })).filter((x) => x.s > 0).sort((a, c) => c.s - a.s);
  const best = scored[0];
  if (!best) {
    const near = INTENTS.flatMap((i) => i.examples.map((e) => ({ e, s: overlap(q.words, clean(e).split(' ')) })))
      .sort((a, c) => c.s - a.s).filter((x) => x.s > 0).slice(0, 4).map((x) => x.e);
    return {
      question, understood: 'nothing in the board', intent: 'none', confidence: 'none',
      headline: `I could not place "${question.trim()}" against anything on the board.`,
      lines: [
        'I answer from the orders, the production log, the lines and the milestones - nothing else.',
        'Name an order (ORD-2026-011), a line (Line 4), or ask about what is late, due, made or free.',
      ],
      links: [], followUps: near.length ? near : HELP_EXAMPLES.slice(0, 6),
    };
  }

  const body = best.i.answer(q, b);
  return {
    question,
    understood: best.i.label(q, b),
    intent: best.i.key,
    confidence: best.s >= 1 ? 'exact' : 'partial',
    ...body,
  };
}

/** The questions offered on the page before anything is typed. */
export const EXAMPLE_QUESTIONS = HELP_EXAMPLES;
