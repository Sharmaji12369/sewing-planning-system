"use client";

import { useState } from "react";
import { CalendarClock, CircleAlert, CircleCheck } from "lucide-react";
import { toast } from "sonner";
import { OrderAdvice } from "@/components/order-advice";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  api, ApiError, LINES, lineName, milestonesMissing, refreshAll, useLineCheck, useMeta,
  type LineCheck, type Meta, type Order, type PlannedOrder,
} from "@/lib/api";
import { fmtDate, fmtNum } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order: Order | PlannedOrder | null; // null = new order
}

export function OrderDialog({ open, onOpenChange, order }: Props) {
  const { data: meta } = useMeta(); // fetched while closed, so it is ready on open
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        {/* Mounted afresh on every open, so the form always starts from the order shown. */}
        <OrderForm key={order?.id ?? "new"} order={order} meta={meta} close={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

// Line and Expected Scheduling Date start empty on a new order: they are filled in when known (25 Sep 2026).
function initial(order: Order | null, meta: Meta | undefined) {
  if (order) {
    return {
      orderNo: order.orderNo, lineNo: order.lineNo ? String(order.lineNo) : "", styleNo: order.styleNo,
      colour: order.colour, orderQty: String(order.orderQty), unit: order.unit, planningDate: order.planningDate ?? "",
      requiredDate: order.requiredDate, notes: order.notes,
    };
  }
  return {
    orderNo: meta?.nextOrderNo ?? "", lineNo: "", styleNo: "", colour: "", orderQty: "", unit: "Pcs",
    planningDate: "", requiredDate: "", notes: "",
  };
}

type Form = ReturnType<typeof initial>;

/** The line picker's "no line yet" choice. */
const NO_LINE = "0";

function OrderForm({ order, meta, close }: { order: Order | PlannedOrder | null; meta: Meta | undefined; close: () => void }) {
  const [f, setF] = useState<Form>(() => initial(order, meta));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { data: check } = useLineCheck({ id: order?.id, ...f });

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF((x) => ({ ...x, [k]: e.target.value }));

  // Once something has been entered against the order, its line and date stay filled (the server insists too).
  const produced = order && "plan" in order ? order.plan.produced : 0;
  const locked = !!order && (produced > 0 || milestonesMissing(order).length < 3);
  const scheduled = !!f.lineNo && !!f.planningDate;

  const picked = check?.lines.find((l) => String(l.lineNo) === f.lineNo);
  // An existing order is only checked again when what it books changes.
  const moved = !order || f.lineNo !== String(order.lineNo ?? "") || f.planningDate !== (order.planningDate ?? "")
    || f.requiredDate !== order.requiredDate || Number(f.orderQty) !== order.orderQty;
  // Not scheduled, it books no days, so there is nothing for it to clash with.
  const blocked = scheduled && moved && !!picked && !picked.free;

  const lineItems = [
    ...(locked ? [] : [{ value: NO_LINE, label: "Not decided yet" }]),
    ...LINES.map((n) => ({ value: String(n), label: lineName(n) })),
  ];

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = {
        ...f, orderQty: Number(f.orderQty), lineNo: f.lineNo ? Number(f.lineNo) : null, planningDate: f.planningDate || null,
      };
      if (order) await api.put(`/api/orders/${order.id}`, body);
      else await api.post("/api/orders", body);
      await refreshAll();
      const what = order ? `Order ${order.orderNo} updated` : `Order ${f.orderNo} added`;
      if (scheduled) toast.success(order ? what : `${what} on ${lineName(body.lineNo)}`);
      else toast.success(`${what} - not scheduled yet`, { description: "Fill in its line and expected scheduling date before ticking or logging anything for it." });
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{order ? `Update order ${order.orderNo}` : "Add new order"}</DialogTitle>
        <DialogDescription>
          Target per day is worked out from the balance and the working days left before the required delivery
          date. Line and Expected Scheduling Date can wait until they are known - but nothing can be ticked or logged for
          the order until both are filled in.
        </DialogDescription>
      </DialogHeader>

      <form id="order-form" onSubmit={save} className="grid gap-4 sm:grid-cols-6">
        <Field label="Order No *" className="sm:col-span-3">
          <Input value={f.orderNo} onChange={set("orderNo")} readOnly={!!order} required
            className={order ? "bg-muted" : ""} />
        </Field>
        <Field label="Style No" className="sm:col-span-3">
          <Input value={f.styleNo} onChange={set("styleNo")} list="styles" />
          <datalist id="styles">{meta?.styles.map((v) => <option key={v} value={v} />)}</datalist>
        </Field>
        <Field label="Colour" className="sm:col-span-3">
          <Input value={f.colour} onChange={set("colour")} />
        </Field>
        <Field label="Order Qty *" className="sm:col-span-2">
          <Input type="number" min={1} step={1} value={f.orderQty} onChange={set("orderQty")} required />
        </Field>
        <Field label="Unit" className="sm:col-span-1">
          <Input value={f.unit} onChange={set("unit")} />
        </Field>

        {/* When it is wanted, then where and from when it runs. */}
        <Field label="Required Delivery *" className="sm:col-span-2">
          <Input type="date" value={f.requiredDate} min={f.planningDate || undefined} onChange={set("requiredDate")} required />
        </Field>
        <Field label={locked ? "Line *" : "Line"} className="sm:col-span-2">
          <Select items={lineItems} value={f.lineNo || null}
            onValueChange={(v) => setF((x) => ({ ...x, lineNo: v && v !== NO_LINE ? v : "" }))}>
            <SelectTrigger className="w-full" aria-label="Line"><SelectValue placeholder="Not decided yet" /></SelectTrigger>
            <SelectContent>
              {!locked && (
                <SelectItem value={NO_LINE}><span className="text-muted-foreground">Not decided yet</span></SelectItem>
              )}
              {LINES.map((n) => {
                const l = check?.lines.find((x) => x.lineNo === n);
                return (
                  <SelectItem key={n} value={String(n)}>
                    {lineName(n)}
                    {l && (
                      <span className={cn("ml-auto pl-4 text-xs",
                        l.free ? "text-green-700 dark:text-green-400" : "text-muted-foreground")}>
                        {l.free ? "free" : `busy · ${l.clashes[0].orderNo}`}
                      </span>
                    )}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </Field>
        <Field label={locked ? "Expected Scheduling Date *" : "Expected Scheduling Date"} className="sm:col-span-2"
          action={!locked && f.planningDate ? (
            <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => setF((x) => ({ ...x, planningDate: "" }))}>Clear</button>
          ) : undefined}>
          <Input type="date" value={f.planningDate} max={f.requiredDate || undefined} onChange={set("planningDate")}
            required={locked} aria-label="Expected Scheduling Date" />
        </Field>

        {check?.advice && (
          <OrderAdvice
            advice={check.advice} draft={{ id: order?.id, ...f }} isNew={!order} moved={moved}
            onUse={(n, d) => setF((x) => ({ ...x, lineNo: String(n), planningDate: d ?? x.planningDate }))}
          />
        )}

        <LinePanel
          check={check} lineNo={f.lineNo} dated={!!f.planningDate} moved={moved}
          onPlanningDate={(d) => setF((x) => ({ ...x, planningDate: d }))}
          onLine={(n) => setF((x) => ({ ...x, lineNo: String(n) }))}
        />

        <Field label="Notes & Specifications" className="sm:col-span-6">
          <Textarea value={f.notes} onChange={set("notes")} rows={2} />
        </Field>
        {error && <p className="text-sm text-destructive sm:col-span-6">{error}</p>}
      </form>

      <DialogFooter>
        <Button variant="outline" onClick={close} disabled={busy}>Cancel</Button>
        <Button type="submit" form="order-form" disabled={busy || blocked}
          title={blocked ? "The line is taken on these dates" : undefined}>
          Save
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * What the chosen line looks like for these dates - free, or when it will be
 * and which lines are free now. With no line or no date yet, what saving it
 * like that means, and the one click that schedules it.
 */
function LinePanel({ check, lineNo, dated, moved, onPlanningDate, onLine }: {
  check: LineCheck | undefined; lineNo: string; dated: boolean; moved: boolean;
  onPlanningDate: (d: string) => void; onLine: (n: number) => void;
}) {
  if (!check) {
    return <p className="text-xs text-muted-foreground sm:col-span-6">Enter the qty and the required delivery date to see which lines are free.</p>;
  }
  const picked = check.lines.find((l) => String(l.lineNo) === lineNo);
  const free = check.lines.filter((l) => l.free && String(l.lineNo) !== lineNo);
  const soonest = check.lines
    .filter((l) => !l.free && l.suggest && String(l.lineNo) !== lineNo)
    .sort((a, b) => a.suggest!.planningDate.localeCompare(b.suggest!.planningDate))
    .slice(0, 3);

  const otherLines = (
    <div className="flex flex-wrap items-center gap-1.5">
      {free.length ? (
        <>
          <span className="text-xs text-muted-foreground">{dated ? "Free on these dates:" : "Free from today:"}</span>
          {free.map((l) => (
            <Button key={l.lineNo} type="button" size="xs" variant="outline" onClick={() => onLine(l.lineNo)}>
              {lineName(l.lineNo)}
            </Button>
          ))}
        </>
      ) : (
        <span className="text-xs text-muted-foreground">
          No {picked ? "other " : ""}line is free {dated ? "on these dates" : "from today"}.
          {soonest.length > 0 && <> Soonest: {soonest.map((l) => `${lineName(l.lineNo)} from ${fmtDate(l.suggest!.planningDate)}`).join(", ")}.</>}
        </span>
      )}
    </div>
  );

  // Saved like this, it is not scheduled: say what that means, and offer the date that would schedule it.
  if (!picked || !dated) {
    const from = picked ? (picked.free ? check.today : picked.suggest?.planningDate ?? null) : null;
    const missing = [!picked && "no line", !dated && "no Expected Scheduling Date"].filter(Boolean).join(" and ");
    return (
      <div className="grid gap-2 rounded-lg border border-sky-200 bg-sky-50/70 p-3 text-sm sm:col-span-6 dark:border-sky-900 dark:bg-sky-950/30">
        <div className="flex gap-2">
          <CalendarClock className="mt-0.5 size-4 shrink-0 text-sky-700 dark:text-sky-400" />
          <div className="grid gap-1">
            <div className="font-medium">Saved with {missing}, the order is not scheduled yet.</div>
            <div className="text-xs text-muted-foreground">
              It holds no days on any line, has no pre-production dates, and pre-production, production and packing
              cannot be entered for it until both are filled in - here, or by dragging it onto the Line calendar.
            </div>
            {picked && from && (
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                <span>
                  {lineName(picked.lineNo)} is free for it from <b>{fmtDate(from)}</b>
                  {!picked.free && picked.suggest?.late && <b className="text-red-700 dark:text-red-400"> - after the required delivery date</b>}.
                </span>
                <Button type="button" size="xs" onClick={() => onPlanningDate(from)}>Schedule from {fmtDate(from)}</Button>
              </div>
            )}
          </div>
        </div>
        {!picked && otherLines}
      </div>
    );
  }

  const p = picked.plan;
  const summary = (
    <>
      Start date <b>{fmtDate(p.startDate)}</b> · target <b>{fmtNum(p.targetPerDay)}</b> a day ·
      books {lineName(picked.lineNo)} {fmtDate(p.bookStart)} – {fmtDate(p.bookEnd)}
      {p.overdue && <span className="font-semibold text-red-700 dark:text-red-400"> · no working day left before the required date</span>}
    </>
  );

  if (picked.free || !moved) {
    return (
      <div className="grid gap-2 rounded-lg border border-green-300 bg-green-50 p-3 text-sm sm:col-span-6 dark:border-green-900 dark:bg-green-950/40">
        <div className="flex gap-2">
          <CircleCheck className="mt-0.5 size-4 shrink-0 text-green-700 dark:text-green-400" />
          <div>
            <div className="font-medium">
              {picked.free ? `${lineName(picked.lineNo)} is free for these dates.` : "Unchanged - saved as it is."}
            </div>
            <div className="text-xs text-muted-foreground">{summary}</div>
          </div>
        </div>
      </div>
    );
  }

  const c = picked.clashes[0];
  const s = picked.suggest;
  return (
    <div className="grid gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm sm:col-span-6 dark:border-amber-900 dark:bg-amber-950/40">
      <div className="flex gap-2">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" />
        <div className="grid gap-1">
          <div className="font-medium">
            {lineName(picked.lineNo)} is booked by {c.orderNo} from {fmtDate(c.start)} to {fmtDate(c.end)}
            {picked.clashes.length > 1 && ` (and ${picked.clashes.slice(1).map((x) => x.orderNo).join(", ")})`}.
          </div>
          {s ? (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span>
                Free for this order from Expected Scheduling Date <b>{fmtDate(s.planningDate)}</b> - start {fmtDate(s.startDate)},
                target {fmtNum(s.targetPerDay)} a day.
                {s.late && <b className="text-red-700 dark:text-red-400"> That is after the required delivery date.</b>}
              </span>
              <Button type="button" size="xs" onClick={() => onPlanningDate(s.planningDate)}>
                Schedule from {fmtDate(s.planningDate)}
              </Button>
            </div>
          ) : (
            <div className="text-xs">This order is already running, so it cannot wait for the line. Pick another line.</div>
          )}
        </div>
      </div>
      {otherLines}
    </div>
  );
}

function Field({ label, className, action, children }: {
  label: string; className?: string; action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className={`grid content-start gap-1.5 ${className ?? ""}`}>
      <div className="flex items-baseline justify-between gap-2">
        <Label>{label}</Label>
        {action}
      </div>
      {children}
    </div>
  );
}
