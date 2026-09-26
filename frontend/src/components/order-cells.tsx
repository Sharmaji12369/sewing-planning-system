// The pieces the Orders, Dashboard and Pre-production tables are built from:
// one cell per idea (the order, its progress, pace against target, delivery)
// instead of one column per number.

import type { ReactNode } from "react";
import { Search } from "lucide-react";
import { StartDateValue } from "@/components/start-date";
import { TargetValue } from "@/components/target-value";
import { Input } from "@/components/ui/input";
import type { PlannedOrder, Status } from "@/lib/api";
import { fmtBuffer, fmtDate, fmtDay, fmtNum, fmtPct } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Dot and bar colour for each order status (the badges keep their own colours). */
export const STATUS_TONE: Record<Status, string> = {
  "BEHIND SCHEDULE": "bg-red-500",
  "AT RISK": "bg-amber-500",
  "ON TRACK": "bg-emerald-500",
  "NOT STARTED": "bg-slate-400",
  COMPLETED: "bg-blue-500",
};

/** Header cells: small, quiet, uppercase - the numbers below do the talking. */
export const TH = "h-10 text-[11px] font-medium tracking-wide text-muted-foreground uppercase";

/** Order No, with style and colour beneath; its notes on hover. */
export function OrderCell({ o }: { o: PlannedOrder }) {
  const sub = [o.styleNo, o.colour].filter(Boolean).join(" · ");
  return (
    <div className="min-w-0" title={o.notes || undefined}>
      <div className="font-medium whitespace-nowrap">{o.orderNo}</div>
      <div className="max-w-52 truncate text-xs text-muted-foreground">{sub || "no style"}</div>
    </div>
  );
}

/** Made out of the order, as a bar in the status colour, and what is left. */
export function ProgressCell({ o }: { o: PlannedOrder }) {
  const p = o.plan;
  const when = p.firstProduction
    ? p.status === "COMPLETED"
      ? `${fmtDay(p.firstProduction)} – ${fmtDay(p.lastProduction!)}`
      : `since ${fmtDay(p.firstProduction)}`
    : "not started";
  return (
    <div className="w-48" title={p.firstProduction ? `First production ${fmtDate(p.firstProduction)} · last ${fmtDate(p.lastProduction)}` : undefined}>
      <div className="flex items-baseline justify-between gap-2 whitespace-nowrap tabular-nums">
        <span>
          <span className="font-semibold">{fmtNum(p.produced)}</span>
          <span className="text-xs text-muted-foreground"> / {fmtNum(o.orderQty)} {o.unit}</span>
        </span>
        <span className="text-xs text-muted-foreground">{fmtPct(p.pctComplete)}</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", STATUS_TONE[p.status])} style={{ width: `${Math.min(100, p.pctComplete * 100)}%` }} />
      </div>
      <div className="mt-1 text-[11px] whitespace-nowrap text-muted-foreground">
        {p.balance ? `${fmtNum(p.balance)} to go` : "all made"} · {when}
        {p.overBy > 0 && <span className="text-red-700 dark:text-red-400"> · over by {fmtNum(p.overBy)}</span>}
      </div>
    </div>
  );
}

/** Pace (average per worked day) above the target it needs; the target goes red when the pace falls short. */
export function PaceCell({ o, paceTitle }: { o: PlannedOrder; paceTitle?: string }) {
  const p = o.plan;
  return (
    <div className="ml-auto grid w-max grid-cols-[auto_auto] items-baseline gap-x-2.5 gap-y-1 text-right whitespace-nowrap tabular-nums">
      <span className="text-[11px] text-muted-foreground">Pace</span>
      <span className="font-medium" title={p.pacePerDay != null ? paceTitle : "Appears once production is logged"}>{fmtNum(p.pacePerDay)}</span>
      <span className="text-[11px] text-muted-foreground">Target</span>
      <span><TargetValue plan={p} /></span>
    </div>
  );
}

/** Required date, the expected (or actual) finish, and the working-day margin between them. */
export function DeliveryCell({ o }: { o: PlannedOrder }) {
  const p = o.plan;
  const late = p.bufferDays != null && p.bufferDays < 0;
  const left = p.workingDaysLeft != null ? `${fmtNum(p.workingDaysLeft, 1)} working days left` : undefined;
  return (
    <div className="whitespace-nowrap" title={left}>
      <div className="text-xs text-muted-foreground">
        Due <span className="text-sm font-medium text-foreground">{fmtDate(o.requiredDate)}</span>
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        {p.projectedFinish ? (
          <span>
            {p.status === "COMPLETED" ? "Done" : "Expected"}{" "}
            <span className={cn("font-medium", late ? "text-red-700 dark:text-red-400" : "text-foreground")}>{fmtDay(p.projectedFinish)}</span>
          </span>
        ) : (
          <span>{left ?? "—"}</span>
        )}
        {p.bufferDays != null && <BufferChip days={p.bufferDays} />}
      </div>
    </div>
  );
}

function BufferChip({ days }: { days: number }) {
  return (
    <span className={cn("rounded-full px-1.5 py-px text-[10px] font-semibold",
      days < 0 ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
        : days <= 1 ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
        : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300")}>
      {fmtBuffer(days)}
    </span>
  );
}

/** Start date (with its "after ORD-…" note when it waits for its line) above the expected scheduling date. */
export function ScheduleCell({ o, asOf }: { o: PlannedOrder; asOf: string }) {
  return (
    <div className="whitespace-nowrap">
      <div className="text-xs text-muted-foreground">
        Start <span className="text-sm text-foreground"><StartDateValue order={o} asOf={asOf} /></span>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {o.planningDate ? <>Scheduled {fmtDay(o.planningDate)}</> : "No scheduling date yet"}
      </div>
    </div>
  );
}

export interface Pill<T extends string> { value: T; label: string; count: number; dot?: string }

/** Filter buttons that also say how many there are of each. */
export function FilterPills<T extends string>({ items, value, onChange }: {
  items: Pill<T>[]; value: T; onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="tablist">
      {items.map((i) => {
        const on = i.value === value;
        return (
          <button key={i.value} type="button" role="tab" aria-selected={on} onClick={() => onChange(i.value)}
            className={cn("inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium whitespace-nowrap ring-1 transition-colors",
              on ? "bg-foreground text-background ring-foreground" : "bg-card text-foreground ring-foreground/10 hover:bg-muted")}>
            {i.dot && <span className={cn("size-2 rounded-full", i.dot)} />}
            {i.label}
            <span className={cn("tabular-nums", on ? "opacity-75" : "text-muted-foreground")}>{i.count}</span>
          </button>
        );
      })}
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder, className }: {
  value: string; onChange: (v: string) => void; placeholder: string; className?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder}
        className="h-8 bg-card pl-8" />
    </div>
  );
}

/** A table that can say there is nothing to show. */
export function EmptyRow({ span, children }: { span: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={span} className="py-12 text-center text-sm text-muted-foreground">{children}</td>
    </tr>
  );
}
