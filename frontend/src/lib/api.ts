// Types mirror backend/src/planning.ts. The browser never calculates a plan
// itself - every number on screen comes from the API, so no two screens can
// disagree.

import useSWR, { mutate } from "swr";
import { useView, viewQuery } from "./view";

export type ISODate = string;
export type Shift = "Day" | "Night" | "Overtime";
export type Status = "COMPLETED" | "ON TRACK" | "AT RISK" | "BEHIND SCHEDULE" | "NOT STARTED";
export const STATUSES: Status[] = ["BEHIND SCHEDULE", "AT RISK", "ON TRACK", "NOT STARTED", "COMPLETED"];

/** Line 1 ... Line 10 (LINES in backend/src/planning.ts). */
export const LINES = Array.from({ length: 10 }, (_, i) => i + 1);
export const lineName = (n: number | null | undefined) => (n ? `Line ${n}` : "No line");

/**
 * The two fields an order needs before anything can be entered against it
 * (scheduleMissing in backend/src/planning.ts). Either can be left empty when
 * the order is taken; until both are filled in the order is "not scheduled".
 */
export function scheduleMissing(o: Pick<Order, "lineNo" | "planningDate">): string[] {
  return [!o.lineNo && "Line", !o.planningDate && "Expected Scheduling Date"].filter((x): x is string => !!x);
}

export interface Order {
  id: number;
  orderNo: string;
  lineNo: number | null;               // null = not decided yet
  styleNo: string;
  colour: string;
  orderQty: number;
  unit: string;
  planningDate: ISODate | null;        // the Expected Scheduling Date; null = not known yet
  requiredDate: ISODate;
  notes: string;
  fabricReceivedAt: string | null;     // ISO timestamps from the tick buttons
  cuttingDoneAt: string | null;
  accessoriesReceivedAt: string | null;
  packedAt: string | null;             // post-production
}

/** Pre-production, days before the start date (MILESTONE_LEAD_DAYS in planning.ts). */
export const MILESTONES = [
  { key: "fabric", label: "Fabric received", lead: 25 },
  { key: "cutting", label: "Cutting", lead: 7 },
  { key: "accessories", label: "Accessories", lead: 7 },
] as const;
/** Post-production: packing is due this many days after the order is complete (PACKING_DAYS). */
export const PACKING_DAYS = 4;
export type MilestoneKey = (typeof MILESTONES)[number]["key"];

/** Pre-production still to tick. Production can be logged only once there is none (the server checks too). */
export function milestonesMissing(o: Order): string[] {
  const done: Record<MilestoneKey, string | null> = {
    fabric: o.fabricReceivedAt, cutting: o.cuttingDoneAt, accessories: o.accessoriesReceivedAt,
  };
  return MILESTONES.filter((m) => !done[m.key]).map((m) => m.label);
}
export type MilestoneState = "early" | "on-time" | "late" | "due" | "overdue" | "none";

export interface Milestone {
  expected: ISODate | null;
  doneAt: string | null;
  doneOn: ISODate | null;
  days: number | null;   // done: + early / - late; not done: + to go / - overdue
  state: MilestoneState;
}

export interface PreProduction {
  fabric: Milestone;
  cutting: Milestone;
  accessories: Milestone;
  overall: "ready" | "delayed" | "on-schedule" | "none";
  delayDays: number;
}

export interface OrderPlan {
  produced: number;
  balance: number;
  overBy: number;
  pctComplete: number;
  entryCount: number;
  daysWorked: number;
  firstProduction: ISODate | null;
  lastProduction: ISODate | null;
  pacePerDay: number | null;
  paceDaysUsed: number;
  paceBasis: "average" | "target" | "peak" | null;
  planFrom: ISODate | null;
  workingDaysLeft: number | null;
  targetPerDay: number | null;
  daysNeeded: number | null;
  projectedFinish: ISODate | null;
  bufferDays: number | null;
  overdue: boolean;
  status: Status;
  scheduled: boolean;              // has its line and expected scheduling date
  startDays: number | null;        // qty / target
  startDate: ISODate | null;
  preProduction: PreProduction;
  postProduction: { packing: Milestone };
  bookStart: ISODate;              // the days it holds its line
  bookEnd: ISODate;
  waitingFor: string | null;       // the order on its line it has been moved back behind
  overlaps: string[];              // orders booked on its line on the same days
}

export type PlannedOrder = Order & { plan: OrderPlan };

/** The rules a plan was worked out with, as the server applied them. */
export interface PlanSettings {
  workDaysPerWeek: 5 | 6 | 7;
  paceDays: number | null;        // null = every worked day
  calendarStart: ISODate | null;  // null = first production day
}

/** today = the real date; asOf = the date this plan was worked out from (today unless the viewer picked another). */
export interface Context { today: ISODate; asOf: ISODate; settings: PlanSettings }

export interface Kpis {
  totalQty: number;
  totalProduced: number;
  totalBalance: number;
  pctComplete: number;
  workedDays: number;
  avgPerDay: number;
  neededPerDay: number;
  overdueBalance: number;
  counts: Record<Status, number> & { total: number };
}

export interface Entry {
  id: number;
  entryNo: string;
  orderId: number;
  entryDate: ISODate;
  qty: number;
  shift: Shift;
  remarks: string;
  cumulative: number;
  balanceAfter: number;
  flag: string;
  orderNo: string;
  lineNo: number | null;
  styleNo: string;
  orderQty: number;
}

export interface CalendarDay { date: ISODate; working: boolean; today: boolean; idle: number }

export interface CalendarData extends Context {
  start: ISODate;
  end: ISODate;
  days: CalendarDay[];
  rows: {
    orderId: number; orderNo: string; lineNo: number | null; styleNo: string;
    orderQty: number; requiredDate: ISODate; status: Status;
    pacePerDay: number | null; targetPerDay: number | null; overdue: boolean;
    projectedFinish: ISODate | null;
    cells: ({ qty: number; needed: number | null; state: "met" | "below" | "late" } | null)[];
    idle: number[];
  }[];
  totals: number[];
}

export interface LineBlock {
  orderId: number; orderNo: string; styleNo: string; colour: string; orderQty: number; unit: string;
  status: Status; kind: "done" | "running" | "planned";
  start: ISODate; end: ISODate; requiredDate: ISODate; planFrom: ISODate | null;
  produced: number; balance: number; pacePerDay: number | null; targetPerDay: number | null;
  waitingFor: string | null; overlaps: string[];
  paceBasis: OrderPlan["paceBasis"]; daysWorked: number;
}

export interface LineCell {
  orderId: number;
  clash: number | null;   // a second order booked the same day
  qty: number | null;     // made that day
  late: boolean;          // past that order's required date: red, otherwise green
  start: boolean;         // first day of its booking
  /** Two or more orders made something that day (a changeover): what each made, in line order. */
  parts: { orderId: number; qty: number; late: boolean }[] | null;
}

export interface LineCalendarData extends Context {
  start: ISODate;
  end: ISODate;
  days: CalendarDay[];
  rows: {
    lineNo: number; blocks: LineBlock[]; cells: (LineCell | null)[]; idle: number[];
    current: number | null; freeFrom: ISODate;
  }[];
  totals: number[];       // made per day, all lines
  /** Orders still waiting for their line or scheduling date - dragged onto the calendar to schedule them. */
  unscheduled: UnscheduledOrder[];
}

export interface UnscheduledOrder {
  orderId: number; orderNo: string; styleNo: string; colour: string; orderQty: number; unit: string;
  requiredDate: ISODate; lineNo: number | null; planningDate: ISODate | null;
  missing: string[]; targetPerDay: number | null; overdue: boolean;
}

export interface Booking { orderId: number; orderNo: string; start: ISODate; end: ISODate }

/** GET /api/orders/check: where an order can go. */
export interface LineCheck {
  today: ISODate;
  plan: {
    startDate: ISODate | null; targetPerDay: number | null; bookStart: ISODate; bookEnd: ISODate;
    workingDaysLeft: number | null; overdue: boolean; produced: number;
  };
  lines: {
    lineNo: number; free: boolean; clashes: Booking[];
    plan: { startDate: ISODate | null; targetPerDay: number | null; bookStart: ISODate; bookEnd: ISODate; overdue: boolean };
    suggest: {
      planningDate: ISODate; startDate: ISODate | null; bookStart: ISODate; bookEnd: ISODate;
      targetPerDay: number | null; late: boolean;
    } | null;
  }[];
  /** Which line the advisor would pick, and why. */
  advice: PlacementAdvice;
}

/** How a line's own record measures up to what an order needs there. */
export type Fit = "comfortable" | "tight" | "stretch" | "beyond" | "unknown";

/** One line, judged for one order by the advisor (backend/src/advisor.ts). */
export interface LineAdvice {
  lineNo: number;
  available: boolean;
  asEntered: boolean;
  planningDate: ISODate | null;
  start: ISODate | null;
  end: ISODate | null;
  targetPerDay: number | null;
  late: boolean;
  waitDays: number;
  busyWith: string[];
  record: { avgPerDay: number | null; bestDay: number | null; daysWorked: number };
  /** This style on this line before - or its style family when the style itself has too few days. */
  style: { avgPerDay: number | null; daysWorked: number; match: "style" | "family" } | null;
  pace: number | null;
  fit: Fit;
  spareDays: number | null;
  /** An order of the same style family (the part before "/") on this line. */
  family: { orderNo: string; styleNo: string; how: "running" | "before" | "after" | "last" } | null;
  /** ...and the line still makes the date, so it is put first. */
  familyFirst: boolean;
  score: number;
  reasons: string[];
}

export interface PlacementAdvice {
  best: LineAdvice | null;
  ranked: LineAdvice[];
  warnings: string[];
  realisticDate: ISODate | null;
  styleNo: string | null;
  family: string | null;
}

/** GET /api/orders/:id/move-advice - for the line calendar, as an order is picked up. */
export interface MoveAdvice {
  today: ISODate;
  advice: PlacementAdvice;
  order: { id: number; orderNo: string; orderQty: number; requiredDate: ISODate; styleNo: string; lineNo: number | null };
  missing: string[];
}

/** What the AI model wrote, or why it could not. */
export type AiResult = { text: string; model: string; ms: number } | { error: string; status: number };
export const aiText = (r: AiResult | undefined) => (r && "text" in r ? r : null);

export interface IdleDay {
  id: number;
  idleDate: ISODate;
  lineNo: number | null; // null = every line
  portion: 0.5 | 1;
  reason: string;
}

export interface Meta { today: ISODate; nextOrderNo: string; lineCount: number; styles: string[] }

// --- the Assistant: what it has learned, what it raises, what it answers ---------

export interface Suggestion {
  id: string;
  kind: string;
  severity: "urgent" | "soon" | "watch";
  title: string;
  detail: string;
  advice: string;
  orderId?: number;
  orderNo?: string;
  lineNo?: number;
  page: string;
}

export interface Performance {
  daysWorked: number; produced: number; avgPerDay: number | null;
  bestDay: { date: ISODate; qty: number } | null;
  worstDay: { date: ISODate; qty: number } | null;
  recentAvg: number | null; earlierAvg: number | null;
  trend: "rising" | "steady" | "falling" | null;
  swing: number | null; firstWorked: ISODate | null; lastWorked: ISODate | null;
}
export interface LineStats extends Performance { lineNo: number; orders: number; running: number; booked: number }
export interface StyleStats extends Performance { styleNo: string; orders: number }

export interface InsightsData extends Context {
  lines: LineStats[];
  styles: StyleStats[];
  factory: Performance;
  rampUp: { day: number; share: number; sample: number }[];
  basis: { workedDays: number; entries: number; orders: number; ordersRun: number; since: ISODate | null };
  suggestions: Suggestion[];
  examples: string[];
  /** Whether the AI model is set up on the server, and which one. */
  ai: { enabled: boolean; model: string; perHour: number };
}

export interface Answer {
  question: string;
  understood: string;
  intent: string;
  confidence: "exact" | "partial" | "none";
  headline: string;
  lines: string[];
  table?: { columns: string[]; rows: string[][]; numeric?: number[] };
  links: { label: string; page: string; orderId?: number }[];
  followUps: string[];
  suggestions?: Suggestion[];
}

/**
 * A failed request. `warnings` is set when the server wants a confirmation;
 * `code` "not-scheduled" when the order still needs its line or date.
 */
export class ApiError extends Error {
  constructor(public status: number, message: string, public warnings: string[] = [], public code?: string) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  } catch {
    throw new ApiError(0, "Cannot reach the server. Is the backend running?");
  }
  const body = await res.json().catch(() => ({}));
  // Session missing or expired: back to the sign-in page, then return here. Never from the
  // sign-in page itself - that would reload it again and again, and nobody could type.
  if (res.status === 401 && !url.startsWith("/api/auth/login") && typeof window !== "undefined"
    && !window.location.pathname.startsWith("/login")) {
    window.location.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  }
  if (!res.ok) throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`, body.warnings ?? [], body.code);
  return body as T;
}

export const api = {
  get: <T,>(url: string) => request<T>(url),
  post: <T,>(url: string, data: unknown) => request<T>(url, { method: "POST", body: JSON.stringify(data) }),
  put: <T,>(url: string, data: unknown) => request<T>(url, { method: "PUT", body: JSON.stringify(data) }),
  del: <T,>(url: string) => request<T>(url, { method: "DELETE" }),
};

const fetcher = <T,>(url: string) => request<T>(url);

// Planned data follows this viewer's planning controls (the base rules unless they changed any).
function usePlanned<T>(path: string, on = true) {
  const { view } = useView();
  return useSWR<T>(on ? `${path}${viewQuery(view)}` : null, fetcher);
}

export const useDashboard = () => usePlanned<Context & { kpis: Kpis; orders: PlannedOrder[] }>("/api/dashboard");
/** `on` = false skips the request, for a page that needs orders only for some roles. */
export const useOrders = (on = true) => usePlanned<Context & { orders: PlannedOrder[] }>("/api/orders", on);
export const useEntries = () => usePlanned<Context & { entries: Entry[] }>("/api/entries");
export const useCalendar = () => usePlanned<CalendarData>("/api/calendar");
/** The two ways the Line calendar reads a running order's pace. */
export type PaceMode = "rolling" | "peak";
export function useLines(mode: PaceMode = "rolling") {
  const { view } = useView();
  const q = viewQuery(view);
  const extra = mode === "peak" ? `${q ? "&" : "?"}pace=peak` : "";
  return useSWR<LineCalendarData>(`/api/lines${q}${extra}`, fetcher, { keepPreviousData: true });
}
export const useMeta = () => useSWR<Meta>("/api/meta", fetcher);

const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * Asked as the order form is filled in: is the line free for these dates, which lines are, and which is best.
 * The Expected Scheduling Date may be empty - every line is then judged from today.
 */
export function useLineCheck(f: { id?: number; orderQty: string; planningDate: string; requiredDate: string; styleNo?: string }) {
  const dated = isDay(f.planningDate);
  const ready = Number(f.orderQty) > 0 && Number.isInteger(Number(f.orderQty)) && isDay(f.requiredDate)
    && (!f.planningDate || (dated && f.requiredDate >= f.planningDate));
  const qs = new URLSearchParams({ orderQty: f.orderQty, requiredDate: f.requiredDate });
  if (dated) qs.set("planningDate", f.planningDate);
  if (f.id) qs.set("id", String(f.id));
  if (f.styleNo?.trim()) qs.set("styleNo", f.styleNo.trim());
  return useSWR<LineCheck>(ready ? `/api/orders/check?${qs}` : null, fetcher, { keepPreviousData: true });
}
export const useIdle = () => useSWR<{ idle: IdleDay[] }>("/api/idle", fetcher);
/** What the board has learned and everything it would raise - the Assistant page. */
export const useInsights = (on = true) => usePlanned<InsightsData>("/api/insights", on);

export type AskMode = "auto" | "board" | "ai";
/** One question: the board's answer, and the AI model's when it is wanted (or asked for). */
export const askBoard = (question: string, history: { question: string; answer: string; ai: boolean }[] = [], mode: AskMode = "auto") =>
  api.post<Context & { answer: Answer; ai?: AiResult }>("/api/assistant", { question, history, mode });
/** The AI model's action plan from everything the board is raising. */
export const aiPlan = () => api.post<Context & { ai: AiResult }>("/api/assistant/plan", {});
/** The order form's "Ask AI": where this order should go. */
export const aiPlacement = (draft: {
  id?: number; orderNo: string; styleNo: string; orderQty: number; planningDate: ISODate | null; requiredDate: ISODate; lineNo: number | null;
}) => api.post<Context & { ai: AiResult }>("/api/assistant/placement", draft);
/** The line calendar, as an order is picked up: every line judged for it. */
export const moveAdvice = (orderId: number, pace: PaceMode) =>
  api.get<MoveAdvice>(`/api/orders/${orderId}/move-advice${pace === "peak" ? "?pace=peak" : ""}`);
// --- who is signed in, and what they may do -------------------------------------

export type Permission =
  | "dashboard.view" | "orders.view" | "orders.edit" | "preproduction.view" | "preproduction.edit"
  | "postproduction.view" | "postproduction.edit"
  | "log.view" | "log.edit" | "calendar.view" | "calendar.edit" | "lines.view" | "assistant.use" | "admin.users";

export interface Me { user: { id: number; username: string; displayName: string }; permissions: Permission[] }

/** Polled with everything else, so an expired session - or a changed role - applies within seconds. */
export const useMe = () => useSWR<Me>("/api/auth/me", fetcher);

/** can("orders.edit") - false until we know. The server checks every request as well. */
export function useCan() {
  const { data, isLoading } = useMe();
  const perms = new Set(data?.permissions ?? []);
  return { can: (p: Permission) => perms.has(p), me: data, loading: isLoading && !data };
}

// --- users & roles (administration) ---------------------------------------------

export interface AdminUser {
  id: number; username: string; displayName: string; active: boolean; lastLoginAt: string | null;
  roles: { id: number; code: string; name: string }[];
}
export interface AdminRole {
  id: number; code: string; name: string; permissions: Permission[]; builtIn: boolean; userCount: number;
}
export interface PermissionInfo { key: Permission; section: string; label: string }

export const useAdminUsers = (on: boolean) => useSWR<{ users: AdminUser[] }>(on ? "/api/admin/users" : null, fetcher);
export const useAdminRoles = (on: boolean) => useSWR<{ roles: AdminRole[] }>(on ? "/api/admin/roles" : null, fetcher);
export const useAdminPermissions = (on: boolean) =>
  useSWR<{ permissions: PermissionInfo[] }>(on ? "/api/admin/permissions" : null, fetcher);

/** After any change, every screen's data is stale - refetch all of it. */
export const refreshAll = () => mutate((key) => typeof key === "string" && key.startsWith("/api/"));
