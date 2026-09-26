"use client";

import { useMemo, useState } from "react";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EntryDialog } from "@/components/entry-dialog";
import { LoadState, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Guard } from "@/components/guard";
import { api, ApiError, lineName, refreshAll, useCan, useEntries, type Entry } from "@/lib/api";
import { fmtDate, fmtNum } from "@/lib/format";
import { useLast } from "@/lib/use-last";
import { cn } from "@/lib/utils";

const ALL = "all";

export default function LogPage() {
  return <Guard need="log.view"><Log /></Guard>;
}

function Log() {
  const { data, error, isLoading } = useEntries();
  const { can } = useCan();
  const canEdit = can("log.edit");
  const [q, setQ] = useState("");
  const [order, setOrder] = useState<string>(ALL);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Entry | null>(null);
  const [deleting, setDeleting] = useState<Entry | null>(null);
  const shownDelete = useLast(deleting);

  const orderItems = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of data?.entries ?? []) seen.set(String(e.orderId), `${e.orderNo} · ${e.styleNo || "no style"}`);
    return [{ value: ALL, label: "All orders" },
      ...[...seen].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }))];
  }, [data]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.entries ?? []).filter((e) =>
      (order === ALL || String(e.orderId) === order) && (!from || e.entryDate >= from) && (!to || e.entryDate <= to) &&
      (!needle || [e.entryNo, e.orderNo, lineName(e.lineNo), e.styleNo, e.shift, e.remarks, e.flag]
        .some((v) => v.toLowerCase().includes(needle))));
  }, [data, q, order, from, to]);

  if (!data) return <LoadState error={error} loading={isLoading} />;
  const total = rows.reduce((s, e) => s + e.qty, 0);

  return (
    <>
      <PageHeader
        title="Daily production log"
        subtitle="One row per order, per day, per shift. Newest first."
        actions={canEdit && <Button onClick={() => { setEditing(null); setOpen(true); }}><Plus /> Log production</Button>}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search entries"
            placeholder="Search entry, order, line, style, remarks…" className="bg-background pl-8" />
        </div>
        <Select items={orderItems} value={order} onValueChange={(v) => setOrder(v ?? ALL)}>
          <SelectTrigger className="w-64 bg-background"><SelectValue /></SelectTrigger>
          <SelectContent>
            {orderItems.map((i) => <SelectItem key={i.value} value={i.value}>{i.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40 bg-background" aria-label="From date" />
        <span className="text-sm text-muted-foreground">to</span>
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40 bg-background" aria-label="To date" />
        {(q || order !== ALL || from || to) && (
          <Button variant="ghost" onClick={() => { setQ(""); setOrder(ALL); setFrom(""); setTo(""); }}>Clear</Button>
        )}
        <span className="ml-auto text-sm text-muted-foreground">
          {rows.length} entries · <b className="text-foreground tabular-nums">{fmtNum(total)}</b> produced
        </span>
      </div>

      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead className="pl-3">Entry</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Order</TableHead>
              <TableHead>Line</TableHead>
              <TableHead>Style</TableHead>
              <TableHead className="text-right">Produced</TableHead>
              <TableHead>Shift</TableHead>
              <TableHead className="text-right">Order qty</TableHead>
              <TableHead className="text-right">Cumulative</TableHead>
              <TableHead className="text-right">Balance after</TableHead>
              <TableHead>Flag</TableHead>
              <TableHead>Remarks / downtime</TableHead>
              {canEdit && <TableHead className="pr-3 text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="pl-3 font-mono text-xs">{e.entryNo}</TableCell>
                <TableCell>{fmtDate(e.entryDate)}</TableCell>
                <TableCell className="font-medium">{e.orderNo}</TableCell>
                <TableCell className="whitespace-nowrap">{lineName(e.lineNo)}</TableCell>
                <TableCell>{e.styleNo || "—"}</TableCell>
                <TableCell className="text-right font-medium tabular-nums">{fmtNum(e.qty)}</TableCell>
                <TableCell>{e.shift}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{fmtNum(e.orderQty)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtNum(e.cumulative)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtNum(e.balanceAfter)}</TableCell>
                <TableCell>
                  {e.flag && (
                    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap",
                      e.flag.startsWith("OVER") ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
                        : "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300")}>
                      {e.flag}
                    </span>
                  )}
                </TableCell>
                <TableCell className="max-w-56 truncate" title={e.remarks}>{e.remarks}</TableCell>
                {canEdit && (
                  <TableCell className="pr-3">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon-sm" aria-label="Edit entry" onClick={() => { setEditing(e); setOpen(true); }}><Pencil /></Button>
                      <Button variant="ghost" size="icon-sm" aria-label="Delete entry" onClick={() => setDeleting(e)}><Trash2 /></Button>
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
            {!rows.length && (
              <TableRow>
                <TableCell colSpan={13} className="py-10 text-center text-muted-foreground">
                  {data.entries.length ? "No entries match." : "Nothing logged yet."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      <EntryDialog open={open} onOpenChange={setOpen} entry={editing} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this production entry?"
        confirmLabel="Delete entry"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await api.del(`/api/entries/${deleting.id}`);
            await refreshAll();
            toast.success(`Entry ${deleting.entryNo} deleted`);
            setDeleting(null);
          } catch (err) {
            toast.error(err instanceof ApiError ? err.message : String(err));
          }
        }}
      >
        <p>{shownDelete?.entryNo} · {fmtDate(shownDelete?.entryDate)} · {shownDelete?.shift}</p>
        <p>{shownDelete?.orderNo} · {fmtNum(shownDelete?.qty)} pcs</p>
        <p>This cannot be undone.</p>
      </ConfirmDialog>
    </>
  );
}
