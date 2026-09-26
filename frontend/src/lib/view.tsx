"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

// The planning controls for THIS screen. null everywhere = the base rules,
// which is what everyone sees by default:
//   asOf          today
//   paceDays      every worked day
//   workWeek      6 days, Mon-Sat
//   calendarStart the first day anything was produced
// A change here is never saved: it applies to this browser tab only, and a
// reload goes back to the base.

export interface View {
  asOf: string | null;
  paceDays: number | null;
  workWeek: 5 | 6 | 7 | null;
  calendarStart: string | null;
}

export const BASE_VIEW: View = { asOf: null, paceDays: null, workWeek: null, calendarStart: null };

type Ctx = { view: View; setView: (patch: Partial<View>) => void; reset: () => void };

const ViewContext = createContext<Ctx>({ view: BASE_VIEW, setView: () => {}, reset: () => {} });

export function ViewProvider({ children }: { children: ReactNode }) {
  const [view, set] = useState<View>(BASE_VIEW);
  const value = useMemo<Ctx>(() => ({
    view,
    setView: (patch) => set((v) => ({ ...v, ...patch })),
    reset: () => set(BASE_VIEW),
  }), [view]);
  return <ViewContext.Provider value={value}>{children}</ViewContext.Provider>;
}

export const useView = () => useContext(ViewContext);

export const isBaseView = (v: View) =>
  v.asOf === null && v.paceDays === null && v.workWeek === null && v.calendarStart === null;

/** "?asOf=...&paceDays=5" for an API address - only what differs from the base; "" for the base plan. */
export function viewQuery(v: View): string {
  const p = new URLSearchParams();
  if (v.asOf) p.set("asOf", v.asOf);
  if (v.paceDays) p.set("paceDays", String(v.paceDays));
  if (v.workWeek) p.set("workWeek", String(v.workWeek));
  if (v.calendarStart) p.set("calendarStart", v.calendarStart);
  const s = p.toString();
  return s ? `?${s}` : "";
}
