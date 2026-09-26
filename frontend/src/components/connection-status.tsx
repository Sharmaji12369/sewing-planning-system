"use client";

import useSWR from "swr";
import { SYNC_MS } from "@/components/providers";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Ping = { ms: number };

class PingError extends Error {
  constructor(public kind: "server" | "database") { super(kind); }
}

/** One round trip to the server, which itself asks the database. */
async function ping(): Promise<Ping> {
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch("/api/health", { cache: "no-store" });
  } catch {
    throw new PingError("server");
  }
  if (res.status === 503) throw new PingError("database");
  if (!res.ok) throw new PingError("server");
  return { ms: Math.round(performance.now() - t0) };
}

const SLOW_MS = 1000;

export function ConnectionStatus() {
  const { data, error } = useSWR<Ping, PingError>("health", ping, {
    refreshInterval: SYNC_MS,
    errorRetryInterval: 5_000,
    keepPreviousData: false,
  });

  const state = error ? "down" : !data ? "checking" : data.ms > SLOW_MS ? "slow" : "live";
  const label = {
    live: `Live · ${data?.ms} ms`,
    slow: `Slow · ${((data?.ms ?? 0) / 1000).toFixed(1)} s`,
    down: error?.kind === "database" ? "Database offline" : "Offline",
    checking: "Connecting…",
  }[state];
  const explain = {
    live: "Connected to the server and the database. Every save goes straight to the database, and this screen re-reads it every 10 seconds.",
    slow: "Connected, but the server is answering slowly. Saves still go to the database.",
    down: error?.kind === "database"
      ? "The server is up but the database is not answering. Changes cannot be saved until it is back."
      : "Cannot reach the server. Changes cannot be saved until the connection is back. Retrying every 5 seconds.",
    checking: "Checking the connection…",
  }[state];

  return (
    <Tooltip>
      <TooltipTrigger
        render={<span />}
        className={cn(
          "ml-auto flex shrink-0 cursor-default items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium whitespace-nowrap",
          state === "live" && "border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-300",
          state === "slow" && "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
          state === "down" && "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300",
          state === "checking" && "text-muted-foreground",
        )}
      >
        <span className={cn(
          "size-2 rounded-full",
          state === "live" && "bg-green-500",
          state === "slow" && "bg-amber-500",
          state === "down" && "animate-pulse bg-red-500",
          state === "checking" && "bg-muted-foreground/50",
        )} />
        {label}
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-64">{explain}</TooltipContent>
    </Tooltip>
  );
}
