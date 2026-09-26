import type { OrderPlan } from "@/lib/api";
import { fmtNum } from "@/lib/format";
import { cn } from "@/lib/utils";

type Plan = Pick<OrderPlan, "targetPerDay" | "pacePerDay" | "overdue">;

/**
 * Target / day. Red when the current pace falls short of it, or when the
 * delivery date has passed and the target is the whole balance.
 */
export function TargetValue({ plan }: { plan: Plan }) {
  if (plan.targetPerDay == null) return <>—</>;
  const short = plan.overdue || (plan.pacePerDay != null && plan.pacePerDay < plan.targetPerDay);
  return (
    <span className={cn("whitespace-nowrap", short && "font-semibold text-red-700 dark:text-red-400")}>
      {fmtNum(plan.targetPerDay)}
      {plan.overdue && (
        <span className="ml-1.5 rounded bg-red-100 px-1 py-px align-middle text-[9px] font-semibold tracking-wide uppercase dark:bg-red-950">
          overdue
        </span>
      )}
    </span>
  );
}
