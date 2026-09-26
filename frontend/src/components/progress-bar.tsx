import { fmtPct } from "@/lib/format";

export function Progress({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 min-w-12 flex-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, value * 100)}%` }} />
      </div>
      <span className="w-12 text-right text-xs tabular-nums text-muted-foreground">{fmtPct(value)}</span>
    </div>
  );
}
