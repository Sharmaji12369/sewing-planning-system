"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";
import { PAGES } from "@/components/app-nav";
import { NoAccess } from "@/components/guard";
import {
  DeliveryCell, EmptyRow, FilterPills, OrderCell, PaceCell, ProgressCell, SearchBox, STATUS_TONE, TH,
} from "@/components/order-cells";
import { LoadState, PageHeader } from "@/components/page-header";
import { SettingsPanel } from "@/components/settings-panel";
import { StatusBadge } from "@/components/status-badge";
import { LineValue, StartDateValue } from "@/components/start-date";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { lineName, STATUSES, useCan, useDashboard, type Kpis, type Status } from "@/lib/api";
import { fmtDate, fmtNum, fmtPct } from "@/lib/format";
import { cn } from "@/lib/utils";

const ALL = "all";
const SHORT: Record<Status, string> = {
  "BEHIND SCHEDULE": "Behind", "AT RISK": "At risk", "ON TRACK": "On track", "NOT STARTED": "Not started", COMPLETED: "Completed",
};

/**
 * "/" is the Dashboard. Someone whose role has no Dashboard access is taken
 * to the first page they can see instead.
 */
export default function DashboardPage() {
  const { can, loading } = useCan();
  const router = useRouter();
  const firstAllowed = PAGES.find((p) => can(p.need))?.href;
  const allowed = can("dashboard.view");

  useEffect(() => {
    if (!loading && !allowed && firstAllowed) router.replace(firstAllowed);
  }, [loading, allowed, firstAllowed, router]);

  if (loading) return <LoadState loading />;
  if (!allowed) return firstAllowed ? <LoadState loading /> : <NoAccess />;
  return <Dashboard />;
}

function Dashboard() {
  const { data, error, isLoading } = useDashboard();
  const { can } = useCan();
  const [filter, setFilter] = useState<Status | typeof ALL>(ALL);
  const [q, setQ] = useState("");

  const rows = useMemo(() => {
    const all = data?.orders ?? [];
    const needle = q.trim().toLowerCase();
    // Most urgent first: by status, then by required date.
    const rank = (s: Status) => STATUSES.indexOf(s);
    return all
      .filter((o) => (filter === ALL || o.plan.status === filter) &&
        (!needle || [o.orderNo, o.styleNo, lineName(o.lineNo), o.colour].some((v) => v.toLowerCase().includes(needle))))
      .sort((a, b) => rank(a.plan.status) - rank(b.plan.status) || a.requiredDate.localeCompare(b.requiredDate));
  }, [data, filter, q]);

  if (!data) return <LoadState error={error} loading={isLoading} />;
  const { kpis: k, asOf, today, settings } = data;
  const pills = [
    { value: ALL as typeof ALL, label: "All", count: k.counts.total },
    ...STATUSES.map((s) => ({ value: s, label: SHORT[s], count: k.counts[s], dot: STATUS_TONE[s] })),
  ];

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={<>Planned as of <b className="font-medium text-foreground">{fmtDate(asOf)}</b>{asOf === today ? " (today)" : " - not today, see Planning controls"}</>}
        actions={can("log.edit") && <Button nativeButton={false} render={<Link href="/log" />}>Log production</Button>}
      />

      <div className="grid gap-4">
        <SettingsPanel today={today} asOf={asOf} />

        <div className="grid gap-4 lg:grid-cols-4">
          <ProgressCard k={k} />
          <OutputCard k={k} paceDays={settings.paceDays} />
        </div>

        <Card className="gap-0 py-0">
          <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
            <h2 className="mr-2 text-sm font-semibold">Orders</h2>
            <FilterPills items={pills} value={filter} onChange={setFilter} />
            <SearchBox value={q} onChange={setQ} placeholder="Search order, style, line, colour…" className="w-full sm:ml-auto sm:w-64" />
          </div>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className={`${TH} pl-4`}>Order</TableHead>
                <TableHead className={TH}>Line</TableHead>
                <TableHead className={TH}>Progress</TableHead>
                <TableHead className={`${TH} text-right`}>Per day</TableHead>
                <TableHead className={`${TH} pl-6`}>Delivery</TableHead>
                <TableHead className={TH}>Start</TableHead>
                <TableHead className={`${TH} pr-4`}>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((o) => (
                <TableRow key={o.id}>
                  <TableCell className="py-3 pl-4"><OrderCell o={o} /></TableCell>
                  <TableCell><LineValue order={o} /></TableCell>
                  <TableCell><ProgressCell o={o} /></TableCell>
                  <TableCell><PaceCell o={o} /></TableCell>
                  <TableCell className="pl-6"><DeliveryCell o={o} /></TableCell>
                  <TableCell className="tabular-nums"><StartDateValue order={o} asOf={asOf} /></TableCell>
                  <TableCell className="pr-4"><StatusBadge status={o.plan.status} /></TableCell>
                </TableRow>
              ))}
              {!rows.length && (
                <EmptyRow span={7}>
                  {data.orders.length ? "No orders match." : <>No orders yet. <Link className="underline" href="/orders">Add one</Link>.</>}
                </EmptyRow>
              )}
            </TableBody>
          </Table>
        </Card>
      </div>
    </>
  );
}

/** How far the whole order book has got. */
function ProgressCard({ k }: { k: Kpis }) {
  return (
    <Card className="gap-0 px-5 py-4 lg:col-span-2">
      <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Overall progress</div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3">
        <span className="text-3xl font-semibold tabular-nums">{fmtPct(k.pctComplete)}</span>
        <span className="text-sm text-muted-foreground">
          <b className="font-semibold text-foreground">{fmtNum(k.totalProduced)}</b> made of {fmtNum(k.totalQty)}
        </span>
      </div>
      <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.min(100, k.pctComplete * 100)}%` }} />
      </div>
      <div className="mt-2 flex flex-wrap justify-between gap-x-4 text-xs text-muted-foreground">
        <span><b className="font-medium text-foreground">{fmtNum(k.totalBalance)}</b> still to make</span>
        <span>{k.counts.total} orders · {k.counts.COMPLETED} completed</span>
      </div>
    </Card>
  );
}

/** What the factory makes a day against what the open orders need a day. */
function OutputCard({ k, paceDays }: { k: Kpis; paceDays: number | null }) {
  const gap = k.avgPerDay - k.neededPerDay;
  const covers = k.avgPerDay > 0 && gap >= 0;
  return (
    <Card className="gap-0 px-5 py-4 lg:col-span-2">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Average per worked day</div>
          <div className="mt-1 text-3xl font-semibold tabular-nums">{fmtNum(k.avgPerDay)}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            over {paceDays ? `the last ${k.workedDays}` : k.workedDays} worked day{k.workedDays === 1 ? "" : "s"}, all orders
          </div>
        </div>
        <div>
          <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Needed per day</div>
          <div className="mt-1 text-3xl font-semibold tabular-nums">{fmtNum(k.neededPerDay)}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            every open order&apos;s target together
            {k.overdueBalance > 0 && <>, incl. {fmtNum(k.overdueBalance)} already overdue</>}
          </div>
        </div>
      </div>
      <div className={cn("mt-3 flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium",
        k.avgPerDay === 0 ? "bg-muted text-muted-foreground"
          : covers ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300"
          : "bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300")}>
        {k.avgPerDay === 0 ? "No production logged yet."
          : covers ? <><TrendingUp className="size-4" /> Today&apos;s pace covers what is needed, with {fmtNum(gap)} a day to spare.</>
          : <><TrendingDown className="size-4" /> Short by {fmtNum(-gap)} a day against what the open orders need.</>}
      </div>
    </Card>
  );
}
