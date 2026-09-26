"use client";

import { useState } from "react";
import { Check, Lock, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Milestone } from "@/lib/api";
import { fmtDateTime, fmtDay } from "@/lib/format";
import { cn } from "@/lib/utils";

const DAYS_STYLE: Record<Milestone["state"], string> = {
  early: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  "on-time": "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  late: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  overdue: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  due: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  none: "",
};

export function daysLabel(ms: Milestone): string {
  const n = Math.abs(ms.days ?? 0);
  switch (ms.state) {
    case "early": return `${n} d early`;
    case "on-time": return "on time";
    case "late": return `${n} d late`;
    case "overdue": return `${n} d overdue`;
    case "due": return n === 0 ? "due today" : `in ${n} d`;
    default: return "";
  }
}

/**
 * One pre- or post-production item: done (when), or the button to mark it -
 * over when it was due and how early or late. `readOnly` shows it with no
 * buttons at all (fabric, cutting and accessories on Post-production);
 * `blocked` says why it cannot be ticked yet instead of offering the button.
 */
export function MilestoneCell({ ms, canEdit, canUndo, onTick, onUndo, readOnly, blocked }: {
  ms: Milestone; canEdit?: boolean; canUndo?: boolean; onTick?: () => Promise<void> | void; onUndo?: () => void;
  readOnly?: boolean; blocked?: string;
}) {
  const [busy, setBusy] = useState(false);
  const soon = ms.state === "due" && (ms.days ?? 99) <= 2;
  return (
    <div className="min-w-40">
      <div className="flex h-6 items-center gap-1.5">
        {ms.doneAt ? (
          <>
            <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white"><Check className="size-3" /></span>
            <span className="text-xs font-medium whitespace-nowrap tabular-nums">{fmtDateTime(ms.doneAt)}</span>
            {!readOnly && canUndo && onUndo && (
              <Button variant="ghost" size="icon-xs" className="ml-auto text-muted-foreground" aria-label="Clear - ticked by mistake"
                title="Clear - ticked by mistake" onClick={onUndo}><X /></Button>
            )}
          </>
        ) : !readOnly && blocked ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground" title={blocked}>
            <Lock className="size-3" /> {blocked}
          </span>
        ) : !readOnly && canEdit && onTick ? (
          <Button variant="outline" size="xs" disabled={busy} title="Saves today's date and time"
            onClick={async () => { setBusy(true); try { await onTick(); } finally { setBusy(false); } }}>
            <Check /> Mark done
          </Button>
        ) : (
          <>
            <span className="size-4 shrink-0 rounded-full border-2 border-dashed border-muted-foreground/40" />
            <span className="text-xs text-muted-foreground">Not done</span>
          </>
        )}
      </div>
      {ms.expected && (
        <div className="mt-1 flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground">
          Due {fmtDay(ms.expected)}
          {ms.state !== "none" && (
            <span className={cn("rounded-full px-1.5 py-px text-[10px] font-semibold", DAYS_STYLE[ms.state],
              soon && "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300")}>
              {daysLabel(ms)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
