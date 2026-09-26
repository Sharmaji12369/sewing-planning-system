import type { Status } from "@/lib/api";
import { STATUS_STYLE } from "@/lib/format";
import { cn } from "@/lib/utils";

export function StatusBadge({ status, className }: { status: Status; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full px-2 text-[11px] font-semibold tracking-wide whitespace-nowrap",
        STATUS_STYLE[status],
        className,
      )}
    >
      {status}
    </span>
  );
}
