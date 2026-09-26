import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  authConfig, clearFailures, clearSessionCookie, clientIp, DUMMY_HASH, hashPassword, lockedMinutes,
  makeToken, need, noteFailure, PASSWORD_MIN, requireSession, setSessionCookie, verifyPassword,
} from './auth';
import { placementAdvice, type PlacementAdvice } from './advisor';
import { aiConfig, AiError, askModel, boardBrief, isFollowUp, takeAiTurn, wantsWriting, AI_PER_HOUR, type AiReply } from './ai';
import { ask, EXAMPLE_QUESTIONS } from './assistant';
import { pool, tx } from './db';
import { addDays, isISODate, maxDate, todayLocal, type ISODate, type WorkWeek } from './dates';
import { fmtDay } from './format';
import { learned, suggestions as adviceFor } from './insights';
import { migrate } from './migrate';
import { isPermission, PERMISSIONS } from './permissions';
import {
  BASE_SETTINGS, buildCalendar, buildLineCalendar, dashboardKpis, entryRunningTotals, isScheduled, LINE_COUNT, lineCheck,
  MILESTONE_LABEL, MILESTONES, milestonesMissing, planBoard, planOrder, scheduleMissing, schedulingDateFor,
  type MilestoneKey, type Order, type OrderPlan, type Settings,
} from './planning';
import * as repo from './repo';
import * as users from './repo-users';

const PORT = Number(process.env.PORT ?? 4000);

const authCfg = authConfig();
if (!authCfg) {
  console.error('AUTH_SECRET is not set. Run:  npm run set-login -- Admin "<password>"');
  process.exit(1);
}
const auth = authCfg;

// ---------------------------------------------------------------------------
// validation

const date = z.string().refine(isISODate, 'must be a date as YYYY-MM-DD');
const text = (max: number) => z.string().trim().max(max).default('');

const lineField = z.number({ error: 'Pick a line' }).int()
  .min(1, `Pick a line from 1 to ${LINE_COUNT}`).max(LINE_COUNT, `Pick a line from 1 to ${LINE_COUNT}`);

/** A date that may be left empty: "" and null both mean not known yet. */
const optionalDate = z.union([date, z.literal('')]).nullish().transform((d) => d || null);

// Line and Expected Scheduling Date may be left empty when an order is taken
// (25 Sep 2026) - it is then not scheduled; see planning.ts.
const orderBody = z.object({
  orderNo: z.string().trim().min(1, 'Order No is required').max(40),
  lineNo: lineField.nullish().transform((n) => n ?? null),
  styleNo: text(80),
  colour: text(80),
  orderQty: z.coerce.number().int('Order Qty must be a whole number').positive('Order Qty must be greater than zero'),
  unit: z.string().trim().max(20).default('Pcs').transform((u) => u || 'Pcs'),
  planningDate: optionalDate,
  requiredDate: date,
  notes: text(2000),
}).refine((o) => !o.planningDate || o.requiredDate >= o.planningDate, {
  message: 'Required Delivery cannot be before the Expected Scheduling Date', path: ['requiredDate'],
});

const entryBody = z.object({
  orderId: z.coerce.number().int().positive('Pick an order'),
  entryDate: date,
  qty: z.coerce.number().int('Produced Qty must be a whole number').positive('Produced Qty must be greater than zero'),
  shift: z.enum(['Day', 'Night', 'Overtime']).default('Day'),
  remarks: text(500),
  confirm: z.boolean().default(false), // true once the user has seen the warnings
});

class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

const idParam = (req: Request) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Bad id');
  return id;
};

// ---------------------------------------------------------------------------
// the whole board, planned

/**
 * The planning controls, sent by the viewer's page as query parameters. Each
 * one left out means its base rule, so a plain request gets the base plan:
 *   asOf=YYYY-MM-DD   plan from this day            (base: today)
 *   paceDays=N        pace over the last N worked days (base: every worked day)
 *   workWeek=5|6|7    working days per week         (base: 6, Mon-Sat)
 *   calendarStart=... first calendar day            (base: first production day)
 * They live only in that viewer's page, so nobody changes what anyone else sees.
 */
const viewQuery = z.object({
  asOf: date.optional(),
  paceDays: z.coerce.number().int().min(1, 'paceDays must be 1 or more').max(60).optional(),
  workWeek: z.enum(['5', '6', '7'], 'workWeek must be 5, 6 or 7').transform((w) => Number(w) as WorkWeek).optional(),
  calendarStart: date.optional(),
  pace: z.enum(['rolling', 'peak'], 'pace must be rolling or peak').optional(), // the Line calendar's two views
});

function viewFrom(req: Request): { asOf: ISODate; settings: Settings } {
  const q = viewQuery.parse(req.query);
  return {
    asOf: q.asOf ?? todayLocal(),
    settings: {
      workDaysPerWeek: q.workWeek ?? BASE_SETTINGS.workDaysPerWeek,
      paceDays: q.paceDays ?? null,
      calendarStart: q.calendarStart ?? null,
      paceMode: q.pace ?? 'rolling',
    },
  };
}

async function loadBoard(req: Request) {
  const [orders, entries, idle] = await Promise.all([repo.listOrders(), repo.listEntries(), repo.listIdle()]);
  const today = todayLocal();
  const { asOf, settings } = viewFrom(req);
  const plans = planBoard(orders, entries, settings, asOf, idle);
  return { orders, entries, idle, plans, today, asOf, settings };
}

type Db = Parameters<typeof repo.listOrders>[0];

/**
 * Refuses an order whose line is taken on the days it would book. Checked on
 * today's plan with the base rules, whatever a viewer's planning controls say,
 * and inside the save's transaction under repo.lockLines. `s` is the base plan
 * everywhere but a move on the Line calendar, which reads how many days running
 * work still needs of its line the way the view being looked at shows them.
 */
async function assertLineFree(db: Db, candidate: Order, editingId: number | null, s: Settings = BASE_SETTINGS) {
  const orders = await repo.listOrders(db);
  const entries = await repo.listEntries(db);
  const idle = await repo.listIdle(db);
  const r = lineCheck(
    candidate, entries.filter((e) => e.orderId === editingId),
    orders.filter((o) => o.id !== editingId), entries.filter((e) => e.orderId !== editingId),
    s, todayLocal(), idle);
  const mine = r.lines.find((l) => l.lineNo === candidate.lineNo)!;
  if (mine.free) return;
  const b = mine.clashes[0];
  let msg = `Line ${candidate.lineNo} is booked by ${b.orderNo} from ${fmtDay(b.start)} to ${fmtDay(b.end)}.`;
  if (mine.suggest) {
    msg += ` It is free for this order from Expected Scheduling Date ${fmtDay(mine.suggest.planningDate)}`
      + `${mine.suggest.late ? ' - after the required delivery date' : ''}.`;
  }
  const free = r.lines.filter((l) => l.free).map((l) => `Line ${l.lineNo}`);
  msg += free.length ? ` Free on these dates: ${free.join(', ')}.` : ' No other line is free on these dates.';
  throw new HttpError(409, msg);
}

/**
 * Nothing is entered against an order - pre-production tick, production,
 * packing - until it has its line and expected scheduling date. `code` and
 * `missing` let the page open its "fill these in first" popup.
 */
function assertScheduled(o: Order, what: string) {
  const missing = scheduleMissing(o);
  if (!missing.length) return;
  throw new HttpError(400,
    `${o.orderNo} has no ${missing.join(' and no ')} yet. Fill ${missing.length === 1 ? 'it' : 'both'} in on the order `
    + `(Orders, or drag it onto the Line calendar) before ${what}.`,
    { code: 'not-scheduled', missing, orderId: o.id, orderNo: o.orderNo });
}

const withPlan = (orders: Order[], plans: Map<number, OrderPlan>) =>
  orders.map((o) => ({ ...o, plan: plans.get(o.id)! }));

/** Sent with every plan so the page can show exactly which rules produced it. */
const context = (b: { today: ISODate; asOf: ISODate; settings: Settings }) =>
  ({ today: b.today, asOf: b.asOf, settings: b.settings });

// ---------------------------------------------------------------------------

const app = express();
app.set('trust proxy', true); // requests arrive through Next.js and the Cloudflare tunnel
app.use(express.json({ limit: '1mb' }));

// Live data: never let a browser, Next.js or Cloudflare serve a stored copy.
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

/** The connection indicator in the top bar polls this: server up AND database answering. */
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: true });
  } catch {
    res.status(503).json({ ok: false, db: false, error: 'The database is not answering' });
  }
});

// --- sign in / out ---------------------------------------------------------

const loginBody = z.object({ username: z.string().trim().max(100), password: z.string().max(200) });

app.post('/api/auth/login', async (req, res) => {
  const ip = clientIp(req);
  const wait = lockedMinutes(ip);
  if (wait) throw new HttpError(429, `Too many wrong attempts. Try again in ${wait} minute${wait === 1 ? '' : 's'}.`);
  const { username, password } = loginBody.parse(req.body);
  // The ID is not case-sensitive; the password is. An unknown ID still costs a
  // full password check, so the answer time does not give away which IDs exist.
  const u = await users.findUserForLogin(username);
  const ok = verifyPassword(password, u?.passwordHash ?? DUMMY_HASH) && !!u;
  if (!ok) {
    noteFailure(ip);
    throw new HttpError(401, 'Wrong ID or password');
  }
  if (!u.active) throw new HttpError(403, 'This account has been deactivated. Ask an administrator.');
  clearFailures(ip);
  await users.noteLogin(u.id);
  setSessionCookie(req, res, makeToken({ uid: u.id, v: u.tokenVersion }, auth.secret, auth.hours), auth.hours);
  res.json({ user: { id: u.id, username: u.username, displayName: u.displayName } });
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

// Everything below needs a signed-in, active user.
app.use('/api', requireSession(auth, (id) => users.loadSessionUser(id)));

/** Who is signed in and what their roles let them do - the pages show and hide by this. */
app.get('/api/auth/me', (req, res) => {
  const u = req.user!;
  res.json({ user: { id: u.id, username: u.username, displayName: u.displayName }, permissions: [...u.permissions] });
});

const passwordField = z.string().min(PASSWORD_MIN, `The password needs at least ${PASSWORD_MIN} characters`).max(200);

/** Any user can change their own password; their other sessions end, this one carries on. */
app.post('/api/auth/password', async (req, res) => {
  const { current, next } = z.object({ current: z.string().max(200), next: passwordField }).parse(req.body);
  const u = req.user!;
  const hash = await users.passwordHashOf(u.id);
  if (!hash || !verifyPassword(current, hash)) throw new HttpError(400, 'The current password is not right');
  const v = await users.setPassword(u.id, hashPassword(next));
  setSessionCookie(req, res, makeToken({ uid: u.id, v }, auth.secret, auth.hours), auth.hours);
  res.json({ ok: true });
});

app.get('/api/meta', async (_req, res) => {
  const today = todayLocal();
  const [values, nextOrderNo] = await Promise.all([repo.distinctValues(), repo.nextOrderNo(+today.slice(0, 4))]);
  res.json({ today, nextOrderNo, lineCount: LINE_COUNT, ...values });
});

app.get('/api/dashboard', need('dashboard.view'), async (req, res) => {
  const b = await loadBoard(req);
  res.json({
    ...context(b),
    kpis: dashboardKpis(b.orders, b.plans, b.entries, b.asOf, b.settings),
    orders: withPlan(b.orders, b.plans),
  });
});

app.get('/api/calendar', need('calendar.view'), async (req, res) => {
  const b = await loadBoard(req);
  res.json({ ...context(b), ...buildCalendar(b.orders, b.plans, b.entries, b.settings, b.asOf, b.today, b.idle) });
});

app.get('/api/lines', need('lines.view'), async (req, res) => {
  const b = await loadBoard(req);
  res.json({ ...context(b), ...buildLineCalendar(b.orders, b.plans, b.entries, b.settings, b.asOf, b.today, b.idle) });
});

/**
 * The Assistant: what the board has learned from the days logged so far, and
 * everything it would raise. Read-only - the agent advises, the user acts.
 */
app.get('/api/insights', need('assistant.use'), async (req, res) => {
  const b = await loadBoard(req);
  const ai = aiConfig();
  res.json({
    ...context(b), ...learned(b), suggestions: adviceFor(b), examples: EXAMPLE_QUESTIONS,
    ai: { enabled: ai.key !== null, model: ai.model, perHour: AI_PER_HOUR },
  });
});

/**
 * The AI model, asked on behalf of the signed-in user: within their hourly
 * share, and never letting a model failure fail the request - the board's own
 * answer still stands, with the reason the AI part is missing.
 */
type AiResult = AiReply | { error: string; status: number };
async function tryModel(req: Request, opts: Parameters<typeof askModel>[0]): Promise<AiResult> {
  if (!aiConfig().key) return { error: 'The AI model is not set up on this server.', status: 503 };
  if (!takeAiTurn(req.user!.id)) {
    return { error: `That is ${AI_PER_HOUR} AI questions in the last hour - the limit for now. The board's own answers still work.`, status: 429 };
  }
  try {
    return await askModel(opts);
  } catch (e) {
    if (e instanceof AiError) return { error: e.message, status: e.status };
    throw e;
  }
}

// ai: whether that earlier answer was the model's - a follow-up to one goes back to it
const turnField = z.object({ question: z.string().max(400), answer: z.string().max(4000), ai: z.boolean().default(false) });
const askBody = z.object({
  question: z.string().trim().min(1, 'Type a question').max(400),
  history: z.array(turnField).max(8).default([]),
  // auto: the board answers; the AI too when the board cannot place it or it asks for writing or judgment
  mode: z.enum(['auto', 'board', 'ai']).default('auto'),
});

/** One typed question: the board's answer, and the AI's when it is wanted. */
app.post('/api/assistant', need('assistant.use'), async (req, res) => {
  const { question, history, mode } = askBody.parse(req.body);
  const b = await loadBoard(req);
  const answer = ask(question, b);
  const followsAi = history.length > 0 && history[history.length - 1].ai && isFollowUp(question);
  const useAi = mode === 'ai'
    || (mode === 'auto' && (answer.confidence === 'none' || answer.intent === 'advice' || wantsWriting(question) || followsAi));
  const board = answer.confidence === 'none' ? undefined
    : [answer.headline, ...answer.lines].join(' ');
  const ai = useAi ? await tryModel(req, { question, brief: boardBrief(b), boardAnswer: board, history }) : undefined;
  res.json({ ...context(b), answer, ai });
});

/** The AI's action plan for today, from everything the board is raising. */
app.post('/api/assistant/plan', need('assistant.use'), async (req, res) => {
  const b = await loadBoard(req);
  const ai = await tryModel(req, {
    question: 'Give me an action plan from what the board is raising, most important first. '
      + 'Three short groups: "Do today", "This week", "Keep an eye on". Name the order or line and the page to act on for each point. '
      + 'If little is raised, say what is going well and what to watch.',
    brief: boardBrief(b),
  });
  res.json({ ...context(b), ai });
});

/** The advisor's ranking in words - what the model is handed for the order form's "Ask AI". */
function adviceText(a: PlacementAdvice): string {
  const lines = a.ranked.filter((r) => r.available).slice(0, 5).map((r, i) =>
    `${i + 1}. Line ${r.lineNo} (${r.fit}${r.late ? ', late' : ''}${r.start ? `, start ${fmtDay(r.start)}` : ''}): ${r.reasons.join('; ')}.`);
  return [`Ranked by the board, best first:`, ...lines, ...a.warnings.map((w) => `Warning: ${w}`)].join('\n');
}

const placementBody = z.object({
  id: z.number().int().positive().optional(),
  orderNo: z.string().max(40).default(''),
  styleNo: z.string().max(80).default(''),
  orderQty: z.number().int().positive(),
  planningDate: optionalDate,             // left empty: judged from today
  requiredDate: date,
  lineNo: z.number().int().min(1).max(LINE_COUNT).nullable().optional(),
});

/** The order form's "Ask AI": where this order should go, reasoned over the board and the advisor's ranking. */
app.post('/api/assistant/placement', need('orders.edit'), async (req, res) => {
  const p = placementBody.parse(req.body);
  const b = await loadBoard(req);
  const existing = p.id ? b.orders.find((o) => o.id === p.id) : undefined;
  const candidate: Order = {
    ...(existing ?? {
      id: 0, orderNo: p.orderNo || 'the new order', colour: '', unit: 'Pcs', notes: '',
      fabricReceivedAt: null, cuttingDoneAt: null, accessoriesReceivedAt: null, packedAt: null,
    }),
    lineNo: p.lineNo ?? null, styleNo: p.styleNo, orderQty: p.orderQty,
    planningDate: p.planningDate ?? b.today, requiredDate: p.requiredDate,
  };
  const advice = placementAdvice(candidate, b.orders.filter((o) => o.id !== candidate.id), b.entries, b.settings, b.asOf, b.idle,
    { currentLine: existing?.lineNo ?? null });
  const family = advice.family && p.styleNo ? ` (style family ${advice.family})` : '';
  const what = `${existing ? `Order ${existing.orderNo}, being changed` : 'A new order'}: ${p.orderQty.toLocaleString('en-GB')} pieces`
    + `${p.styleNo ? ` of style ${p.styleNo}${family}` : ''}, `
    + `${p.planningDate ? `expected scheduling date ${fmtDay(p.planningDate)}` : 'no expected scheduling date yet (judged from today)'}`
    + `, required ${fmtDay(p.requiredDate)}${p.lineNo ? `, currently set to Line ${p.lineNo}` : ', no line picked yet'}.`;
  const ai = await tryModel(req, {
    question: `${what} Which line and start date would you choose, and why? Say what could go wrong (pace, fabric lead time, `
      + 'lines that come free later) and one alternative. Be brief.',
    brief: boardBrief(b),
    boardAnswer: adviceText(advice),
  });
  res.json({ ...context(b), ai });
});

// --- orders ----------------------------------------------------------------

// Pre-production lists orders too, and logging production needs the order list to pick from.
app.get('/api/orders', need('orders.view', 'preproduction.view', 'postproduction.view', 'log.edit'), async (req, res) => {
  const b = await loadBoard(req);
  res.json({ ...context(b), orders: withPlan(b.orders, b.plans) });
});

const checkQuery = z.object({
  id: z.coerce.number().int().positive().optional(),   // the order being changed; left out for a new one
  lineNo: z.coerce.number().int().min(1).max(LINE_COUNT).optional(),
  orderQty: z.coerce.number().int().positive('Order Qty must be greater than zero'),
  planningDate: optionalDate,                            // left out: judged from today
  requiredDate: date,
  styleNo: z.string().max(80).optional(),               // for the advisor: this style's record on each line
}).refine((q) => !q.planningDate || q.requiredDate >= q.planningDate, {
  message: 'Required Delivery cannot be before the Expected Scheduling Date', path: ['requiredDate'],
});

/**
 * The order form asks this as it is filled in: which lines are free for these
 * dates, when the rest are - and which line the advisor would pick, and why.
 * With no Expected Scheduling Date typed yet, every line is judged from today.
 */
app.get('/api/orders/check', need('orders.edit'), async (req, res) => {
  const q = checkQuery.parse(req.query);
  const [orders, entries, idle] = await Promise.all([repo.listOrders(), repo.listEntries(), repo.listIdle()]);
  const existing = q.id ? orders.find((o) => o.id === q.id) : undefined;
  if (q.id && !existing) throw new HttpError(404, 'Order not found');
  const today = todayLocal();
  const base: Order = existing ?? {
    id: 0, orderNo: '', lineNo: null, styleNo: '', colour: '', orderQty: q.orderQty, unit: 'Pcs',
    planningDate: null, requiredDate: q.requiredDate, notes: '',
    fabricReceivedAt: null, cuttingDoneAt: null, accessoriesReceivedAt: null, packedAt: null,
  };
  const candidate: Order = {
    ...base, lineNo: q.lineNo ?? base.lineNo, orderQty: q.orderQty,
    planningDate: q.planningDate ?? today, requiredDate: q.requiredDate, styleNo: q.styleNo ?? base.styleNo,
  };
  const others = orders.filter((o) => o.id !== q.id);
  res.json({
    today,
    ...lineCheck(candidate, entries.filter((e) => e.orderId === q.id), others,
      entries.filter((e) => e.orderId !== q.id), BASE_SETTINGS, today, idle),
    advice: placementAdvice(candidate, others, entries, BASE_SETTINGS, today, idle, { currentLine: existing?.lineNo ?? null }),
  });
});

/**
 * For the line calendar, as an order is picked up: every line judged for it
 * from the earliest it could start, in the view it is being dragged in. The
 * page works out each day it hovers over from these, with no further request.
 */
app.get('/api/orders/:id/move-advice', need('orders.edit'), async (req, res) => {
  const id = idParam(req);
  const { pace } = z.object({ pace: z.enum(['rolling', 'peak']).optional() }).parse(req.query);
  const s: Settings = { ...BASE_SETTINGS, paceMode: pace ?? BASE_SETTINGS.paceMode };
  const [orders, entries, idle] = await Promise.all([repo.listOrders(), repo.listEntries(), repo.listIdle()]);
  const existing = orders.find((o) => o.id === id);
  if (!existing) throw new HttpError(404, 'Order not found');
  const today = todayLocal();
  // Judged from the earliest it could start anywhere: today.
  const candidate: Order = { ...existing, planningDate: today };
  const advice = placementAdvice(candidate, orders.filter((o) => o.id !== id), entries, s, today, idle, { currentLine: existing.lineNo });
  res.json({
    today, advice,
    order: { id, orderNo: existing.orderNo, orderQty: existing.orderQty, requiredDate: existing.requiredDate, styleNo: existing.styleNo, lineNo: existing.lineNo },
    missing: milestonesMissing(existing).map((k) => MILESTONE_LABEL[k]),
  });
});

app.post('/api/orders', need('orders.edit'), async (req, res) => {
  const o = orderBody.parse(req.body);
  const created = await tx(async (c) => {
    // Not scheduled yet (no line or no date): it books nothing, so there is nothing to clash with.
    if (isScheduled(o)) {
      await repo.lockLines(c);
      await assertLineFree(c, { ...o, id: 0, fabricReceivedAt: null, cuttingDoneAt: null, accessoriesReceivedAt: null, packedAt: null }, null);
    }
    return repo.createOrder(o, c);
  });
  res.status(201).json(created);
});

app.put('/api/orders/:id', need('orders.edit'), async (req, res) => {
  const id = idParam(req);
  const existing = await repo.getOrder(id);
  if (!existing) throw new HttpError(404, 'Order not found');
  // The order number is the key - whatever the client sends, keep the stored one.
  const o = orderBody.parse({ ...req.body, orderNo: existing.orderNo });
  // Once anything has been entered against it, its line and date are what that rests on: they stay filled.
  const cleared = scheduleMissing(o).filter((f) => !scheduleMissing(existing).includes(f));
  if (cleared.length) {
    const ticked = MILESTONES.length - milestonesMissing(existing).length;
    const made = await repo.orderLogged(id, null);
    if (ticked || made) {
      throw new HttpError(400, `${existing.orderNo} already has ${made ? 'production logged' : 'pre-production ticked'}, `
        + `so its ${cleared.join(' and ')} cannot be emptied. Change ${cleared.length === 1 ? 'it' : 'them'} instead.`);
    }
  }
  // Only a change to what it books is checked, so notes can be edited while its line is in a muddle.
  const moved = o.lineNo !== existing.lineNo || o.planningDate !== existing.planningDate
    || o.requiredDate !== existing.requiredDate || o.orderQty !== existing.orderQty;
  const updated = await tx(async (c) => {
    if (moved && isScheduled(o)) {
      await repo.lockLines(c);
      await assertLineFree(c, { ...existing, ...o }, id);
    }
    return repo.updateOrder(id, o, c);
  });
  res.json(updated);
});

/**
 * Drag and drop on the line calendar: an order not yet started goes to a line
 * and starts on a day. Its expected scheduling date is set to match, so its
 * start date, target and pre-production dates follow everywhere; its required
 * delivery date stays. Refused once it has production, past its required
 * date, or where the line is taken.
 *
 * `pace` is the view the order was dragged in. It changes nothing about what
 * is saved - an order not yet started has no pace of its own - only how far
 * along its line the work already running is read, so that a day the Peak pace
 * view shows free can be dropped on there.
 */
app.post('/api/orders/:id/move', need('orders.edit'), async (req, res) => {
  const id = idParam(req);
  const b = z.object({
    lineNo: lineField, startDate: date,
    pace: z.enum(['rolling', 'peak'], 'pace must be rolling or peak').optional(),
  }).parse(req.body);
  const s: Settings = { ...BASE_SETTINGS, paceMode: b.pace ?? BASE_SETTINGS.paceMode };
  const existing = await repo.getOrder(id);
  if (!existing) throw new HttpError(404, 'Order not found');
  if ((await repo.orderLogged(id, null)) > 0) {
    throw new HttpError(400, `${existing.orderNo} has started - production is logged - so it stays where it is.`);
  }
  const today = todayLocal();
  const idle = await repo.listIdle();
  const moved: Order = { ...existing, lineNo: b.lineNo };
  // Nothing can start in the past: a drop there starts today.
  moved.planningDate = schedulingDateFor(moved, s, today, idle, maxDate(b.startDate, today));
  if (moved.planningDate > existing.requiredDate) {
    throw new HttpError(400, `That is after ${existing.orderNo}'s required delivery date (${fmtDay(existing.requiredDate)}). `
      + 'Move it earlier, or change the required date in Orders.');
  }
  const updated = await tx(async (c) => {
    await repo.lockLines(c);
    await assertLineFree(c, moved, id, s);
    return repo.updateOrder(id, moved, c);
  });
  const plan = planOrder(moved, [], s, today, idle);
  res.json({ order: updated, startDate: plan.startDate, targetPerDay: plan.targetPerDay });
});

app.delete('/api/orders/:id', need('orders.edit'), async (req, res) => {
  const r = await tx((c) => repo.deleteOrder(idParam(req), c));
  if (!r.deleted) throw new HttpError(404, 'Order not found');
  res.json(r);
});

// --- pre-production ------------------------------------------------------------

const milestoneKey = (req: Request): MilestoneKey => {
  const k = req.params.key as MilestoneKey;
  if (!MILESTONES.includes(k)) throw new HttpError(404, 'Unknown milestone');
  return k;
};

/** The tick button: stamps the milestone with the current date and time - once the order is scheduled. */
app.post('/api/orders/:id/milestones/:key', need('preproduction.edit'), async (req, res) => {
  const id = idParam(req);
  const key = milestoneKey(req);
  const order = await repo.getOrder(id);
  if (!order) throw new HttpError(404, 'Order not found');
  assertScheduled(order, `ticking ${MILESTONE_LABEL[key]}`);
  res.json(await repo.setMilestone(id, key, true));
});

/**
 * Undo a tick made by mistake - but not once production is logged: the ticks
 * are what allowed that production, so they stay.
 */
app.delete('/api/orders/:id/milestones/:key', need('preproduction.edit'), async (req, res) => {
  const id = idParam(req);
  const key = milestoneKey(req);
  const order = await repo.getOrder(id);
  if (!order) throw new HttpError(404, 'Order not found');
  if ((await repo.orderLogged(id, null)) > 0) {
    throw new HttpError(400, `Production is already logged for ${order.orderNo}, so its pre-production ticks stay.`);
  }
  res.json(await repo.setMilestone(id, key, false));
});

// --- post-production -----------------------------------------------------------

/** Packing: ticked with the current date and time - only once everything has been made. */
app.post('/api/orders/:id/packing', need('postproduction.edit'), async (req, res) => {
  const id = idParam(req);
  const order = await repo.getOrder(id);
  if (!order) throw new HttpError(404, 'Order not found');
  assertScheduled(order, 'ticking packing');
  const made = await repo.orderLogged(id, null);
  if (made < order.orderQty) {
    const fmt = (n: number) => n.toLocaleString('en-US');
    throw new HttpError(400, `${order.orderNo} is not finished yet (${fmt(made)} of ${fmt(order.orderQty)} made). `
      + 'Packing can be ticked once production is complete.');
  }
  res.json(await repo.setPacked(id, true));
});

/** Undo a packing tick made by mistake. */
app.delete('/api/orders/:id/packing', need('postproduction.edit'), async (req, res) => {
  const o = await repo.setPacked(idParam(req), false);
  if (!o) throw new HttpError(404, 'Order not found');
  res.json(o);
});

// --- production entries ----------------------------------------------------

app.get('/api/entries', need('log.view'), async (req, res) => {
  const b = await loadBoard(req);
  const orderById = new Map(b.orders.map((o) => [o.id, o]));
  const calc = entryRunningTotals(b.orders, b.entries);
  const entries = b.entries
    .map((e) => {
      const o = orderById.get(e.orderId)!;
      return {
        ...e, ...calc.get(e.id)!,
        orderNo: o.orderNo, lineNo: o.lineNo, styleNo: o.styleNo, orderQty: o.orderQty,
      };
    })
    .reverse(); // newest first
  res.json({ ...context(b), entries });
});

/**
 * Hard rules reject the entry: the order must exist, have its line and
 * expected scheduling date, have all three pre-production milestones ticked,
 * and the date must not be in the future.
 * Warnings (over-production, a second entry for the same shift, work before
 * the expected scheduling date) come back as 409 until the user confirms -
 * the workbook's "Keep this entry?" prompt, but enforced here so no client
 * can skip it.
 */
async function checkEntry(e: z.infer<typeof entryBody>, editingId: number | null) {
  const order = await repo.getOrder(e.orderId);
  if (!order) throw new HttpError(400, 'That order does not exist');
  assertScheduled(order, 'logging production');
  const missing = milestonesMissing(order);
  if (missing.length) {
    throw new HttpError(400, `${order.orderNo} cannot take production yet. Tick `
      + `${missing.map((k) => MILESTONE_LABEL[k]).join(', ')} on Pre-production first.`);
  }
  if (e.entryDate > todayLocal()) throw new HttpError(400, 'Production cannot be logged for a future date');

  const warnings: string[] = [];
  const logged = await repo.orderLogged(order.id, editingId);
  const fmt = (n: number) => n.toLocaleString('en-US');
  if (logged + e.qty > order.orderQty) {
    warnings.push(`Order ${order.orderNo} is for ${fmt(order.orderQty)} ${order.unit}. Already logged: ${fmt(logged)}. `
      + `This entry takes it to ${fmt(logged + e.qty)} - over by ${fmt(logged + e.qty - order.orderQty)}.`);
  }
  const twins = await repo.sameShiftEntries(order.id, e.entryDate, e.shift, editingId);
  if (twins.length) {
    const list = twins.map((t) => `${t.entryNo} (${fmt(t.qty)})`).join(', ');
    warnings.push(`There is already a ${e.shift} entry for ${order.orderNo} on this date: ${list}. Both will be counted.`);
  }
  if (order.planningDate && e.entryDate < order.planningDate) {
    warnings.push(`${order.orderNo} has an expected scheduling date of ${fmtDay(order.planningDate)}; `
      + `this entry is dated ${fmtDay(e.entryDate)}.`);
  }
  if (warnings.length && !e.confirm) throw new HttpError(409, 'Please confirm', { warnings });
}

app.post('/api/entries', need('log.edit'), async (req, res) => {
  const e = entryBody.parse(req.body);
  await checkEntry(e, null);
  res.status(201).json(await repo.createEntry(e));
});

app.put('/api/entries/:id', need('log.edit'), async (req, res) => {
  const id = idParam(req);
  if (!(await repo.getEntry(id))) throw new HttpError(404, 'Entry not found');
  const e = entryBody.parse(req.body);
  await checkEntry(e, id);
  res.json(await repo.updateEntry(id, e));
});

app.delete('/api/entries/:id', need('log.edit'), async (req, res) => {
  if (!(await repo.deleteEntry(idParam(req)))) throw new HttpError(404, 'Entry not found');
  res.json({ deleted: true });
});

// --- idle days ---------------------------------------------------------------

/** Longest single range that can be marked idle in one go. */
const MAX_IDLE_RANGE = 366;

const idleBody = z.object({
  from: date,
  to: date.optional(),                            // leave out for a single day
  portion: z.union([z.literal(0.5), z.literal(1)]),
  lineNo: lineField.nullable().default(null), // null = every line
  reason: text(200),
}).refine((b) => !b.to || b.to >= b.from, { message: 'The end date cannot be before the start date', path: ['to'] });

app.get('/api/idle', need('calendar.view'), async (_req, res) => {
  res.json({ idle: await repo.listIdle() });
});

app.post('/api/idle', need('calendar.edit'), async (req, res) => {
  const b = idleBody.parse(req.body);
  const dates: ISODate[] = [];
  for (let d = b.from; d <= (b.to ?? b.from); d = addDays(d, 1)) {
    if (dates.length >= MAX_IDLE_RANGE) throw new HttpError(400, `Mark at most ${MAX_IDLE_RANGE} days at a time`);
    dates.push(d);
  }
  const saved = await tx((c) => repo.saveIdle(dates, b.lineNo, b.portion, b.reason, c));
  res.status(201).json({ saved });
});

app.delete('/api/idle/:id', need('calendar.edit'), async (req, res) => {
  if (!(await repo.deleteIdle(idParam(req)))) throw new HttpError(404, 'Idle day not found');
  res.json({ deleted: true });
});

// --- users & roles (administration) -----------------------------------------------

const admin = need('admin.users');

const userIdField = z.string().trim().regex(/^[A-Za-z0-9._-]{2,40}$/,
  'User ID: 2 to 40 letters or numbers (dot, dash and underscore allowed, no spaces)');
const displayNameField = z.string().trim().min(1, 'Display name is required').max(80);
const roleIdsField = z.array(z.number().int().positive()).default([]).transform((a) => [...new Set(a)]);
const permissionsField = z.array(z.string()).default([]).transform((a) => [...new Set(a)])
  .refine((a) => a.every(isPermission), 'Unknown permission');

/** Guard for every change to users or roles: someone must still be able to manage access. */
async function keepOneAdmin(c: Parameters<typeof users.activeAdminCount>[0]) {
  if ((await users.activeAdminCount(c)) === 0) {
    throw new HttpError(400, 'At least one active user must keep access to Users & roles (for example the Administrator role).');
  }
}

app.get('/api/admin/permissions', admin, (_req, res) => {
  res.json({ permissions: PERMISSIONS });
});

app.get('/api/admin/users', admin, async (_req, res) => {
  res.json({ users: await users.listUsers() });
});

app.post('/api/admin/users', admin, async (req, res) => {
  const b = z.object({
    username: userIdField, displayName: displayNameField, password: passwordField,
    roleIds: roleIdsField, active: z.boolean().default(true),
  }).parse(req.body);
  const id = await tx((c) => users.createUser({ ...b, passwordHash: hashPassword(b.password) }, c));
  res.status(201).json({ id });
});

app.put('/api/admin/users/:id', admin, async (req, res) => {
  const id = idParam(req);
  const b = z.object({
    displayName: displayNameField,
    password: z.union([z.literal(''), passwordField]).optional().transform((p) => p || null), // blank = keep
    roleIds: roleIdsField,
    active: z.boolean(),
  }).parse(req.body);
  if (id === req.user!.id && !b.active) throw new HttpError(400, 'You cannot deactivate your own account.');
  await tx(async (c) => {
    const found = await users.updateUser(id, {
      displayName: b.displayName, passwordHash: b.password ? hashPassword(b.password) : null,
      active: b.active, roleIds: b.roleIds,
    }, c);
    if (!found) throw new HttpError(404, 'User not found');
    await keepOneAdmin(c);
  });
  // Changing your own password here would otherwise sign you out.
  if (id === req.user!.id && b.password) {
    const me = await users.loadSessionUser(id);
    if (me) setSessionCookie(req, res, makeToken({ uid: id, v: me.tokenVersion }, auth.secret, auth.hours), auth.hours);
  }
  res.json({ ok: true });
});

app.get('/api/admin/roles', admin, async (_req, res) => {
  res.json({ roles: await users.listRoles() });
});

app.post('/api/admin/roles', admin, async (req, res) => {
  const b = z.object({
    code: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,39}$/,
      'Role code: start with a letter, then letters, numbers or underscore (for example capacity_editor)'),
    name: z.string().trim().min(1, 'Role name is required').max(60),
    permissions: permissionsField,
  }).parse(req.body);
  res.status(201).json({ id: await users.createRole(b) });
});

app.put('/api/admin/roles/:id', admin, async (req, res) => {
  const id = idParam(req);
  const b = z.object({
    name: z.string().trim().min(1, 'Role name is required').max(60),
    permissions: permissionsField,
  }).parse(req.body);
  await tx(async (c) => {
    if (!(await users.updateRole(id, b, c))) throw new HttpError(404, 'Role not found');
    await keepOneAdmin(c);
  });
  res.json({ ok: true });
});

app.delete('/api/admin/roles/:id', admin, async (req, res) => {
  const id = idParam(req);
  const role = await users.getRole(id);
  if (!role) throw new HttpError(404, 'Role not found');
  if (role.builtIn) throw new HttpError(400, 'The Administrator role cannot be deleted.');
  const inUse = (await users.listRoles()).find((r) => r.id === id)?.userCount ?? 0;
  if (inUse) throw new HttpError(400, `${inUse} user${inUse === 1 ? ' has' : 's have'} this role. Take it off them first.`);
  await users.deleteRole(id);
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------

app.use((_req, _res, next) => next(new HttpError(404, 'Not found')));

const DUPLICATE: Record<string, string> = {
  orders_order_no_key: 'That Order No already exists',
  users_username_ci: 'That User ID already exists',
  roles_code_key: 'That role code already exists',
};

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: err.issues.map((i) => i.message).join('; '), issues: err.issues });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, ...err.extra });
    return;
  }
  const pgErr = err as { code?: string; constraint?: string; detail?: string };
  if (pgErr.code === '23505') {
    res.status(409).json({ error: DUPLICATE[pgErr.constraint ?? ''] ?? 'That record already exists' });
    return;
  }
  if (pgErr.code === '23514' || pgErr.code === '23503') {
    res.status(400).json({ error: pgErr.detail ?? 'The data breaks a database rule' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

/**
 * First start with the users table empty: the login from .env (the one set
 * with `npm run set-login` before users existed) becomes the first
 * Administrator, with the same password.
 */
async function bootstrapAdmin() {
  if ((await users.userCount()) > 0) return;
  const { AUTH_USER, AUTH_PASSWORD_HASH } = process.env;
  if (!AUTH_USER || !AUTH_PASSWORD_HASH) {
    console.warn('No users yet. Create the first administrator with:  npm run set-login -- Admin "<password>"');
    return;
  }
  await tx((c) => users.ensureAdmin(AUTH_USER, AUTH_USER, AUTH_PASSWORD_HASH, c));
  console.log(`First administrator created: ${AUTH_USER} (same password as before)`);
}

migrate()
  .then(bootstrapAdmin)
  .then(() => app.listen(PORT, () => console.log(`Sewing Planning API on http://localhost:${PORT}`)))
  .catch((e) => {
    console.error('Could not start:', e.message);
    process.exit(1);
  });
