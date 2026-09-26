"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, ApiError, LINES, lineName, refreshAll, useCan, useIdle, useMeta, type Meta } from "@/lib/api";
import { fmtDate, weekdayName } from "@/lib/format";
import { cn } from "@/lib/utils";

const ALL = "__all";

export function IdleDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data: meta } = useMeta();
  const canEdit = useCan().can("calendar.edit");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Idle days</DialogTitle>
          <DialogDescription>
            {canEdit
              ? "Mark days with no production. A full day gives no working time and a half day gives half; target, expected completion, buffer and line bookings are worked out again for every order on the lines affected."
              : "Days marked with no production, and how much of the day was lost. Your role can see these but not change them."}
          </DialogDescription>
        </DialogHeader>
        {/* Mounted afresh on every open. */}
        {open && canEdit && <IdleForm meta={meta} />}
        <IdleList canEdit={canEdit} />
      </DialogContent>
    </Dialog>
  );
}

function IdleForm({ meta }: { meta: Meta | undefined }) {
  const [portion, setPortion] = useState<0.5 | 1>(1);
  const [from, setFrom] = useState(meta?.today ?? "");
  const [to, setTo] = useState("");
  const [line, setLine] = useState<string>(ALL);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const lineItems = [{ value: ALL, label: "All lines" }, ...LINES.map((n) => ({ value: String(n), label: lineName(n) }))];

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api.post<{ saved: number }>("/api/idle", {
        from, to: to || undefined, portion, lineNo: line === ALL ? null : Number(line), reason,
      });
      await refreshAll();
      toast.success(`${r.saved} day${r.saved === 1 ? "" : "s"} marked ${portion === 1 ? "full" : "half"} day idle`
        + (line === ALL ? " for all lines" : ` for ${lineName(Number(line))}`));
      setTo("");
      setReason("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
      <div className="grid gap-1.5 sm:col-span-2">
        <Label>Idle for</Label>
        <div className="grid grid-cols-2 gap-2" role="radiogroup">
          {([[0.5, "Half Day"], [1, "Full Day"]] as const).map(([v, label]) => (
            <button key={v} type="button" role="radio" aria-checked={portion === v} onClick={() => setPortion(v)}
              className={cn("h-9 rounded-lg border text-sm font-medium transition-colors",
                portion === v ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted")}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label>From *</Label>
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
      </div>
      <div className="grid gap-1.5">
        <Label>To <span className="font-normal text-muted-foreground">(blank = one day)</span></Label>
        <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
      </div>
      <div className="grid gap-1.5">
        <Label>Line</Label>
        <Select items={lineItems} value={line} onValueChange={(v) => setLine(v ?? ALL)}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            {lineItems.map((i) => <SelectItem key={i.value} value={i.value}>{i.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label>Reason</Label>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Power cut, holiday…" />
      </div>
      {error && <p className="text-sm text-destructive sm:col-span-2">{error}</p>}
      <Button type="submit" disabled={busy} className="sm:col-span-2">
        {busy ? "Saving…" : `Mark ${to && to !== from ? "these days" : "this day"} as ${portion === 1 ? "full" : "half"} day idle`}
      </Button>
    </form>
  );
}

function IdleList({ canEdit }: { canEdit: boolean }) {
  const { data } = useIdle();
  const list = data?.idle ?? [];

  async function remove(id: number) {
    try {
      await api.del(`/api/idle/${id}`);
      await refreshAll();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <div className="grid gap-2 border-t pt-3">
      <div className="text-sm font-medium">Marked idle <span className="font-normal text-muted-foreground">({list.length})</span></div>
      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground">No idle days yet.</p>
      ) : (
        <ul className="max-h-56 divide-y overflow-y-auto rounded-lg border">
          {list.map((x) => (
            <li key={x.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
              <span className="w-32 shrink-0 tabular-nums">{weekdayName(x.idleDate)} {fmtDate(x.idleDate)}</span>
              <span className={cn("shrink-0 rounded-full px-2 text-[11px] font-semibold",
                x.portion === 1 ? "bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-100"
                  : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300")}>
                {x.portion === 1 ? "Full day" : "Half day"}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground" title={x.reason}>
                {x.lineNo ? lineName(x.lineNo) : "All lines"}{x.reason && ` · ${x.reason}`}
              </span>
              {canEdit && (
                <Button variant="ghost" size="icon-xs" aria-label="Remove this idle day" onClick={() => remove(x.id)}>
                  <Trash2 />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
