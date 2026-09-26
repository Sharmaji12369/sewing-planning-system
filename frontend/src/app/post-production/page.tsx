"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { MilestoneCell } from "@/components/milestone-cell";
import { useScheduleGate } from "@/components/schedule-gate";
import { EmptyRow, FilterPills, OrderCell, SearchBox, TH } from "@/components/order-cells";
import { LoadState, PageHeader } from "@/components/page-header";
import { LineValue } from "@/components/start-date";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Guard } from "@/components/guard";
import { api, ApiError, lineName, MILESTONES, PACKING_DAYS, refreshAll, useCan, useOrders, type PlannedOrder } from "@/lib/api";
import { fmtDate, fmtDay, fmtNum } from "@/lib/format";
import { useLast } from "@/lib/use-last";
import { cn } from "@/lib/utils";

/** Where an order stands on packing - most urgent first. */
type PackState = "overdue" | "to-pack" | "in-production" | "packed";
type Filter = PackState | "all";

const PACK: Record<PackState, { label: string; style: string; dot: string }> = {
  overdue: { label: "Overdue", style: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300", dot: "bg-red-500" },
  "to-pack": { label: "To pack", style: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300", dot: "bg-amber-500" },
  "in-production": { label: "In production", style: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300", dot: "bg-blue-500" },
  packed: { label: "Packed", style: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300", dot: "bg-emerald-500" },
};
const ORDER: PackState[] = ["overdue", "to-pack", "in-production", "packed"];

function packState(o: PlannedOrder): PackState {
  if (o.packedAt) return "packed";
  if (o.plan.status !== "COMPLETED") return "in-production";
  return o.plan.postProduction.packing.state === "overdue" ? "overdue" : "to-pack";
}

export default function PostProductionPage() {
  return <Guard need="postproduction.view"><PostProduction /></Guard>;
}

function PostProduction() {
  const { data, error, isLoading } = useOrders();
  const canEdit = useCan().can("postproduction.edit");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [undo, setUndo] = useState<PlannedOrder | null>(null);
  const shownUndo = useLast(undo);
  const { gate, caught, popup } = useScheduleGate();

  // Only orders that have started production have anything to pack.
  const started = useMemo(() => (data?.orders ?? []).filter((o) => o.plan.produced > 0), [data]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return started
      .filter((o) => (filter === "all" || packState(o) === filter) &&
        (!needle || [o.orderNo, lineName(o.lineNo), o.styleNo, o.colour].some((v) => v.toLowerCase().includes(needle))))
      .sort((a, b) => ORDER.indexOf(packState(a)) - ORDER.indexOf(packState(b))
        || (a.plan.postProduction.packing.expected ?? "9999").localeCompare(b.plan.postProduction.packing.expected ?? "9999"));
  }, [started, q, filter]);

  if (!data) return <LoadState error={error} loading={isLoading} />;

  async function pack(o: PlannedOrder) {
    if (!gate(o, "ticking packing")) return;
    try {
      await api.post(`/api/orders/${o.id}/packing`, {});
      await refreshAll();
      toast.success(`Packing marked done for ${o.orderNo}`);
    } catch (e) {
      if (!caught(e, o, "ticking packing")) toast.error(e instanceof ApiError ? e.message : String(e));
    }
  }

  const pills = [
    { value: "all" as Filter, label: "All", count: started.length },
    ...ORDER.map((s) => ({ value: s as Filter, label: PACK[s].label, count: started.filter((o) => packState(o) === s).length, dot: PACK[s].dot })),
  ];

  return (
    <>
      <PageHeader
        title="Post-production"
        subtitle={<>Packing for every order in production or finished · due {PACKING_DAYS} days after the order is complete · as of {fmtDate(data.asOf)}</>}
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
              <TableHead className={`${TH} pl-4`}>Completion</TableHead>
              {MILESTONES.map((m) => <TableHead key={m.key} className={`${TH} border-l pl-4`}>{m.label}</TableHead>)}
              <TableHead className={`${TH} border-l bg-muted/40 pl-4`}>
                Packing <span className="font-normal tracking-normal normal-case">· {PACKING_DAYS} d after completion</span>
              </TableHead>
              <TableHead className={`${TH} border-l pr-4 pl-4`}>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((o) => {
              const p = o.plan;
              const st = packState(o);
              const done = p.status === "COMPLETED";
              return (
                <TableRow key={o.id}>
                  <TableCell className="py-3 pl-4"><OrderCell o={o} /></TableCell>
                  <TableCell><LineValue order={o} /></TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmtNum(p.produced)}<span className="text-xs text-muted-foreground"> / {fmtNum(o.orderQty)}</span>
                  </TableCell>
                  <TableCell className="pl-4">
                    <div className="text-xs text-muted-foreground">
                      {done ? "Completed" : "Expected"}{" "}
                      <span className={cn("text-sm font-medium", done ? "text-foreground" : "text-muted-foreground")}>{fmtDay(p.projectedFinish ?? o.requiredDate)}</span>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">Due {fmtDay(o.requiredDate)}</div>
                  </TableCell>
                  {MILESTONES.map((m) => (
                    <TableCell key={m.key} className="border-l pl-4">
                      <MilestoneCell ms={p.preProduction[m.key]} readOnly />
                    </TableCell>
                  ))}
                  <TableCell className="border-l bg-muted/20 pl-4">
                    <MilestoneCell ms={p.postProduction.packing} canEdit={canEdit} canUndo={canEdit}
                      blocked={!done ? "After production" : undefined}
                      onTick={() => pack(o)} onUndo={() => setUndo(o)} />
                  </TableCell>
                  <TableCell className="border-l pr-4 pl-4">
                    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase", PACK[st].style)}>{PACK[st].label}</span>
                    <div className="mt-1.5 text-[11px] text-muted-foreground">
                      {st === "in-production" ? `${fmtNum(p.balance)} still to make` : st === "packed" ? "Order closed" : "Ready to pack"}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {!rows.length && (
              <EmptyRow span={9}>
                {started.length ? "No orders match." : "Nothing in production yet - orders appear here once production is logged."}
              </EmptyRow>
            )}
          </TableBody>
        </Table>
      </Card>

      <p className="mt-3 text-xs text-muted-foreground">
        Fabric, cutting and accessories are shown as ticked on Pre-production and cannot be changed here.
        {canEdit && <> Press <b>Mark done</b> when an order is packed - today&apos;s date and time are saved.</>} Packing can be
        ticked once production is complete; while an order is still running its packing date follows its expected completion.
      </p>

      {popup}

      <ConfirmDialog
        open={!!undo}
        onOpenChange={(o) => !o && setUndo(null)}
        title={`Clear packing for ${shownUndo?.orderNo}?`}
        confirmLabel="Clear it"
        destructive
        onConfirm={async () => {
          if (!undo) return;
          try {
            await api.del(`/api/orders/${undo.id}/packing`);
            await refreshAll();
            setUndo(null);
          } catch (e) {
            toast.error(e instanceof ApiError ? e.message : String(e));
          }
        }}
      >
        <p>It goes back to not packed. Use this only if it was ticked by mistake.</p>
      </ConfirmDialog>
    </>
  );
}
