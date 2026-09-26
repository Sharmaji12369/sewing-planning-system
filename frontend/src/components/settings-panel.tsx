"use client";

import { useState } from "react";
import { ChevronDown, RotateCcw, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmtDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { isBaseView, useView } from "@/lib/view";

const ALL = "all";
const PACE_ITEMS = [
  { value: ALL, label: "All worked days (base)" },
  ...[3, 5, 7, 10, 14].map((n) => ({ value: String(n), label: `Last ${n} worked days` })),
];
const WEEK_ITEMS = [
  { value: "6", label: "6 days · Mon–Sat (base)" },
  { value: "5", label: "5 days · Mon–Fri" },
  { value: "7", label: "7 days · every day" },
];

/** A complete, sensible date from a date box - never a half-typed one. */
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && v >= "2000-01-01";

/**
 * The planning controls, folded into one line that says which rules are in
 * use; Adjust opens them. Left alone they are the base rules. A change
 * re-plans every order straight away - on this screen only, until reset or
 * reload.
 */
export function SettingsPanel({ today, asOf }: { today: string; asOf: string }) {
  const { view, setView, reset } = useView();
  const changed = !isBaseView(view);
  const [open, setOpen] = useState(changed);
  const summary = [
    view.paceDays ? `pace over the last ${view.paceDays} worked days` : "pace over all worked days",
    `${view.workWeek ?? 6}-day week`,
    view.asOf ? `as of ${fmtDate(view.asOf)}` : "as of today",
    view.calendarStart && `calendar from ${fmtDate(view.calendarStart)}`,
  ].filter(Boolean).join(" · ");

  return (
    <Card className="gap-0 py-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        <SlidersHorizontal className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">Planning controls</span>
        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold",
          changed ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" : "bg-muted text-muted-foreground")}>
          {changed ? "Custom view" : "Base plan"}
        </span>
        <span className="min-w-0 truncate text-sm text-muted-foreground">{summary}</span>
        <div className="ml-auto flex gap-2">
          {changed && <Button variant="outline" size="sm" onClick={reset}><RotateCcw /> Reset to base</Button>}
          <Button variant="ghost" size="sm" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "Hide" : "Adjust"} <ChevronDown className={cn("transition-transform", open && "rotate-180")} />
          </Button>
        </div>
      </div>

      {open && (
        <div className="grid gap-4 border-t px-4 py-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="grid gap-1.5">
            <Label>Pace = average of</Label>
            <Select items={PACE_ITEMS} value={view.paceDays ? String(view.paceDays) : ALL}
              onValueChange={(v) => setView({ paceDays: !v || v === ALL ? null : Number(v) })}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PACE_ITEMS.map((i) => <SelectItem key={i.value} value={i.value}>{i.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label>Working week</Label>
            <Select items={WEEK_ITEMS} value={String(view.workWeek ?? 6)}
              onValueChange={(v) => setView({ workWeek: !v || v === "6" ? null : (Number(v) as 5 | 7) })}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {WEEK_ITEMS.map((i) => <SelectItem key={i.value} value={i.value}>{i.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label>Plan as of</Label>
            <div className="flex gap-2">
              <Input type="date" value={asOf} aria-label="Plan as of"
                onChange={(e) => isDate(e.target.value) && setView({ asOf: e.target.value === today ? null : e.target.value })} />
              {view.asOf && <Button variant="outline" onClick={() => setView({ asOf: null })}>Today</Button>}
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>Calendar starts</Label>
            <div className="flex gap-2">
              <Input type="date" value={view.calendarStart ?? ""} aria-label="Calendar starts"
                onChange={(e) => setView({ calendarStart: isDate(e.target.value) ? e.target.value : null })} />
              {view.calendarStart && <Button variant="outline" onClick={() => setView({ calendarStart: null })}>Auto</Button>}
            </div>
          </div>

          <p className="text-xs text-muted-foreground sm:col-span-2 xl:col-span-4">
            Leave these alone for the base plan. A change re-plans every order straight away, on your screen only.
          </p>
        </div>
      )}
    </Card>
  );
}
