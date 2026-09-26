"use client";

import { useMemo, useState } from "react";
import { NotebookPen, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EntryDialog } from "@/components/entry-dialog";
import { OrderDialog } from "@/components/order-dialog";
import { useScheduleGate } from "@/components/schedule-gate";
import {
  DeliveryCell, EmptyRow, FilterPills, OrderCell, PaceCell, ProgressCell, ScheduleCell, SearchBox, STATUS_TONE, TH,
} from "@/components/order-cells";
import { LoadState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { LineValue } from "@/components/start-date";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Guard } from "@/components/guard";
import {
  api, ApiError, lineName, refreshAll, scheduleMissing, STATUSES, useCan, useOrders, type PlannedOrder, type Status,
} from "@/lib/api";
import { fmtDate, fmtNum } from "@/lib/format";
import { useLast } from "@/lib/use-last";

const ALL = "all";
const SHORT: Record<Status, string> = {
  "BEHIND SCHEDULE": "Behind", "AT RISK": "At risk", "ON TRACK": "On track", "NOT STARTED": "Not started", COMPLETED: "Completed",
};

export default function OrdersPage() {
  return <Guard need="orders.view"><Orders /></Guard>;
}

function Orders() {
  const { data, error, isLoading } = useOrders();
  const { can } = useCan();
  const canEdit = can("orders.edit");
  const canLog = can("log.edit");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<Status | typeof ALL>(ALL);
  const [editing, setEditing] = useState<PlannedOrder | null>(null);
  const [orderOpen, setOrderOpen] = useState(false);
  const [logFor, setLogFor] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<PlannedOrder | null>(null);
  const shownDelete = useLast(deleting);
  const { gate, popup } = useScheduleGate();

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.orders ?? []).filter((o) =>
      (status === ALL || o.plan.status === status) &&
      (!needle || [o.orderNo, lineName(o.lineNo), o.styleNo, o.colour].some((v) => v.toLowerCase().includes(needle))));
  }, [data, q, status]);

  if (!data) return <LoadState error={error} loading={isLoading} />;

  // Taken without a line or a scheduling date: they hold no line, and nothing can be entered for them yet.
  const unscheduled = data.orders.filter((o) => !o.plan.scheduled && o.plan.produced === 0 && o.plan.status !== "COMPLETED");
  const pills = [
    { value: ALL as typeof ALL, label: "All", count: data.orders.length },
    ...STATUSES.map((s) => ({ value: s, label: SHORT[s], count: data.orders.filter((o) => o.plan.status === s).length, dot: STATUS_TONE[s] })),
  ];
  const paceTitle = (o: PlannedOrder) =>
    `Average of ${data.settings.paceDays ? "the last" : "all"} ${o.plan.paceDaysUsed} worked day${o.plan.paceDaysUsed === 1 ? "" : "s"} of this order`;

  return (
    <>
      <PageHeader
        title="Orders"
        subtitle={`${data.orders.length} orders · planned as of ${fmtDate(data.asOf)}`}
        actions={canEdit && <Button onClick={() => { setEditing(null); setOrderOpen(true); }}><Plus /> Add order</Button>}
      />

      {unscheduled.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <b>{unscheduled.length} order{unscheduled.length === 1 ? " is" : "s are"} not scheduled yet:</b>{" "}
          {unscheduled.map((o, i) => (
            <span key={o.id}>
              {i > 0 && ", "}
              {canEdit
                ? <button type="button" className="font-medium underline underline-offset-2" onClick={() => { setEditing(o); setOrderOpen(true); }}>{o.orderNo}</button>
                : o.orderNo}
              <span className="opacity-75"> (no {scheduleMissing(o).join(", no ").replace("Expected Scheduling Date", "date").replace("Line", "line")})</span>
            </span>
          ))}
          .{" "}
          {canEdit
            ? "Fill in the line and expected scheduling date on each - or drag them onto the Line calendar - before anything is ticked or logged."
            : "Nothing can be ticked or logged for them until their line and date are filled in."}
        </div>
      )}

      <Card className="gap-0 py-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <FilterPills items={pills} value={status} onChange={setStatus} />
          <SearchBox value={q} onChange={setQ} placeholder="Search order, line, style, colour…" className="w-full sm:w-72" />
        </div>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={`${TH} pl-4`}>Order</TableHead>
              <TableHead className={TH}>Line</TableHead>
              <TableHead className={TH}>Progress</TableHead>
              <TableHead className={`${TH} text-right`}>Per day</TableHead>
              <TableHead className={`${TH} pl-6`}>Schedule</TableHead>
              <TableHead className={TH}>Delivery</TableHead>
              <TableHead className={TH}>Status</TableHead>
              {(canEdit || canLog) && <TableHead className={`${TH} pr-4 text-right`}>Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((o) => (
              <TableRow key={o.id}>
                <TableCell className="py-3 pl-4"><OrderCell o={o} /></TableCell>
                <TableCell><LineValue order={o} /></TableCell>
                <TableCell><ProgressCell o={o} /></TableCell>
                <TableCell><PaceCell o={o} paceTitle={paceTitle(o)} /></TableCell>
                <TableCell className="pl-6"><ScheduleCell o={o} asOf={data.asOf} /></TableCell>
                <TableCell><DeliveryCell o={o} /></TableCell>
                <TableCell><StatusBadge status={o.plan.status} /></TableCell>
                {(canEdit || canLog) && (
                  <TableCell className="pr-4">
                    <div className="flex justify-end gap-0.5">
                      {canLog && <IconButton label="Log production" onClick={() => gate(o, "logging production") && setLogFor(o.id)}><NotebookPen /></IconButton>}
                      {canEdit && <IconButton label="Update order" onClick={() => { setEditing(o); setOrderOpen(true); }}><Pencil /></IconButton>}
                      {canEdit && <IconButton label="Delete order" onClick={() => setDeleting(o)}><Trash2 /></IconButton>}
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
            {!rows.length && (
              <EmptyRow span={8}>
                {data.orders.length ? "No orders match." : "No orders yet. Click Add order to create the first one."}
              </EmptyRow>
            )}
          </TableBody>
        </Table>
      </Card>

      <p className="mt-3 text-xs text-muted-foreground">
        Pace = average output per worked day ({data.settings.paceDays ? `last ${data.settings.paceDays} days` : "every day worked"}),
        once production starts. Target = what is needed per working day to deliver on time. Margins and days left are
        working days. Each order books its line from its start date to its required date, or once running, to its
        expected completion.
      </p>

      <OrderDialog open={orderOpen} onOpenChange={setOrderOpen} order={editing} />
      {popup}
      <EntryDialog open={logFor !== null} onOpenChange={(o) => !o && setLogFor(null)} entry={null} defaultOrderId={logFor} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete order ${shownDelete?.orderNo}?`}
        confirmLabel="Delete order"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          try {
            const r = await api.del<{ entries: number }>(`/api/orders/${deleting.id}`);
            await refreshAll();
            toast.success(`Order ${deleting.orderNo} deleted${r.entries ? ` with ${r.entries} production entries` : ""}`);
            setDeleting(null);
          } catch (e) {
            toast.error(e instanceof ApiError ? e.message : String(e));
          }
        }}
      >
        <p>{lineName(shownDelete?.lineNo)} · {shownDelete?.styleNo || "no style"} · {fmtNum(shownDelete?.orderQty)} {shownDelete?.unit}</p>
        {!!shownDelete?.plan.entryCount && (
          <p className="font-medium text-destructive">
            Its {shownDelete.plan.entryCount} production entr{shownDelete.plan.entryCount === 1 ? "y" : "ies"} will be deleted too.
          </p>
        )}
        <p>This cannot be undone.</p>
      </ConfirmDialog>
    </>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={onClick} aria-label={label} />}>
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
