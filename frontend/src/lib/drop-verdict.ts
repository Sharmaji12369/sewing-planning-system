import type { Fit, LineCalendarData, MoveAdvice } from "./api";
import { fmtDate, fmtNum, weekdayName } from "./format";

/**
 * What the line calendar says about each spot a dragged order hovers over,
 * worked out in the page from the advisor's view of every line (fetched once
 * when the order is picked up) and the calendar already on screen - so it
 * keeps up with the mouse. The server still judges the drop itself.
 *
 * The fit rule mirrors backend/src/advisor.ts (fitOf, COMFORT_MARGIN).
 */

const COMFORT_MARGIN = 0.15;

export function fitOf(target: number | null, pace: number | null, best: number | null): Fit {
  if (!target || target <= 0) return pace ? "comfortable" : "unknown";
  if (!pace) return "unknown";
  if (pace >= target * (1 + COMFORT_MARGIN)) return "comfortable";
  if (pace >= target) return "tight";
  if (best && best >= target) return "stretch";
  return "beyond";
}

export type Tone = "good" | "warn" | "bad" | "neutral";

export interface Verdict {
  tone: Tone;
  title: string;      // "Line 3 · starts Mon 12 Oct"
  detail: string;     // the judgement
  note?: string;      // pre-production not ticked, and so on
  family?: string;    // the line is set up for the order's style family
  fit?: Fit;
}

const FAMILY_HOW = {
  running: "running on this line now", before: "which runs on this line just before it",
  after: "which runs on this line just after it", last: "the last order this line ran",
} as const;

const TONE_OF: Record<Fit, Tone> = { comfortable: "good", tight: "warn", stretch: "warn", beyond: "bad", unknown: "neutral" };

/**
 * Working days from `start` to `end`, inclusive, on one line: a working day
 * counts 1, less any idle portion marked for it. Past the calendar's last day,
 * the working week is assumed.
 */
function capacity(cal: LineCalendarData, lineNo: number, start: string, end: string): number {
  const row = cal.rows.find((r) => r.lineNo === lineNo);
  let total = 0;
  let last = start;
  cal.days.forEach((d, i) => {
    if (d.date < start || d.date > end) return;
    last = d.date;
    if (d.working) total += 1 - (row?.idle[i] ?? 0);
  });
  if (end > cal.end) {
    const extra = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / 86_400_000);
    total += (extra * cal.settings.workDaysPerWeek) / 7;
  }
  return total;
}

export function judgeDrop(cal: LineCalendarData, help: MoveAdvice, lineNo: number, start: string): Verdict {
  const o = help.order;
  const title = `Line ${lineNo} · starts ${weekdayName(start)} ${fmtDate(start).slice(0, 6)}`;
  const end = o.requiredDate > start ? o.requiredDate : start;
  const note = help.missing.length ? `${help.missing.join(", ")} not ticked yet - it cannot start until they are.` : undefined;

  if (start > o.requiredDate) {
    return { tone: "bad", title, detail: `After its required date (${fmtDate(o.requiredDate)}) - this will be refused.`, note };
  }
  const row = cal.rows.find((r) => r.lineNo === lineNo);
  const clash = row?.blocks
    .filter((b) => b.orderId !== o.id && b.kind !== "done" && b.start <= end && start <= b.end)
    .sort((a, b) => b.end.localeCompare(a.end))[0];
  if (clash) {
    return { tone: "bad", title, detail: `Clashes with ${clash.orderNo}, booked until ${fmtDate(clash.end)} - this will be refused.`, note };
  }

  const line = help.advice.ranked.find((r) => r.lineNo === lineNo);
  const days = Math.max(1, capacity(cal, lineNo, start, o.requiredDate));
  const target = Math.ceil(o.orderQty / days);
  const pace = line?.pace ?? null;
  const fit = fitOf(target, pace, line?.record.bestDay ?? null);
  const spare = pace ? Math.floor(days - o.orderQty / pace) : null;
  const makes = pace ? `Line ${lineNo} usually makes ${fmtNum(pace)}${line?.style && line.style.daysWorked >= 2
    ? line.style.match === "style" ? " of this style" : " of this style family" : ""}` : "";
  const detail = {
    comfortable: `Needs ${fmtNum(target)} a day · ${makes} - about ${spare} working day${spare === 1 ? "" : "s"} to spare.`,
    tight: `Needs ${fmtNum(target)} a day · ${makes} - just about makes it.`,
    stretch: `Needs ${fmtNum(target)} a day · ${makes} - only on its best days (${fmtNum(line?.record.bestDay)}).`,
    beyond: `Needs ${fmtNum(target)} a day · ${makes} - more than it has ever made in a day.`,
    unknown: `Needs ${fmtNum(target)} a day · no record on Line ${lineNo} yet to judge by.`,
  }[fit];
  // A line running (or queued with) the same style family: little changeover. From the advisor, which ranks it first.
  const f = line?.family;
  const family = f
    ? `Same style family as ${f.orderNo} (${f.styleNo}), ${FAMILY_HOW[f.how]} - little changeover.`
    : undefined;
  return { tone: TONE_OF[fit], title, detail, note, family, fit };
}
