"use client";

import { useState } from "react";
import { CalendarOff, Minus, Plus } from "lucide-react";
import { IdleDialog } from "@/components/idle-dialog";
import { LoadState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Guard } from "@/components/guard";
import { lineName, useCalendar } from "@/lib/api";
import { addDays, fmtDate, fmtNum, weekdayName } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Days before the plan date shown without opening the earlier-days column. */
const RECENT_DAYS = 7;

const CELL = {
  met: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  below: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  late: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};
const IDLE_FULL = "bg-slate-200/80 text-slate-600 dark:bg-slate-700/60 dark:text-slate-300";
const IDLE_HALF = "bg-orange-50 text-orange-700 dark:bg-orange-950/50 dark:text-orange-300";

export default function CalendarPage() {
  return <Guard need="calendar.view"><Calendar /></Guard>;
}

function Calendar() {
  const { data, error, isLoading } = useCalendar();
  const [showEarlier, setShowEarlier] = useState(false);
  const [idleOpen, setIdleOpen] = useState(false);
  if (!data) return <LoadState error={error} loading={isLoading} />;

  // Everything before (plan date - 7) folds into one "+" column.
  const cutoff = addDays(data.asOf, -RECENT_DAYS);
  const hidden = data.days.filter((d) => d.date < cutoff).length; // days are in date order
  const collapsed = hidden > 0 && !showEarlier;
  const first = collapsed ? hidden : 0;
  const days = data.days.slice(first);
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const earlierTotal = sum(data.totals.slice(0, hidden));

  // One header cell per month, spanning its days.
  const months: { key: string; label: string; span: number }[] = [];
  for (const d of days) {
    const key = d.date.slice(0, 7);
    if (months.at(-1)?.key === key) months.at(-1)!.span++;
    else months.push({ key, label: `${fmtDate(d.date).slice(3)}`, span: 1 });
  }

  // Sticky left block: order, line/style, qty, pace, target, expected completion (33.5rem in all).
  const sticky = "sticky z-10 bg-card";
  return (
    <>
      <PageHeader
        title="Production calendar"
        subtitle={collapsed
          ? <>Daily output per order, {fmtDate(days[0]?.date)} to {fmtDate(data.end)} · {hidden} earlier day{hidden === 1 ? "" : "s"} folded under <b>+</b></>
          : <>Daily output per order, {fmtDate(data.start)} to {fmtDate(data.end)}</>}
        actions={<Button variant="outline" onClick={() => setIdleOpen(true)}><CalendarOff /> Idle days</Button>}
      />

      <div className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <Legend className={CELL.met} label="Made at least what the order needed that day" />
        <Legend className={CELL.below} label="Made less than it needed" />
        <Legend className={CELL.late} label="Made after the required delivery date" />
        <Legend className={IDLE_FULL} label="Idle, full day" />
        <Legend className={IDLE_HALF} label="Idle, half day" />
        <Legend className="bg-muted" label="Non-working day" />
        <span>Blank = nothing logged.</span>
      </div>

      <Card className="overflow-hidden py-0">
        <div className="overflow-auto">
          <table className="border-separate border-spacing-0 text-xs">
            <thead>
              <tr>
                <th className={cn(sticky, "left-0 w-30 min-w-30 max-w-30 border-b px-2 py-1.5 text-left font-medium")} rowSpan={3}>Order</th>
                <th className={cn(sticky, "left-30 w-24 min-w-24 border-b px-2 text-left font-medium")} rowSpan={3}>Line / style</th>
                <th className={cn(sticky, "left-54 w-18 min-w-18 border-b px-2 text-right font-medium")} rowSpan={3}>Qty</th>
                <th className={cn(sticky, "left-72 w-18 min-w-18 border-b px-2 text-right font-medium")} rowSpan={3}>Pace</th>
                <th className={cn(sticky, "left-90 w-18 min-w-18 border-b px-2 text-right font-medium")} rowSpan={3}>Target</th>
                <th className={cn(sticky, "left-[27rem] w-26 min-w-26 border-r border-b px-2 text-left font-medium leading-tight")} rowSpan={3}>
                  Expected completion
                </th>
                {hidden > 0 && (
                  <th rowSpan={3} className="min-w-16 border-r border-b bg-muted/40 px-1 align-middle">
                    <button
                      onClick={() => setShowEarlier(!showEarlier)}
                      title={collapsed
                        ? `Show ${hidden} earlier days: ${fmtDate(data.start)} to ${fmtDate(addDays(cutoff, -1))}`
                        : "Fold the earlier days away again"}
                      className="mx-auto flex flex-col items-center gap-0.5 rounded-md px-1.5 py-1 font-normal text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <span className="flex size-5 items-center justify-center rounded-full border bg-background">
                        {collapsed ? <Plus className="size-3" /> : <Minus className="size-3" />}
                      </span>
                      <span className="text-[10px] leading-tight">{collapsed ? `${hidden} days` : "hide"}</span>
                    </button>
                  </th>
                )}
                {months.map((m, i) => (
                  <th key={m.key} colSpan={m.span}
                    className={cn("border-b py-1.5 text-left font-semibold", i > 0 && "border-l")}>
                    {/* Stays in view, just right of the pinned columns, while its month scrolls past. */}
                    <span className="sticky left-[34rem] px-2 whitespace-nowrap">{m.label}</span>
                  </th>
                ))}
              </tr>
              <tr>
                {days.map((d) => (
                  <th key={d.date} className={cn("min-w-14 px-1 pt-1.5 text-center font-normal text-muted-foreground",
                    !d.working && "bg-muted", d.idle === 1 && IDLE_FULL, d.idle === 0.5 && IDLE_HALF,
                    d.today && "bg-blue-600 text-white")}>
                    {weekdayName(d.date)}
                  </th>
                ))}
              </tr>
              <tr>
                {days.map((d) => (
                  <th key={d.date}
                    title={d.idle ? `${d.idle === 1 ? "Full" : "Half"} day idle for all lines` : undefined}
                    className={cn("border-b px-1 pb-1.5 text-center font-medium",
                      !d.working && "bg-muted", d.idle === 1 && IDLE_FULL, d.idle === 0.5 && IDLE_HALF,
                      d.today && "bg-blue-600 text-white")}>
                    {+d.date.slice(8, 10)}
                    {d.idle > 0 && <span className="block text-[9px] font-semibold uppercase">{d.idle === 1 ? "idle" : "½ idle"}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const earlier = sum(r.cells.slice(0, hidden).map((c) => c?.qty ?? 0));
                const dueHidden = collapsed && r.requiredDate < cutoff && r.requiredDate >= data.start;
                const short = r.overdue || (r.pacePerDay != null && r.targetPerDay != null && r.pacePerDay < r.targetPerDay);
                const late = !!r.projectedFinish && r.projectedFinish > r.requiredDate;
                const idle = r.idle.slice(first);
                return (
                  <tr key={r.orderId}>
                    <td className={cn(sticky, "left-0 border-b px-2 py-1.5")}>
                      <div className="font-medium">{r.orderNo}</div>
                      <StatusBadge status={r.status} className="mt-0.5 h-4 px-1.5 text-[9px]" />
                    </td>
                    <td className={cn(sticky, "left-30 border-b px-2")}>
                      <div className="truncate">{lineName(r.lineNo)}</div>
                      <div className="truncate text-muted-foreground">{r.styleNo || "—"}</div>
                    </td>
                    <td className={cn(sticky, "left-54 border-b px-2 text-right tabular-nums")}>{fmtNum(r.orderQty)}</td>
                    <td className={cn(sticky, "left-72 border-b px-2 text-right tabular-nums")}>{fmtNum(r.pacePerDay)}</td>
                    <td className={cn(sticky, "left-90 border-b px-2 text-right tabular-nums",
                      short && "font-semibold text-red-700 dark:text-red-400")}
                      title={r.overdue ? "Past the delivery date: the whole balance is needed now" : undefined}>
                      {fmtNum(r.targetPerDay)}
                    </td>
                    <td className={cn(sticky, "left-[27rem] border-r border-b px-2 tabular-nums whitespace-nowrap",
                      late && "font-semibold text-red-700 dark:text-red-400",
                      r.status === "COMPLETED" && "text-blue-700 dark:text-blue-400")}
                      title={r.status === "COMPLETED" ? "Finished on this day"
                        : r.projectedFinish ? `At the current pace of ${fmtNum(r.pacePerDay)} a day${late ? `, ${fmtDate(r.requiredDate)} is missed` : ""}`
                        : "Appears once production is logged - it comes from the pace"}>
                      {fmtDate(r.projectedFinish)}
                      {r.status === "COMPLETED" && <span className="block text-[9px] font-semibold uppercase">done</span>}
                    </td>
                    {hidden > 0 && (
                      <td
                        className={cn("border-r border-b bg-muted/40 px-1 text-center tabular-nums text-muted-foreground",
                          dueHidden && "shadow-[inset_-2px_0_0_0_var(--color-red-500)]")}
                        title={collapsed
                          ? `Made ${fmtDate(data.start)} to ${fmtDate(addDays(cutoff, -1))}: ${fmtNum(earlier)}`
                            + (dueHidden ? ` · required delivery ${fmtDate(r.requiredDate)} is in these days` : "")
                          : undefined}
                      >
                        {collapsed && earlier ? fmtNum(earlier) : ""}
                      </td>
                    )}
                    {r.cells.slice(first).map((c, i) => {
                      const d = days[i];
                      const due = d.date === r.requiredDate;
                      const idl = idle[i];
                      const idleNote = idl ? ` · ${idl === 1 ? "full" : "half"} day idle` : "";
                      return (
                        <td key={d.date}
                          title={c ? `${fmtDate(d.date)}: made ${fmtNum(c.qty)}${c.needed ? `, needed ${fmtNum(c.needed)}` : ""}${idleNote}`
                            : idl ? `${fmtDate(d.date)}: ${idl === 1 ? "full" : "half"} day idle` : due ? "Required delivery date" : undefined}
                          className={cn("border-b px-1 text-center tabular-nums",
                            c ? CELL[c.state] : idl === 1 ? IDLE_FULL : idl === 0.5 ? IDLE_HALF : !d.working && "bg-muted/60",
                            due && "shadow-[inset_-2px_0_0_0_var(--color-red-500)]")}>
                          {c ? fmtNum(c.qty) : idl ? <span className="text-[9px] font-semibold uppercase">{idl === 1 ? "idle" : "½"}</span> : ""}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {!data.rows.length && (
                <tr><td colSpan={6 + (hidden > 0 ? 1 : 0) + days.length} className="py-10 text-center text-muted-foreground">No orders yet.</td></tr>
              )}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <td className={cn(sticky, "left-0 px-2 py-2")}>Daily total</td>
                <td className={cn(sticky, "left-30")} />
                <td className={cn(sticky, "left-54")} />
                <td className={cn(sticky, "left-72")} />
                <td className={cn(sticky, "left-90")} />
                <td className={cn(sticky, "left-[27rem] border-r")} />
                {hidden > 0 && (
                  <td className="border-r bg-muted/40 px-1 text-center tabular-nums text-muted-foreground">
                    {collapsed && earlierTotal ? fmtNum(earlierTotal) : ""}
                  </td>
                )}
                {data.totals.slice(first).map((t, i) => (
                  <td key={days[i].date} className={cn("px-1 text-center tabular-nums", !days[i].working && "bg-muted/60")}>
                    {t ? fmtNum(t) : ""}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>
      <p className="mt-3 text-xs text-muted-foreground">
        Expected completion is when the order finishes at its current pace (the rolling average of its recent daily
        output), skipping non-working and idle days. A red line on the right of a cell marks the required delivery
        date. Hover a cell to see what the order needed that day. The grey column holds each order&apos;s output before
        the last {RECENT_DAYS} days; click its <b>+</b> to open those days.
      </p>

      <IdleDialog open={idleOpen} onOpenChange={setIdleOpen} />
    </>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("inline-block size-3 rounded-sm", className)} />
      {label}
    </span>
  );
}
