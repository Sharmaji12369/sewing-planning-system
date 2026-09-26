"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { OrderPicker, type OrderOption } from "@/components/order-picker";
import { useScheduleGate } from "@/components/schedule-gate";
import Link from "next/link";
import {
  api, ApiError, lineName, milestonesMissing, refreshAll, scheduleMissing, useMeta, useOrders,
  type Entry, type PlannedOrder, type Shift,
} from "@/lib/api";
import { fmtNum } from "@/lib/format";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: Entry | null;          // null = new entry
  defaultOrderId?: number | null;
}

const SHIFTS: Shift[] = ["Day", "Night", "Overtime"];
const SHIFT_ITEMS = SHIFTS.map((s) => ({ value: s, label: s }));

export function EntryDialog({ open, onOpenChange, entry, defaultOrderId }: Props) {
  // Fetched while the dialog is closed, so both are ready when it opens.
  const { data: meta } = useMeta();
  const { data: ordersData } = useOrders();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <EntryForm
          key={entry?.id ?? `new-${defaultOrderId ?? ""}`}
          entry={entry}
          defaultOrderId={defaultOrderId ?? null}
          today={meta?.today ?? ""}
          orders={ordersData?.orders ?? []}
          close={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function EntryForm({ entry, defaultOrderId, today, orders, close }: {
  entry: Entry | null; defaultOrderId: number | null; today: string; orders: PlannedOrder[]; close: () => void;
}) {
  const [orderId, setOrderId] = useState<string | null>(
    entry ? String(entry.orderId) : defaultOrderId ? String(defaultOrderId) : null);
  const [entryDate, setEntryDate] = useState(entry?.entryDate ?? today);
  const [qty, setQty] = useState(entry ? String(entry.qty) : "");
  const [shift, setShift] = useState<Shift>(entry?.shift ?? "Day");
  const [remarks, setRemarks] = useState(entry?.remarks ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const { gate, caught, popup } = useScheduleGate();

  // Orders still waiting on pre-production are listed last and cannot be picked. One with no line or
  // scheduling date yet can be picked - and says at once that those come first.
  const items = useMemo<OrderOption[]>(
    () => orders
      .map((o) => {
        const unset = scheduleMissing(o).length > 0;
        const missing = !unset && milestonesMissing(o).length > 0;
        const label = `${o.orderNo} · ${o.styleNo || "no style"} · ${lineName(o.lineNo)}`;
        return {
          value: String(o.id), label, disabled: missing,
          note: unset ? "not scheduled - line & date needed" : missing ? "pre-production not done" : undefined,
          search: `${label} ${o.colour}`.toLowerCase(),
        };
      })
      .sort((a, b) => Number(!!a.note) - Number(!!b.note) || Number(!!a.disabled) - Number(!!b.disabled)),
    [orders],
  );
  const picked = orders.find((o) => String(o.id) === orderId);
  const pickedUnset = picked ? scheduleMissing(picked) : [];
  const pickedMissing = picked ? milestonesMissing(picked) : [];
  const pick = (id: string | null) => {
    setOrderId(id);
    const o = orders.find((x) => String(x.id) === id);
    if (o) gate(o, "logging production");
  };

  async function submit(confirm: boolean) {
    setBusy(true);
    setError("");
    try {
      const body = { orderId: Number(orderId), entryDate, qty: Number(qty), shift, remarks, confirm };
      if (entry) await api.put(`/api/entries/${entry.id}`, body);
      else await api.post("/api/entries", body);
      await refreshAll();
      toast.success(`${fmtNum(Number(qty))} ${picked?.unit ?? "pcs"} ${entry ? "updated" : "logged"} for ${picked?.orderNo}`);
      setWarnings([]);
      close();
    } catch (err) {
      // 409 with warnings = the server wants the user to confirm first.
      if (err instanceof ApiError && err.status === 409 && err.warnings.length) setWarnings(err.warnings);
      else if (picked && caught(err, picked, "logging production")) setError("");
      else setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{entry ? `Edit entry ${entry.entryNo}` : "Log production"}</DialogTitle>
        <DialogDescription>
          One day&apos;s output for one order and one shift. An order can take production once it has its line and
          expected scheduling date, and fabric, cutting and accessories are all ticked on Pre-production.
        </DialogDescription>
      </DialogHeader>

      <form
        id="entry-form"
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!orderId) return setError("Pick an order");
          submit(false);
        }}
      >
        <div className="grid gap-1.5 sm:col-span-2">
          <Label>Order *</Label>
          <OrderPicker items={items} value={orderId} onChange={pick} />
          {picked && pickedUnset.length > 0 && (
            <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
              <b>{picked.orderNo} is not scheduled yet.</b> Fill in its {pickedUnset.join(" and ")} first
              {" "}(<button type="button" className="underline" onClick={() => gate(picked, "logging production")}>how</button>).
            </p>
          )}
          {picked && !pickedUnset.length && pickedMissing.length > 0 && (
            <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
              <b>{picked.orderNo} cannot take production yet.</b> Tick {pickedMissing.join(", ")} on{" "}
              <Link href="/pre-production" className="underline">Pre-production</Link> first.
            </p>
          )}
          {picked && !pickedUnset.length && !pickedMissing.length && (
            <p className="text-xs text-muted-foreground">
              {fmtNum(picked.plan.produced)} of {fmtNum(picked.orderQty)} {picked.unit} made ·
              balance {fmtNum(picked.plan.balance)}
              {picked.plan.targetPerDay != null && <> · needs {fmtNum(picked.plan.targetPerDay)} / day</>}
            </p>
          )}
        </div>
        <div className="grid gap-1.5">
          <Label>Date *</Label>
          <Input type="date" value={entryDate} max={today} onChange={(e) => setEntryDate(e.target.value)} required />
        </div>
        <div className="grid gap-1.5">
          <Label>Shift</Label>
          <Select items={SHIFT_ITEMS} value={shift} onValueChange={(v) => setShift((v as Shift) ?? "Day")}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {SHIFTS.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label>Produced Qty *</Label>
          <Input type="number" min={1} step={1} value={qty} onChange={(e) => setQty(e.target.value)} required />
        </div>
        <div className="grid gap-1.5">
          <Label>Remarks / Downtime</Label>
          <Input value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </div>
        {error && <p className="text-sm text-destructive sm:col-span-2">{error}</p>}
      </form>

      <DialogFooter>
        <Button variant="outline" onClick={close} disabled={busy}>Cancel</Button>
        <Button type="submit" form="entry-form" disabled={busy || pickedUnset.length > 0 || pickedMissing.length > 0}>
          {entry ? "Save changes" : "Save entry"}
        </Button>
      </DialogFooter>

      {popup}

      <ConfirmDialog
        open={warnings.length > 0}
        onOpenChange={(o) => !o && setWarnings([])}
        title="Check before saving"
        confirmLabel="Save anyway"
        onConfirm={() => submit(true)}
      >
        <ul className="list-disc space-y-1.5 pl-4">
          {warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      </ConfirmDialog>
    </>
  );
}
