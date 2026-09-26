import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { lineName, scheduleMissing, type PlannedOrder } from "@/lib/api";
import { fmtDate, fmtNum } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The day production should start: order qty / target per day in working
 * days, run back from the required delivery date, less one buffer day. Red
 * when that day has passed and nothing has been made yet; amber when the
 * order has been moved back behind another one on its line.
 */
export function StartDateValue({ order, asOf }: { order: PlannedOrder; asOf: string }) {
  const p = order.plan;
  if (!p.scheduled && p.produced === 0) return <NotScheduled order={order} />;
  if (!p.startDate) return <>—</>;
  const missed = p.produced === 0 && p.startDate < asOf;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className={cn("cursor-help whitespace-nowrap underline decoration-dotted underline-offset-4",
          p.waitingFor && "text-amber-700 dark:text-amber-400",
          missed && "font-semibold text-red-700 dark:text-red-400")} />}
      >
        {fmtDate(p.startDate)}
        {p.waitingFor && <span className="block text-[10px] leading-tight no-underline">after {p.waitingFor}</span>}
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        {p.waitingFor && (
          <p className="mb-1">
            {lineName(order.lineNo)} is still busy with {p.waitingFor}, so this order waits for it: scheduled from{" "}
            {fmtDate(p.planFrom)} instead of its expected scheduling date {fmtDate(order.planningDate ?? p.planFrom)}.
          </p>
        )}
        {fmtNum(order.orderQty)} ÷ {fmtNum(p.targetPerDay)} a day = {fmtNum(p.startDays, 1)} working days, ending on the
        required date {fmtDate(order.requiredDate)}, less 1 day buffer.
        {missed && " This day has passed and production has not started."}
      </TooltipContent>
    </Tooltip>
  );
}

/** An amber "Not scheduled" in place of a start date: what is missing, and what it holds up. */
export function NotScheduled({ order }: { order: PlannedOrder }) {
  const missing = scheduleMissing(order);
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="cursor-help rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-amber-800 dark:bg-amber-950 dark:text-amber-300" />}>
        Not scheduled
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        No {missing.join(" and no ")} yet, so it holds no line and has no start or pre-production dates. Nothing can be
        ticked or logged for it until both are filled in - update the order, or drag it onto the Line calendar.
      </TooltipContent>
    </Tooltip>
  );
}

/** "Line 3", or an amber "No line" while it is not decided; red when it clashes on its line. */
export function LineValue({ order }: { order: PlannedOrder }) {
  if (!order.lineNo) {
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="cursor-help rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-amber-800 dark:bg-amber-950 dark:text-amber-300" />}>
          No line
        </TooltipTrigger>
        <TooltipContent>No line decided yet. Update the order and pick its line, or drag it onto the Line calendar.</TooltipContent>
      </Tooltip>
    );
  }
  const pill = "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap";
  if (!order.plan.overlaps.length) return <span className={cn(pill, "bg-muted")}>{lineName(order.lineNo)}</span>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn(pill, "cursor-help bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300")} />}>
        {lineName(order.lineNo)} !
      </TooltipTrigger>
      <TooltipContent>
        Booked on the same days as {order.plan.overlaps.join(", ")} - production is logged for both at once.
      </TooltipContent>
    </Tooltip>
  );
}
