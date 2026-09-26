"use client";

import type { ReactNode } from "react";
import { ThemeProvider } from "next-themes";
import { SWRConfig } from "swr";
import { ViewProvider } from "@/lib/view";

/** How often every open screen re-reads the database, so one person's change reaches everyone. */
export const SYNC_MS = 10_000;

export function Providers({ children }: { children: ReactNode }) {
  return (
    // Light or dark, remembered per browser. Adds class="dark" to <html>, which globals.css keys on.
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} disableTransitionOnChange>
      <SWRConfig
        value={{
          refreshInterval: SYNC_MS,     // pull fresh data every 10 s while the tab is visible
          revalidateOnFocus: true,      // and straight away when someone comes back to the tab
          revalidateOnReconnect: true,  // and when the network comes back
          keepPreviousData: true,       // keep showing the last data while refreshing - no flicker
          errorRetryInterval: 5_000,
        }}
      >
        <ViewProvider>{children}</ViewProvider>
      </SWRConfig>
    </ThemeProvider>
  );
}
