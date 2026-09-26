"use client";

import { useMemo, useState } from "react";
import { Check, Lock } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { MilestoneCell } from "@/components/milestone-cell";
import { useScheduleGate } from "@/components/schedule-gate";
import { EmptyRow, FilterPills, OrderCell, SearchBox, TH } from "@/components/order-cells";
import { LoadState, PageHeader } from "@/components/page-header";
import { LineValue, StartDateValue } from "@/components/start-date";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Guard } from "@/components/guard";
import {
  api, ApiError, lineName, MILESTONES, refreshAll, useCan, useOrders,
  type MilestoneKey, type PlannedOrder, type PreProduction,
} from "@/lib/api";
import { fmtDate, fmtDay, fmtNum } from "@/lib/format";
import { useLast } from "@/lib/use-last";
import { cn } from "@/lib/utils";

type Filter = PreProduction["overall"] | "all";

const OVERALL: Record<PreProduction["overall"], { label: string; style: string; dot: string }> = {
  delayed: { label: "Delayed", style: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300", dot: "bg-red-500" },
  "on-schedule": { label: "On schedule", style: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300", dot: "bg-blue-500" },
  ready: { label: "Ready", style: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300", dot: "bg-emerald-500" },
  none: { label: "—", style: "text-muted-foreground", dot: "bg-slate-400" },
};

type Undo = { order: PlannedOrder; key: MilestoneKey; label: string };

export default function PreProductionPage() {
  return <Guard need="preproduction.view"><PreProduction /></Guard>;
}

function PreProduction() {
  const { data, error, isLoading } = useOrders();
  const canEdit = useCan().can("preproduction.edit");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [undo, setUndo] = useState<Undo | null>(null);
  const shownUndo = useLast(undo);
  const { gate, caught, popup } = useScheduleGate();

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.orders ?? [])
      .filter((o) => (filter === "all" || o.plan.preProduction.overall === filter) &&
        (!needle || [o.orderNo, lineName(o.lineNo), o.styleNo, o.colour].some((v) => v.toLowerCase().includes(needle))))
      // Soonest start first; orders without one (finished) last.
      .sort((a, b) => (a.plan.startDate ?? "9999").localeCompare(b.plan.startDate ?? "9999"));
  }, [data, q, filter]);

  if (!data) return <LoadState error={error} loading={isLoading} />;

  async function tick(o: PlannedOrder, key: MilestoneKey, label: string) {
    // No line or scheduling date yet: nothing can be ticked - the popup says so and offers to fill them in.
    if (!gate(o, `ticking ${label}`)) return;
    try {
      await api.post(`/api/orders/${o.id}/milestones/${key}`, {});
      await refreshAll();
      toast.success(`${label} marked done for ${o.orderNo}`);
    } catch (e) {
      if (!caught(e, o, `ticking ${label}`)) toast.error(e instanceof ApiError ? e.message : String(e));
    }
  }

  const count = (f: PreProduction["overall"]) => data.orders.filter((o) => o.plan.preProduction.overall === f).length;
  const pills = [
    { value: "all" as Filter, label: "All", count: data.orders.length },
    ...(["delayed", "on-schedule", "ready"] as const).map((f) => ({ value: f as Filter, label: OVERALL[f].label, count: count(f), dot: OVERALL[f].dot })),
  ];

  return (
    <>
      <PageHeader
        title="Pre-production"
        subtitle={<>Fabric, cutting and accessories against each order&apos;s start date · as of {fmtDate(data.asOf)}</>}
      />

      <Card className="gap-0 py-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <FilterPills items={pills} value={filter} onChange={setFilter} />
          <SearchBox value={q} onChange={setQ} placeholder="Search order, line, style, colour…" className="w-full sm:w-72" />
        </div>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={`${TH} pl-4`}>Order</TableHead>
              <TableHead className={TH}>Line</TableHead>
              <TableHead className={`${TH} text-right`}>Qty</TableHead>
              <TableHead className={`${TH} pl-4`}>Start · due</TableHead>
              {MILESTONES.map((m) => (
                <TableHead key={m.key} className={`${TH} border-l pl-4`}>
                  {m.label} <span className="font-normal normal-case tracking-normal">· {m.lead} d before start</span>
                </TableHead>
              ))}
              <TableHead className={`${TH} border-l pr-4 pl-4`}>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((o) => {
              const pp = o.plan.preProduction;
              const locked = pp.overall !== "ready" && o.plan.status !== "COMPLETED";
              return (
                <TableRow key={o.id}>
                  <TableCell className="py-3 pl-4"><OrderCell o={o} /></TableCell>
                  <TableCell><LineValue order={o} /></TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmtNum(o.orderQty)} <span className="text-xs text-muted-foreground">{o.unit}</span>
                  </TableCell>
                  <TableCell className="pl-4">
                    <div className="text-xs text-muted-foreground">
                      Start <span className="text-sm text-foreground"><StartDateValue order={o} asOf={data.asOf} /></span>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">Due {fmtDay(o.requiredDate)}</div>
                  </TableCell>
                  {MILESTONES.map((m) => (
                    <TableCell key={m.key} className="border-l pl-4">
                      <MilestoneCell ms={pp[m.key]} canEdit={canEdit} canUndo={canEdit && o.plan.produced === 0}
                        onTick={() => tick(o, m.key, m.label)}
                        onUndo={() => setUndo({ order: o, key: m.key, label: m.label })} />
                    </TableCell>
                  ))}
                  <TableCell className="border-l pr-4 pl-4">
                    {pp.overall !== "none" && (
                      <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase", OVERALL[pp.overall].style)}>
                        {OVERALL[pp.overall].label}{pp.overall === "delayed" && ` ${pp.delayDays} d`}
                      </span>
                    )}
                    <div className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                      {!o.plan.scheduled && o.plan.produced === 0
                        ? <><Lock className="size-3" /> Needs line &amp; date</>
                        : locked
                        ? <><Lock className="size-3" /> Production locked</>
                        : o.plan.status === "COMPLETED" ? "Order complete"
                        : <><Check className="size-3 text-emerald-600" /> Production open{pp.delayDays > 0 && ` · was ${pp.delayDays} d late`}</>}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {!rows.length && <EmptyRow span={8}>{data.orders.length ? "No orders match." : "No orders yet."}</EmptyRow>}
          </TableBody>
        </Table>
      </Card>

      <p className="mt-3 text-xs text-muted-foreground">
        {canEdit && <>Press <b>Mark done</b> when an item arrives - today&apos;s date and time are saved. </>}
        Start date = order qty ÷ target per day, counted back from the required date, less 1 buffer day. An order with no
        line or expected scheduling date yet has no start date, so nothing is due - and nothing can be ticked until both
        are filled in. Production can be logged only once all three are ticked, and after that the ticks stay.
      </p>

      {popup}

      <ConfirmDialog
        open={!!undo}
        onOpenChange={(o) => !o && setUndo(null)}
        title={`Clear "${shownUndo?.label}" for ${shownUndo?.order.orderNo}?`}
        confirmLabel="Clear it"
        destructive
        onConfirm={async () => {
          if (!undo) return;
          try {
            await api.del(`/api/orders/${undo.order.id}/milestones/${undo.key}`);
            await refreshAll();
            setUndo(null);
          } catch (e) {
            toast.error(e instanceof ApiError ? e.message : String(e));
          }
        }}
      >
        <p>It goes back to not done. Use this only if it was ticked by mistake.</p>
      </ConfirmDialog>
    </>
  );
}
