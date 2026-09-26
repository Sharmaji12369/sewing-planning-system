"use client";

import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { fmtDate } from "@/lib/format";
import { isBaseView, useView } from "@/lib/view";

/** Every page says so when this screen's planning controls differ from the base plan. */
export function ViewBanner() {
  const { view, reset } = useView();
  const path = usePathname();
  if (isBaseView(view) || path === "/login") return null;

  const parts = [
    view.asOf && <>plan as of <b>{fmtDate(view.asOf)}</b></>,
    view.paceDays && <>pace over the last <b>{view.paceDays}</b> worked days</>,
    view.workWeek && <><b>{view.workWeek}</b>-day week</>,
    view.calendarStart && <>calendar from <b>{fmtDate(view.calendarStart)}</b></>,
  ].filter(Boolean);

  return (
    <div className="border-b border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5 text-sm sm:px-6">
        <span>
          Not the base plan:{" "}
          {parts.map((p, i) => <span key={i}>{i > 0 && " · "}{p}</span>)}.
          {" "}On your screen only - everyone else sees the base plan.
        </span>
        <Button variant="outline" size="xs" onClick={reset}>Reset to base</Button>
      </div>
    </div>
  );
}
