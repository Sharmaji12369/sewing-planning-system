"use client";

import { useRef, useState } from "react";
import { CalendarClock, CalendarOff, ChevronDown, GripVertical, Info, Minus, Move, Plus, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { IdleDialog } from "@/components/idle-dialog";
import { FamilyChip, FitChip } from "@/components/order-advice";
import { OrderDialog } from "@/components/order-dialog";
import { SearchBox } from "@/components/order-cells";
import { LoadState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Guard } from "@/components/guard";
import {
  api, ApiError, lineName, moveAdvice, refreshAll, useCan, useLines, useOrders,
  type LineBlock, type LineCalendarData, type LineCell, type MoveAdvice, type PaceMode, type PlannedOrder,
} from "@/lib/api";
import { judgeDrop, type Tone, type Verdict } from "@/lib/drop-verdict";
import { addDays, daysBetween, fmtDate, fmtDay, fmtNum, weekdayName } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Days before the plan date shown without opening the earlier-days column. */
const RECENT_DAYS = 7;
/** Width of one day column, used to keep an order's name inside its own bar. */
const DAY_REM = 3.75;
/** A day two orders share on some line is wider, so both parts can be read. */
const SHARED_DAY_REM = 5.75;
/** The smallest part of a shared day, however little that order made. */
const MIN_PART = 0.22;

/**
 * Bars: up to the order's required date, past it, and two orders on the line at
 * once; finished orders in paler versions, and orders a style search leaves out
 * in grey. No opacity anywhere on a bar - it would fade an order's name where it
 * runs across the next days.
 */
const TONE = {
  onTime: "bg-emerald-100 text-emerald-950 border-emerald-300 dark:bg-emerald-900/50 dark:text-emerald-50 dark:border-emerald-700",
  late: "bg-rose-100 text-rose-950 border-rose-300 dark:bg-rose-900/55 dark:text-rose-50 dark:border-rose-700",
  doneOnTime: "bg-emerald-50 text-emerald-900 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-200 dark:border-emerald-900",
  doneLate: "bg-rose-50 text-rose-900 border-rose-200 dark:bg-rose-950/60 dark:text-rose-200 dark:border-rose-900",
  clash: "bg-amber-200 text-amber-950 border-amber-400 dark:bg-amber-800/60 dark:text-amber-50 dark:border-amber-600",
  other: "bg-muted text-muted-foreground border-border",
};
/** A non-working day inside a bar: the bar's own colour, hatched. */
const BAR_OFF_DAY = "bg-[repeating-linear-gradient(135deg,transparent_0_4px,rgb(255_255_255/0.6)_4px_8px)] dark:bg-[repeating-linear-gradient(135deg,transparent_0_4px,rgb(0_0_0/0.3)_4px_8px)]";
const toneFor = (late: boolean, done: boolean, dim: boolean) =>
  dim ? TONE.other : done ? (late ? TONE.doneLate : TONE.doneOnTime) : late ? TONE.late : TONE.onTime;

const MODE_NOTE: Record<PaceMode, string> = {
  rolling: "Running orders are booked at their average daily output.",
  peak: "Running orders are booked at their target for their first 4 days of production, then at their best day so far.",
};
const IDLE_FULL = "bg-slate-200/70 dark:bg-slate-700/40";
const IDLE_HALF = "bg-orange-100/70 dark:bg-orange-950/40";
const WEEKEND = "bg-muted/60";
const TODAY_COL = "bg-sky-50 dark:bg-sky-950/30";

const KIND = { done: "finished", running: "running", planned: "not started" } as const;

/**
 * An order not yet started being dragged: which day of its booking was picked up. One dragged from
 * "Not scheduled" has no line or booking yet: lineNo 0, start "".
 */
interface Drag { orderId: number; orderNo: string; lineNo: number; start: string; offset: number; requiredDate: string }
/** Where it would land: its line, its new start, its booking through its required date - and what the advisor makes of it. */
interface Landing { lineNo: number; start: string; end: string; late: boolean; verdict?: Verdict }

/** The landing outline and the hint beside the cursor take the verdict's colour. */
const OUTLINE: Record<Tone, string> = {
  good: "outline-emerald-500", warn: "outline-amber-500", bad: "outline-rose-500", neutral: "outline-sky-500",
};
const HINT: Record<Tone, string> = {
  good: "border-emerald-300 dark:border-emerald-800",
  warn: "border-amber-300 dark:border-amber-800",
  bad: "border-rose-300 dark:border-rose-800",
  neutral: "border-border",
};
const HINT_DOT: Record<Tone, string> = { good: "bg-emerald-500", warn: "bg-amber-500", bad: "bg-rose-500", neutral: "bg-slate-400" };
const HINT_W = 300;

type Row = LineCalendarData["rows"][number];

export default function LinesPage() {
  return <Guard need="lines.view"><Lines /></Guard>;
}

function Lines() {
  const [mode, setMode] = useState<PaceMode>("rolling");
  const { data, error, isLoading } = useLines(mode);
  const { can } = useCan();
  const canMove = can("orders.edit");
  const { data: ordersData } = useOrders(canMove); // to open an order's form from the calendar
  const [styleQ, setStyleQ] = useState("");
  const [showEarlier, setShowEarlier] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [idleOpen, setIdleOpen] = useState(false);
  const [editing, setEditing] = useState<PlannedOrder | null>(null);
  const [orderOpen, setOrderOpen] = useState(false);
  const drag = useRef<Drag | null>(null);
  const [landing, setLanding] = useState<Landing | null>(null);
  const [moving, setMoving] = useState(false);
  // The advisor's view of every line for the order being dragged, fetched once as it is picked up.
  const [help, setHelp] = useState<MoveAdvice | null>(null);
  // The hint follows the cursor by moving itself, so the grid is not redrawn on every mouse move.
  const hintRef = useRef<HTMLDivElement>(null);
  if (!data) return <LoadState error={error} loading={isLoading} />;
  const today = data.today;
  // The advisor's pick for the order being carried: its line, from today at the earliest.
  const best = help?.advice.best ?? null;
  const bestSpot = best?.start ? { lineNo: best.lineNo, start: best.start < today ? today : best.start } : null;

  /** The day a dragged order would start if dropped on `date` - never before today. */
  const startFor = (d: Drag, date: string) => {
    const s = addDays(date, -d.offset);
    return s < today ? today : s;
  };

  const placeHint = (x: number, y: number) => {
    const el = hintRef.current;
    if (!el) return;
    const left = x + 18 + HINT_W > window.innerWidth ? x - HINT_W - 18 : x + 18;
    const top = Math.min(y + 18, window.innerHeight - el.offsetHeight - 8);
    el.style.transform = `translate(${left}px, ${top}px)`;
  };

  function hover(lineNo: number, date: string, x: number, y: number) {
    const d = drag.current;
    if (!d) return;
    placeHint(x, y);
    const start = startFor(d, date);
    const verdict = help && help.order.id === d.orderId ? judgeDrop(data!, help, lineNo, start) : undefined;
    if (landing?.lineNo === lineNo && landing.start === start && !!landing.verdict === !!verdict) return;
    setLanding({ lineNo, start, end: d.requiredDate > start ? d.requiredDate : start, late: start > d.requiredDate, verdict });
  }

  function pickUp(d: Drag) {
    drag.current = d;
    setHelp(null);
    moveAdvice(d.orderId, mode)
      .then((h) => { if (drag.current?.orderId === d.orderId) setHelp(h); })
      .catch(() => { /* the hint is a help, not a need: without it the drag works as before */ });
  }

  function putDown() {
    drag.current = null;
    setLanding(null);
    setHelp(null);
  }

  async function drop(lineNo: number, date: string) {
    const d = drag.current;
    putDown();
    if (!d) return;
    const start = startFor(d, date);
    if (lineNo === d.lineNo && start === d.start) return; // put back where it was
    setMoving(true);
    try {
      const r = await api.post<{ startDate: string | null; targetPerDay: number | null }>(
        `/api/orders/${d.orderId}/move`, { lineNo, startDate: start, pace: mode });
      await refreshAll();
      toast.success(`${d.orderNo} ${d.lineNo ? "moved to" : "scheduled on"} ${lineName(lineNo)}: starts ${fmtDate(r.startDate)}, target ${fmtNum(r.targetPerDay)} a day`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e), { duration: 12000 });
    } finally {
      setMoving(false);
    }
  }

  function openOrder(orderId: number) {
    const o = ordersData?.orders.find((x) => x.id === orderId);
    if (!o) return;
    setEditing(o);
    setOrderOpen(true);
  }

  // Everything before (plan date - 7) folds into one "+" column.
  const cutoff = addDays(data.asOf, -RECENT_DAYS);
  const hidden = data.days.filter((d) => d.date < cutoff).length;
  const collapsed = hidden > 0 && !showEarlier;
  const first = collapsed ? hidden : 0;
  const days = data.days.slice(first);
  const sum = (xs: (number | null | undefined)[]) => xs.reduce<number>((s, x) => s + (x ?? 0), 0);

  const months: { key: string; label: string; span: number }[] = [];
  for (const d of days) {
    const key = d.date.slice(0, 7);
    if (months.at(-1)?.key === key) months.at(-1)!.span++;
    else months.push({ key, label: fmtDate(d.date).slice(3), span: 1 });
  }

  const widths = days.map((_, i) => (data.rows.some((r) => r.cells[first + i]?.parts) ? SHARED_DAY_REM : DAY_REM));
  const widthOf = (from: number, n: number) => widths.slice(from, from + n).reduce((s, w) => s + w, 0);
  /** Column shading shared by the header and every row: weekends grey, today blue, a line at each week and month. */
  const colClass = (i: number) => {
    const d = days[i];
    return cn(!d.working && WEEKEND, d.today && TODAY_COL,
      d.date.endsWith("-01") ? "border-l border-l-border" : weekdayName(d.date) === "Mon" && "border-l border-l-border/40");
  };

  const sticky = "sticky z-10 bg-card";
  const onDay = data.asOf === today ? "today" : `on ${fmtDay(data.asOf)}`;

  // Style search: only the lines carrying a matching order, and on them the other orders in grey.
  const needle = styleQ.trim().toLowerCase();
  const matches = (b: LineBlock) => !needle || b.styleNo.toLowerCase().includes(needle) || b.orderNo.toLowerCase().includes(needle);
  const shownRows = needle ? data.rows.filter((r) => r.blocks.some(matches)) : data.rows;
  const waiting = (data.unscheduled ?? []).filter((u) => !needle || u.styleNo.toLowerCase().includes(needle) || u.orderNo.toLowerCase().includes(needle));
  const matchCount = needle ? data.rows.reduce((n, r) => n + r.blocks.filter(matches).length, 0) : 0;

  return (
    <>
      <PageHeader
        title="Line calendar"
        subtitle={<>{fmtDate(days[0]?.date)} – {fmtDate(data.end)}{collapsed && <> · {hidden} earlier days folded under <b>+</b></>}</>}
        actions={<>
          <SearchBox value={styleQ} onChange={setStyleQ} placeholder="Search style number…" className="w-56" />
          <Button variant="ghost" onClick={() => setShowHelp(!showHelp)} aria-expanded={showHelp}>
            <Info /> How it works <ChevronDown className={cn("transition-transform", showHelp && "rotate-180")} />
          </Button>
          {can("calendar.view") && (
            <Button variant="outline" onClick={() => setIdleOpen(true)}><CalendarOff /> Idle days</Button>
          )}
        </>}
      />

      {/* The two ways of reading a running order's pace, side by side as tabs. */}
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div role="tablist" aria-label="Pace" className="inline-flex rounded-lg bg-muted p-1">
          {(["rolling", "peak"] as const).map((m) => (
            <button key={m} role="tab" type="button" aria-selected={mode === m} onClick={() => setMode(m)}
              className={cn("rounded-md px-4 py-1.5 text-sm font-medium transition-colors",
                mode === m ? "bg-card text-foreground shadow-sm ring-1 ring-foreground/10" : "text-muted-foreground hover:text-foreground")}>
              {m === "rolling" ? "Rolling average" : "Peak pace"}
            </button>
          ))}
        </div>
        <span className="text-sm text-muted-foreground">{MODE_NOTE[mode]}</span>
        {isLoading && <span className="text-xs text-muted-foreground">Updating…</span>}
      </div>

      {showHelp && <HowItWorks canMove={canMove} />}

      <Summary rows={data.rows} onDay={onDay} />

      <Card className="gap-0 overflow-hidden py-0">
        {/* Key, and how to move orders, in one quiet line above the grid. */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b px-4 py-2.5 text-xs text-muted-foreground">
          <Key tone={TONE.onTime} label="Within required date" />
          <Key tone={TONE.late} label="Past required date" />
          <Key tone={TONE.onTime} dashed label="Not started" />
          <span className="inline-flex items-center gap-1.5">
            <span className="flex h-3 w-7 gap-px">
              <span className={cn("w-5 rounded-l-sm border", TONE.late)} />
              <span className={cn("w-2 rounded-r-sm border", TONE.onTime)} />
            </span>
            Changeover day
          </span>
          <Key tone={TONE.clash} label="Two orders at once" />
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3.5 w-0.5 bg-red-500" />
            Required delivery date
          </span>
          <Swatch className={IDLE_FULL} label="Idle" />
          <Swatch className={WEEKEND} label="Non-working" />
          <span className="text-foreground/70"><b className="text-foreground">1,200</b> made that day</span>
          {canMove && (
            <span className="ml-auto inline-flex items-center gap-1.5 text-foreground/80">
              <Move className="size-3.5" />
              {moving ? "Moving…" : "Drag a dashed order to move it · click it to edit"}
            </span>
          )}
        </div>
        {/* Orders taken without a line or scheduling date: dropped on a line and a day, they get both. */}
        {waiting.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b bg-amber-50/60 px-4 py-2.5 text-xs dark:bg-amber-950/20">
            <span className="inline-flex items-center gap-1.5 font-medium text-amber-900 dark:text-amber-200">
              <CalendarClock className="size-3.5" /> Not scheduled ({waiting.length})
            </span>
            <span className="text-muted-foreground">
              {canMove ? "drag one onto a line and a day to give it both" : "no line or date yet"}
            </span>
            {waiting.map((u) => {
              const draggable = canMove && !moving;
              const unset = u.missing.map((m) => (m === "Line" ? "no line" : "no date")).join(", ");
              return (
                <div key={u.orderId}
                  draggable={draggable || undefined}
                  onDragStart={draggable ? (e) => {
                    pickUp({ orderId: u.orderId, orderNo: u.orderNo, lineNo: 0, start: "", offset: 0, requiredDate: u.requiredDate });
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", u.orderNo);
                  } : undefined}
                  onDragEnd={canMove ? putDown : undefined}
                  onClick={canMove ? () => openOrder(u.orderId) : undefined}
                  title={[
                    `${u.orderNo} · ${u.styleNo || "no style"}${u.colour ? ` · ${u.colour}` : ""} · ${fmtNum(u.orderQty)} ${u.unit}`,
                    `Required ${fmtDate(u.requiredDate)}${u.lineNo ? ` · Line ${u.lineNo} picked, no scheduling date` : ""}`,
                    u.targetPerDay ? `Started today it would need ${fmtNum(u.targetPerDay)} a day` : "",
                    canMove ? "Drag onto a line and a day to schedule it · click to fill in its dates" : "",
                  ].filter(Boolean).join("\n")}
                  className={cn("inline-flex items-center gap-1.5 rounded-md border border-dashed border-amber-400 bg-card px-2 py-1 dark:border-amber-700",
                    draggable && "cursor-grab hover:bg-muted active:cursor-grabbing", u.overdue && "border-rose-400 dark:border-rose-700")}>
                  {canMove && <GripVertical className="size-3 text-muted-foreground" />}
                  <span className="font-semibold">{u.orderNo}</span>
                  {u.styleNo && <span className="text-muted-foreground">{u.styleNo}</span>}
                  <span className="tabular-nums">{fmtNum(u.orderQty)}</span>
                  <span className={cn("text-muted-foreground", u.overdue && "font-medium text-rose-700 dark:text-rose-400")}>
                    due {fmtDay(u.requiredDate)}
                  </span>
                  <span className="rounded bg-amber-100 px-1 text-[10px] text-amber-900 dark:bg-amber-950 dark:text-amber-200">{unset}</span>
                </div>
              );
            })}
          </div>
        )}
        {/* While an order is carried: where the advisor would put it, and why. */}
        {help && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-violet-50/70 px-4 py-2 text-xs dark:bg-violet-950/30">
            <Wand2 className="size-3.5 text-violet-600 dark:text-violet-400" />
            {best && bestSpot ? (
              <>
                <span>
                  Best spot for <b>{help.order.orderNo}</b>: <b>{lineName(best.lineNo)}</b> from <b>{fmtDate(bestSpot.start)}</b>
                </span>
                <FitChip fit={best.fit} />
                {best.familyFirst && <FamilyChip />}
                <span className="text-muted-foreground">{best.reasons.slice(1).join(" · ")}</span>
              </>
            ) : (
              <span>No line can take {help.order.orderNo} before its required date.</span>
            )}
            {help.missing.length > 0 && (
              <span className="text-amber-700 dark:text-amber-400">{help.missing.join(", ")} not ticked yet.</span>
            )}
          </div>
        )}
        {needle && (
          <div className="flex items-center gap-2 border-b bg-sky-50/60 px-4 py-2 text-xs dark:bg-sky-950/30">
            <span>
              {matchCount
                ? <><b>{matchCount}</b> order{matchCount === 1 ? "" : "s"} on <b>{shownRows.length}</b> line{shownRows.length === 1 ? "" : "s"} match &ldquo;{styleQ.trim()}&rdquo; - other orders on those lines are grey.</>
                : <>No order matches &ldquo;{styleQ.trim()}&rdquo;.</>}
            </span>
            <Button variant="ghost" size="xs" onClick={() => setStyleQ("")}>Clear</Button>
          </div>
        )}

        <div className="overflow-auto">
          <table className="border-separate border-spacing-0 text-xs">
            <thead>
              <tr>
                <th rowSpan={2} className={cn(sticky, "left-0 w-24 min-w-24 border-b px-4 text-left align-bottom", HEAD)}>Line</th>
                <th rowSpan={2} className={cn(sticky, "left-24 w-60 min-w-60 border-b px-3 text-left align-bottom", HEAD)}>
                  On the line {onDay}
                </th>
                <th rowSpan={2} className={cn(sticky, "left-84 w-28 min-w-28 border-r border-b px-3 text-left align-bottom", HEAD)}>
                  Free from
                </th>
                {hidden > 0 && (
                  <th rowSpan={2} className="w-16 min-w-16 border-r border-b bg-muted/30 px-1 align-middle">
                    <button
                      onClick={() => setShowEarlier(!showEarlier)}
                      title={collapsed
                        ? `Show ${hidden} earlier days: ${fmtDate(data.start)} to ${fmtDate(addDays(cutoff, -1))}`
                        : "Fold the earlier days away again"}
                      className="mx-auto flex flex-col items-center gap-1 rounded-md px-1.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <span className="flex size-5 items-center justify-center rounded-full border bg-background">
                        {collapsed ? <Plus className="size-3" /> : <Minus className="size-3" />}
                      </span>
                      <span className="text-[10px] leading-none font-normal">{collapsed ? `${hidden} days` : "hide"}</span>
                    </button>
                  </th>
                )}
                {months.map((m) => (
                  <th key={m.key} colSpan={m.span} className="border-b border-l border-l-border py-2 text-left text-[13px] font-semibold">
                    <span className="sticky left-[28.5rem] px-3 whitespace-nowrap">{m.label}</span>
                  </th>
                ))}
              </tr>
              <tr>
                {days.map((d, i) => (
                  <th key={d.date} style={{ minWidth: `${widths[i]}rem` }}
                    title={d.idle ? `${d.idle === 1 ? "Full" : "Half"} day idle for all lines` : undefined}
                    className={cn("border-b px-1 pt-1.5 pb-2 text-center font-normal", colClass(i),
                      d.idle === 1 && IDLE_FULL, d.idle === 0.5 && IDLE_HALF)}>
                    <div className={cn("text-[10px] tracking-wide uppercase", d.today ? "font-semibold text-sky-700 dark:text-sky-300" : "text-muted-foreground")}>
                      {weekdayName(d.date)}
                    </div>
                    <div className={cn("mx-auto mt-0.5 flex size-6 items-center justify-center rounded-full text-[13px] font-medium tabular-nums",
                      d.today && "bg-sky-600 text-white")}>
                      {+d.date.slice(8, 10)}
                    </div>
                    {d.idle > 0 && <div className="mt-0.5 text-[9px] font-semibold text-muted-foreground uppercase">{d.idle === 1 ? "idle" : "½ idle"}</div>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shownRows.map((r) => {
                const blockOf = new Map(r.blocks.map((b) => [b.orderId, { b }]));
                const current = r.current !== null ? blockOf.get(r.current)!.b : null;
                const next = r.blocks.find((b) => b.start > data.asOf);
                const cells = r.cells.slice(first);
                const idle = r.idle.slice(first);
                const earlier = sum(r.cells.slice(0, hidden).map((c) => c?.qty));
                const lateNow = !!current && current.end > current.requiredDate;
                // Each order's required delivery date gets a red line on its day, as on the Calendar.
                const dueOn = new Map<string, string[]>();
                for (const b of r.blocks) dueOn.set(b.requiredDate, [...(dueOn.get(b.requiredDate) ?? []), b.orderNo]);
                const freeNow = !current && r.freeFrom <= data.asOf;
                /** Whether day j of this row carries order `id` - as the day's order or as part of a changeover. */
                const has = (j: number, id: number) => {
                  const x = cells[j];
                  return !!x && (x.orderId === id || !!x.parts?.some((p) => p.orderId === id));
                };
                /** Days order `id` runs on from day i, counting i. */
                const runFrom = (i: number, id: number) => {
                  let n = 1;
                  while (i + n < cells.length && has(i + n, id)) n++;
                  return n;
                };
                return (
                  <tr key={r.lineNo} className="group">
                    <td className={cn(sticky, "left-0 h-14 border-b px-4")}>
                      <div className="flex items-center gap-2 font-semibold whitespace-nowrap">
                        <span className={cn("size-2 shrink-0 rounded-full",
                          !current ? "bg-emerald-500" : lateNow ? "bg-rose-500" : "bg-sky-500")} />
                        {lineName(r.lineNo)}
                      </div>
                      {bestSpot?.lineNo === r.lineNo && (
                        <span className="mt-1 inline-flex items-center gap-1 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-800 dark:bg-violet-950 dark:text-violet-300">
                          <Wand2 className="size-3" /> best spot
                        </span>
                      )}
                    </td>
                    <td className={cn(sticky, "left-24 border-b px-3")}>
                      {current ? (
                        <div className="min-w-0" title={`${current.styleNo || "no style"}${current.colour ? ` · ${current.colour}` : ""}`}>
                          <div className="truncate whitespace-nowrap">
                            <span className="font-medium">{current.orderNo}</span>
                            {current.styleNo && <span className="text-muted-foreground"> · {current.styleNo}</span>}
                          </div>
                          <div className="mt-1 flex items-center gap-1.5 whitespace-nowrap text-muted-foreground">
                            <StatusBadge status={current.status} className="h-4 px-1.5 text-[9px]" />
                            <span>until {fmtDay(current.end)}</span>
                          </div>
                        </div>
                      ) : (
                        <div className="whitespace-nowrap">
                          <div className="font-medium text-emerald-700 dark:text-emerald-400">Free</div>
                          <div className="mt-1 text-muted-foreground">
                            {next ? <>Next: {next.orderNo} · {fmtDay(next.start)}</> : "Nothing booked"}
                          </div>
                        </div>
                      )}
                    </td>
                    <td className={cn(sticky, "left-84 border-r border-b px-3 whitespace-nowrap")} title={fmtDate(r.freeFrom)}>
                      {freeNow
                        ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">Now</span>
                        : <span className="font-medium tabular-nums">{fmtDay(r.freeFrom)}</span>}
                    </td>
                    {hidden > 0 && (
                      <td className="border-r border-b bg-muted/30 px-1 text-center tabular-nums text-muted-foreground"
                        title={collapsed ? `Made ${fmtDate(data.start)} to ${fmtDate(addDays(cutoff, -1))}: ${fmtNum(earlier)}` : undefined}>
                        {collapsed && earlier ? fmtNum(earlier) : ""}
                      </td>
                    )}
                    {cells.map((c, i) => {
                      const d = days[i];
                      const info = c ? blockOf.get(c.orderId) : undefined;
                      const clashWith = c?.clash != null ? blockOf.get(c.clash)?.b : undefined;
                      // A day two orders both made something on is shared out by what each made.
                      const parts = c?.parts && !clashWith ? c.parts : null;
                      // Only an order not started yet can be picked up (or opened), and only by someone who may edit orders.
                      const openable = canMove && info?.b.kind === "planned" && !clashWith;
                      const movable = openable && !moving;
                      const landed = !!landing && landing.lineNo === r.lineNo && d.date >= landing.start && d.date <= landing.end;
                      // While an order is carried: the day the advisor would start it on its best line.
                      const bestHere = !!bestSpot && bestSpot.lineNo === r.lineNo && d.date === bestSpot.start;
                      const due = dueOn.get(d.date);
                      const dim = !!info && !matches(info.b);
                      const title = [
                        parts ? sharedTip(parts, blockOf, d.date) : tip(c, info?.b, clashWith, d.date, idle[i]),
                        due && `Required delivery date of ${due.join(", ")} (red line)`,
                        movable ? "Drag to move it · click to change its dates" : openable && "Click to change its dates",
                      ].filter(Boolean).join("\n");
                      return (
                        <td key={d.date}
                          title={title || undefined}
                          draggable={movable || undefined}
                          onDragStart={movable ? (e) => {
                            const b = info!.b;
                            pickUp({
                              orderId: b.orderId, orderNo: b.orderNo, lineNo: r.lineNo, start: b.start,
                              offset: Math.max(0, daysBetween(b.start, d.date)), requiredDate: b.requiredDate,
                            });
                            e.dataTransfer.effectAllowed = "move";
                            e.dataTransfer.setData("text/plain", b.orderNo);
                          } : undefined}
                          onDragEnd={canMove ? putDown : undefined}
                          onDragOver={canMove ? (e) => {
                            if (!drag.current) return;
                            e.preventDefault();
                            e.dataTransfer.dropEffect = "move";
                            hover(r.lineNo, d.date, e.clientX, e.clientY);
                          } : undefined}
                          onDrop={canMove ? (e) => { e.preventDefault(); drop(r.lineNo, d.date); } : undefined}
                          onClick={openable ? () => openOrder(info!.b.orderId) : undefined}
                          className={cn("relative h-14 border-b p-0 tabular-nums", colClass(i),
                            !info && idle[i] === 1 && IDLE_FULL, !info && idle[i] === 0.5 && IDLE_HALF,
                            movable ? "cursor-grab active:cursor-grabbing" : openable && "cursor-pointer",
                            bestHere && !landed && "shadow-[inset_0_0_0_2px_rgb(139_92_246)]",
                            landed && "bg-sky-100/70 outline-2 -outline-offset-4 outline-dashed dark:bg-sky-900/40",
                            landed && OUTLINE[landing!.verdict?.tone ?? (landing!.late ? "bad" : "neutral")])}>
                          {parts ? (
                            <div className="absolute inset-y-2 right-0 left-0 flex gap-0.5">
                              {parts.map((p) => {
                                const b = blockOf.get(p.orderId)?.b;
                                const isFirst = b?.start === d.date || i === 0 || !has(i - 1, p.orderId);
                                const isLast = i === cells.length - 1 || !has(i + 1, p.orderId);
                                const share = Math.max(MIN_PART, p.qty / (c!.qty || 1));
                                return (
                                  <div key={p.orderId} style={{ flex: `${p.qty} 1 0`, minWidth: `${MIN_PART * 100}%` }}
                                    className={cn("relative border-y", toneFor(p.late, b?.kind === "done", !!b && !matches(b)),
                                      isFirst && "ml-1 rounded-l-md border-l", isLast && "mr-1 rounded-r-md border-r")}>
                                    {isFirst && b && (
                                      <BarName maxRem={widths[i] * share + widthOf(i + 1, runFrom(i, p.orderId) - 1)}>
                                        {b.orderNo}{b.kind === "done" && " ✓"}
                                      </BarName>
                                    )}
                                    <BarQty small>{fmtNum(p.qty)}</BarQty>
                                  </div>
                                );
                              })}
                            </div>
                          ) : info ? (
                            (() => {
                              const b = info.b;
                              const isFirst = c!.start || i === 0 || !has(i - 1, b.orderId);
                              const isLast = i === cells.length - 1 || !has(i + 1, b.orderId);
                              return (
                                <div className={cn("absolute inset-y-2 border-y",
                                  clashWith && !dim ? TONE.clash : toneFor(c!.late, b.kind === "done", dim),
                                  isFirst ? "left-1 rounded-l-md border-l" : "left-0",
                                  isLast ? "right-1 rounded-r-md border-r" : "right-0",
                                  b.kind === "planned" && "border-dashed",
                                  !d.working && BAR_OFF_DAY)}>
                                  {isFirst && (
                                    <BarName maxRem={widthOf(i, runFrom(i, b.orderId))}>
                                      {clashWith ? `${b.orderNo} + ${clashWith.orderNo}` : b.orderNo}
                                      {b.kind === "done" && " ✓"}
                                    </BarName>
                                  )}
                                  {c!.qty != null && <BarQty>{fmtNum(c!.qty)}</BarQty>}
                                  {c!.qty == null && idle[i] > 0 && <BarQty muted>{idle[i] === 1 ? "idle" : "½ idle"}</BarQty>}
                                </div>
                              );
                            })()
                          ) : idle[i] > 0 ? (
                            <span className="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-[9px] font-semibold text-muted-foreground uppercase">
                              {idle[i] === 1 ? "idle" : "½ idle"}
                            </span>
                          ) : null}
                          {due && <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 z-[2] w-0.5 bg-red-500" />}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3} className={cn(sticky, "left-0 border-r px-4 py-2.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase")}>
                  Made · all lines
                </td>
                {hidden > 0 && (
                  <td className="border-r bg-muted/30 px-1 text-center font-medium tabular-nums text-muted-foreground">
                    {collapsed && sum(data.totals.slice(0, hidden)) ? fmtNum(sum(data.totals.slice(0, hidden))) : ""}
                  </td>
                )}
                {days.map((d, i) => {
                  const qty = data.totals[first + i];
                  return (
                    <td key={d.date} className={cn("px-1 text-center font-semibold tabular-nums", colClass(i))}>
                      {qty ? fmtNum(qty) : ""}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>

      {can("calendar.view") && <IdleDialog open={idleOpen} onOpenChange={setIdleOpen} />}
      {canMove && <OrderDialog open={orderOpen} onOpenChange={setOrderOpen} order={editing} />}

      {/* Beside the cursor while an order is carried: what dropping it here would mean. */}
      <div
        ref={hintRef}
        aria-live="polite"
        // Placed by placeHint as the mouse moves; this fixed starting value keeps a re-render from undoing that.
        style={{ width: HINT_W, transform: "translate(-9999px, -9999px)" }}
        className={cn("pointer-events-none fixed top-0 left-0 z-50 rounded-lg border-2 bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg",
          landing?.verdict ? HINT[landing.verdict.tone] : "hidden")}
      >
        {landing?.verdict && (
          <>
            <div className="flex items-center gap-1.5 font-medium">
              <span className={cn("size-2 shrink-0 rounded-full", HINT_DOT[landing.verdict.tone])} />
              {landing.verdict.title}
              {landing.verdict.fit && <FitChip fit={landing.verdict.fit} className="ml-auto" />}
            </div>
            <p className="mt-1 leading-snug text-muted-foreground">{landing.verdict.detail}</p>
            {landing.verdict.family && <p className="mt-1 leading-snug text-violet-700 dark:text-violet-400">{landing.verdict.family}</p>}
            {landing.verdict.note && <p className="mt-1 leading-snug text-amber-700 dark:text-amber-400">{landing.verdict.note}</p>}
          </>
        )}
      </div>
    </>
  );
}

const HEAD = "py-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase";

/** Four figures across the top: what is running, what is free, what is late, what frees up next. */
function Summary({ rows, onDay }: { rows: Row[]; onDay: string }) {
  const blocks = rows.flatMap((r) => r.blocks.map((b) => ({ b, lineNo: r.lineNo })));
  const busy = rows.filter((r) => r.current !== null);
  const free = rows.filter((r) => r.current === null);
  const late = blocks.filter(({ b }) => b.kind !== "done" && b.end > b.requiredDate);
  const nextFree = busy.slice().sort((a, b) => a.freeFrom.localeCompare(b.freeFrom))[0];
  const nextOrder = nextFree ? nextFree.blocks.find((b) => b.orderId === nextFree.current) : undefined;
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat label={`Running ${onDay}`} value={`${busy.length}`} unit={`of ${rows.length} lines`} />
      <Stat label="Free now" value={`${free.length}`} tone={free.length ? "text-emerald-700 dark:text-emerald-400" : undefined}
        detail={free.length ? `Line ${free.map((r) => r.lineNo).join(", ")}` : "Every line is busy"} />
      <Stat label="Running late" value={`${late.length}`} tone={late.length ? "text-rose-700 dark:text-rose-400" : undefined}
        detail={late.length ? late.map(({ b, lineNo }) => `${b.orderNo} (L${lineNo})`).join(", ") : "Every order makes its date"} />
      <Stat label="Next line free" value={nextFree ? fmtDay(nextFree.freeFrom) : "—"}
        detail={nextFree ? `${lineName(nextFree.lineNo)}${nextOrder ? ` · after ${nextOrder.orderNo}` : ""}` : "Nothing running"} />
    </div>
  );
}

function Stat({ label, value, unit, detail, tone }: { label: string; value: string; unit?: string; detail?: string; tone?: string }) {
  return (
    <div className="rounded-xl bg-card px-4 py-3 ring-1 ring-foreground/10">
      <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className={cn("text-2xl font-semibold tabular-nums", tone)}>{value}</span>
        {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
      </div>
      {detail && <div className="mt-0.5 truncate text-xs text-muted-foreground" title={detail}>{detail}</div>}
    </div>
  );
}

function HowItWorks({ canMove }: { canMove: boolean }) {
  const points: [string, string][] = [
    ["Not started", "holds its line from its start date (the buffer day included) to its required date."],
    ["Running", "holds it until the balance is finished at its pace - worked out again with every entry, so a faster pace frees days for later orders and a slower one holds more."],
    ["Rolling average", "the pace is the average of every day the order has been worked (or the last few days, if picked in Planning controls on the Dashboard). This is the plan every other page uses."],
    ["Peak pace", "for the first 4 days of production the pace is the order's target; from the 5th day logged it is the best day so far, and it rises whenever a day beats it (500, then 400 stays 500, then 700 makes it 700)."],
    ["Colours", "green up to the required date, red past it. A changeover day is split by what each order made; amber means two orders were logged on one line at once."],
    ["Red line", "each order's required delivery date, as on the Calendar. The bar ends on its expected completion: ending before the line means days to spare, running past it means late."],
    ["Queue", "when work runs over, the next order on that line waits behind it, and its start date and target move."],
    [canMove ? "Moving" : "Lines", canMove
      ? "drag a dashed (not started) order to another day or line, in either view - it starts on the day you drop it, and its expected scheduling date, target and pre-production dates follow. Its required date stays. Click it to type exact dates. Running orders stay put. A drop is checked against the days the view you are in shows free, so a day freed by the peak pace can be taken in that view; every other page then reads the order at the rolling average, and queues it behind work still running."
      : "orders are put on a line in Orders."],
    ["Not scheduled", canMove
      ? "an order saved without a line or an expected scheduling date waits in the strip above the lines. Drag it onto a line and a day and it gets both; until then it books nothing, and nothing can be ticked or logged for it."
      : "an order saved without a line or an expected scheduling date waits in the strip above the lines until both are filled in."],
    ["Style family", "the part of a style number before the \"/\" (OR675/11 and OR675/12). While an order is carried, a line already running its family is marked best first, as long as it can make the date."],
    ["Earlier days", `the + column holds what each line made before the last ${RECENT_DAYS} days; click it to open them. Hover any day for details.`],
  ];
  return (
    <Card className="mb-4 gap-0 py-0">
      <ul className="grid gap-x-8 gap-y-2 px-5 py-4 text-sm md:grid-cols-2">
        {points.map(([k, v]) => (
          <li key={k} className="leading-snug">
            <span className="font-medium">{k}</span> <span className="text-muted-foreground">{v}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function BarName({ maxRem, children }: { maxRem: number; children: React.ReactNode }) {
  return (
    <span className="absolute top-1 left-2 z-[1] truncate text-[11px] leading-none font-semibold whitespace-nowrap"
      style={{ maxWidth: `${Math.max(1, maxRem - 0.9)}rem` }}>
      {children}
    </span>
  );
}

function BarQty({ children, muted, small }: { children: React.ReactNode; muted?: boolean; small?: boolean }) {
  return (
    <span className={cn("absolute inset-x-0 bottom-1 text-center text-[11px] leading-none font-semibold tabular-nums",
      small && "text-[10px]", muted && "text-[9px] font-medium uppercase opacity-70")}>
      {children}
    </span>
  );
}

function Key({ tone, label, dashed }: { tone: string; label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("inline-block h-3 w-6 rounded-sm border", tone, dashed && "border-dashed")} />
      {label}
    </span>
  );
}

function Swatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("inline-block size-3 rounded-sm ring-1 ring-foreground/10", className)} />
      {label}
    </span>
  );
}

function tip(c: LineCell | null, b: LineBlock | undefined, clashWith: LineBlock | undefined, date: string, idle: number) {
  const idleNote = idle ? ` · ${idle === 1 ? "full" : "half"} day idle` : "";
  if (!c || !b) return idle ? `${fmtDate(date)}: ${idle === 1 ? "full" : "half"} day idle` : undefined;
  const lines = [
    `${b.orderNo} · ${b.styleNo || "no style"}${b.colour ? ` · ${b.colour}` : ""} · ${fmtNum(b.orderQty)} ${b.unit}`,
    `${fmtDate(date)}: ${c.qty != null ? `made ${fmtNum(c.qty)}` : "booked"}${idleNote}`,
    `Books the line ${fmtDate(b.start)} – ${fmtDate(b.end)} (${KIND[b.kind]}) · required ${fmtDate(b.requiredDate)}`,
    b.kind === "running" ? `${fmtNum(b.produced)} made, ${fmtNum(b.balance)} left - booked to when that is done ${paceText(b)}`
      : b.kind === "planned" ? "Not started - booked from its start date to its required date" : `Finished: ${fmtNum(b.produced)} made`,
  ];
  if (c.late) lines.push("Past its required delivery date");
  if (b.waitingFor) lines.push(`Waiting for ${b.waitingFor} to finish on this line`);
  if (clashWith) lines.push(`Also booked here: ${clashWith.orderNo} - production is logged for both`);
  return lines.join("\n");
}

/** How a running order's pace was read, for its tooltip. */
function paceText(b: LineBlock): string {
  const per = `${fmtNum(b.pacePerDay)} a day`;
  switch (b.paceBasis) {
    case "target": return `at its target, ${per} - its peak counts from the 5th day logged (${b.daysWorked} so far)`;
    case "peak": return `at its peak pace - its best day so far, ${per}`;
    default: return `at its average pace, ${per}`;
  }
}

function sharedTip(parts: NonNullable<LineCell["parts"]>, blockOf: Map<number, { b: LineBlock }>, date: string) {
  const total = parts.reduce((s, p) => s + p.qty, 0);
  return [
    `${fmtDate(date)}: changeover - ${fmtNum(total)} made on this line`,
    ...parts.map((p) => {
      const b = blockOf.get(p.orderId)?.b;
      const what = b?.start === date ? "started" : b?.end === date && b.kind === "done" ? "finished" : "made";
      return `${b?.orderNo ?? "?"} ${what}: ${fmtNum(p.qty)}${p.late ? " (past its required date)" : ""}`;
    }),
  ].join("\n");
}
