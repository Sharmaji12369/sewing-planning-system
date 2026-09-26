"use client";

import { useState } from "react";
import { ChevronDown, Loader2, Sparkles, TriangleAlert, Wand2 } from "lucide-react";
import { AiBlock } from "@/components/ai-text";
import { Button } from "@/components/ui/button";
import { aiPlacement, ApiError, lineName, type AiResult, type Fit, type LineAdvice, type PlacementAdvice } from "@/lib/api";
import { fmtDate, fmtNum } from "@/lib/format";
import { cn } from "@/lib/utils";

/** How each fit reads, and its colour - shared with the line calendar's drag hint. */
export const FIT: Record<Fit, { label: string; chip: string }> = {
  comfortable: { label: "comfortable", chip: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" },
  tight: { label: "tight", chip: "bg-lime-100 text-lime-800 dark:bg-lime-950 dark:text-lime-300" },
  stretch: { label: "a stretch", chip: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
  beyond: { label: "beyond its record", chip: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" },
  unknown: { label: "no record", chip: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300" },
};

export function FitChip({ fit, className }: { fit: Fit; className?: string }) {
  return <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap", FIT[fit].chip, className)}>{FIT[fit].label}</span>;
}

export interface Draft {
  id?: number; orderNo: string; styleNo: string; orderQty: string; planningDate: string; requiredDate: string; lineNo: string;
}

/** The advisor put this line first because it is set up for the order's style family. */
export function FamilyChip({ className, title }: { className?: string; title?: string }) {
  return (
    <span title={title} className={cn("rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap text-violet-800 dark:bg-violet-950 dark:text-violet-300", className)}>
      same style family
    </span>
  );
}

/**
 * The advisor's pick for the order being filled in: the best line and why,
 * one click to use it, every line side by side, and what could go wrong.
 * "Ask AI" hands the same ranking to the model for a written opinion. With no
 * Expected Scheduling Date typed yet, every line is judged from today, and
 * using a line fills in the date it would start from as well.
 */
export function OrderAdvice({ advice, draft, isNew, moved, onUse }: {
  advice: PlacementAdvice; draft: Draft; isNew: boolean; moved: boolean;
  onUse: (lineNo: number, planningDate: string | null) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [ai, setAi] = useState<{ sig: string; result: AiResult } | null>(null);
  const [asking, setAsking] = useState(false);
  const best = advice.best;
  const chosen = advice.ranked.find((r) => String(r.lineNo) === draft.lineNo) ?? null;
  const sig = JSON.stringify([draft.styleNo, draft.orderQty, draft.planningDate, draft.requiredDate, draft.lineNo]);
  const dated = !!draft.planningDate;
  /** The date to fill in with a line: the one it would start from - or none when the date typed already fits. */
  const dateFor = (a: LineAdvice) => (a.asEntered && dated ? null : a.planningDate);

  // An order being edited is only nudged when there is something to gain.
  const worthSaying = isNew || moved || !chosen || (!!best && best.lineNo !== chosen.lineNo && (chosen.fit === "stretch" || chosen.fit === "beyond"));
  if (!worthSaying && !advice.warnings.length) return null;

  async function askAi() {
    setAsking(true);
    try {
      const r = await aiPlacement({
        id: draft.id, orderNo: draft.orderNo, styleNo: draft.styleNo, orderQty: Number(draft.orderQty),
        planningDate: draft.planningDate || null, requiredDate: draft.requiredDate, lineNo: draft.lineNo ? Number(draft.lineNo) : null,
      });
      setAi({ sig, result: r.ai });
    } catch (e) {
      setAi({ sig, result: { error: e instanceof ApiError ? e.message : String(e), status: 0 } });
    } finally {
      setAsking(false);
    }
  }

  const isChosen = best && chosen && best.lineNo === chosen.lineNo;
  const alternatives = advice.ranked.filter((r) => r.available && r.lineNo !== best?.lineNo).slice(0, 2);

  return (
    <div className="grid gap-2.5 rounded-lg border border-violet-200 bg-violet-50/50 p-3 text-sm sm:col-span-full dark:border-violet-900 dark:bg-violet-950/20">
      {best && worthSaying && (
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <Wand2 className="mt-0.5 size-4 shrink-0 text-violet-600 dark:text-violet-400" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 font-medium">
              {isChosen ? <>{lineName(best.lineNo)} is the best line for this order</> : <>Suggested: {lineName(best.lineNo)}</>}
              <FitChip fit={best.fit} />
              {best.familyFirst && <FamilyChip title={`Style family ${advice.family}: put first`} />}
              {best.start && dateFor(best) && <span className="text-xs font-normal text-muted-foreground">from {fmtDate(best.planningDate)}</span>}
            </div>
            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              {best.reasons.map((r) => <li key={r}>· {r}</li>)}
            </ul>
            {chosen && !isChosen && (
              <p className="mt-1.5 text-xs">
                Your pick, {lineName(chosen.lineNo)}: <FitChip fit={chosen.fit} /> {chosen.reasons.slice(-1)[0]}.
              </p>
            )}
            {alternatives.length > 0 && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                Next best: {alternatives.map((a, i) => (
                  <span key={a.lineNo}>
                    {i > 0 && ", "}
                    <button type="button" className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                      onClick={() => onUse(a.lineNo, dateFor(a))}>
                      {lineName(a.lineNo)}
                    </button>{" "}({FIT[a.fit].label}{a.familyFirst ? ", same style family" : ""}{dateFor(a) ? `, from ${fmtDate(a.planningDate)}` : ""})
                  </span>
                ))}
              </p>
            )}
          </div>
          {!isChosen && (
            <Button type="button" size="sm" onClick={() => onUse(best.lineNo, dateFor(best))}>
              Use {lineName(best.lineNo)}{dateFor(best) && ` from ${fmtDate(best.planningDate).slice(0, 6)}`}
            </Button>
          )}
        </div>
      )}

      {advice.warnings.map((w) => (
        <div key={w} className="flex gap-2 rounded-md bg-amber-100/70 px-2.5 py-1.5 text-xs text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {w}
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" size="xs" onClick={() => setShowAll(!showAll)} aria-expanded={showAll}>
          Compare all lines <ChevronDown className={cn("transition-transform", showAll && "rotate-180")} />
        </Button>
        <Button type="button" variant="outline" size="xs" onClick={askAi} disabled={asking}>
          {asking ? <Loader2 className="animate-spin" /> : <Sparkles />} {asking ? "Asking the AI…" : "Ask AI"}
        </Button>
      </div>

      {showAll && <CompareTable ranked={advice.ranked} chosen={draft.lineNo} dated={dated} onUse={onUse} />}
      {ai && ai.sig === sig && <AiBlock result={ai.result} />}
      {ai && ai.sig !== sig && (
        <p className="text-[11px] text-muted-foreground">The order changed since the AI answered - ask again for its view on the new figures.</p>
      )}
    </div>
  );
}

function CompareTable({ ranked, chosen, dated, onUse }: {
  ranked: LineAdvice[]; chosen: string; dated: boolean; onUse: (lineNo: number, planningDate: string | null) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-md border bg-background">
      <table className="w-full text-xs">
        <thead className="bg-muted/60 text-[10px] tracking-wide text-muted-foreground uppercase">
          <tr>
            <th className="px-2 py-1.5 text-left font-medium">Line</th>
            <th className="px-2 py-1.5 text-left font-medium">Fit</th>
            <th className="px-2 py-1.5 text-left font-medium">Start</th>
            <th className="px-2 py-1.5 text-right font-medium">Needs / day</th>
            <th className="px-2 py-1.5 text-right font-medium">Usually makes</th>
            <th className="px-2 py-1.5 text-right font-medium">Spare days</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((r) => (
            <tr key={r.lineNo}
              className={cn("border-t", r.available ? "cursor-pointer hover:bg-muted/50" : "text-muted-foreground", String(r.lineNo) === chosen && "bg-violet-50 dark:bg-violet-950/30")}
              onClick={r.available ? () => onUse(r.lineNo, r.asEntered && dated ? null : r.planningDate) : undefined}
              title={r.reasons.join("\n")}>
              <td className="px-2 py-1.5 font-medium whitespace-nowrap">
                {lineName(r.lineNo)}
                {r.family && <span className={cn("ml-1", r.familyFirst ? "text-violet-600 dark:text-violet-400" : "text-muted-foreground")}
                  title={`${r.family.orderNo} (${r.family.styleNo}) - same style family${r.familyFirst ? "" : ", but it cannot make the date here"}`}>◆</span>}
              </td>
              <td className="px-2 py-1.5">{r.available ? <FitChip fit={r.fit} /> : <span>busy</span>}</td>
              <td className="px-2 py-1.5 whitespace-nowrap">{r.available ? (r.asEntered ? (dated ? "as entered" : "today") : fmtDate(r.planningDate)) : `after ${r.busyWith.join(", ")}`}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(r.targetPerDay)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{r.pace ? fmtNum(r.pace) : "—"}{r.style && r.style.daysWorked >= 2 && (
                <span title={r.style.match === "style" ? "this style, on this line" : "this style family, on this line"}> ★</span>
              )}</td>
              <td className={cn("px-2 py-1.5 text-right tabular-nums", r.spareDays != null && r.spareDays < 0 && "text-red-600 dark:text-red-400")}>
                {r.spareDays == null ? "—" : r.spareDays}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t px-2 py-1.5 text-[10px] text-muted-foreground">
        Usually makes: the line&apos;s own average a day (★ this style, or its family, on this line). ◆ runs the same style
        family (the part before the &ldquo;/&rdquo;) - put first when it can make the date. Click a line to use it.
      </p>
    </div>
  );
}
