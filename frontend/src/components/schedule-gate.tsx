"use client";

import { useState } from "react";
import { CalendarClock } from "lucide-react";
import { OrderDialog } from "@/components/order-dialog";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ApiError, scheduleMissing, useCan, useOrders, type Order } from "@/lib/api";
import { useLast } from "@/lib/use-last";

interface Blocked { order: Order; what: string; missing: string[] }

/**
 * Nothing can be entered against an order - pre-production tick, production,
 * packing - until it has its Line and Expected Scheduling Date (the server
 * refuses as well). `gate(order, "ticking fabric")` lets the action go ahead
 * when both are there; otherwise it opens a popup that says so, with a button
 * to fill them in there and then. Render `popup` once on the page.
 */
export function useScheduleGate() {
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  const shown = useLast(blocked);
  const [editing, setEditing] = useState<Order | null>(null);
  const shownEditing = useLast(editing); // so the form does not turn into "Add new order" as it closes
  const canEdit = useCan().can("orders.edit");
  // The order form needs the order as the server has it now, so it is looked up fresh.
  const { data: orders } = useOrders(canEdit);

  function gate(order: Order, what: string): boolean {
    const missing = scheduleMissing(order);
    if (!missing.length) return true;
    setBlocked({ order, what, missing });
    return false;
  }

  /** For a request the server refused because the order is not scheduled: the same popup. True when it was that. */
  function caught(err: unknown, order: Order, what: string): boolean {
    if (!(err instanceof ApiError) || err.code !== "not-scheduled") return false;
    setBlocked({ order, what, missing: scheduleMissing(order).length ? scheduleMissing(order) : ["Line", "Expected Scheduling Date"] });
    return true;
  }

  const fillIn = () => {
    if (!blocked) return;
    setEditing(orders?.orders.find((o) => o.id === blocked.order.id) ?? blocked.order);
    setBlocked(null);
  };

  const both = (shown?.missing.length ?? 0) > 1;
  const popup = (
    <>
      <AlertDialog open={!!blocked} onOpenChange={(o) => !o && setBlocked(null)}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <CalendarClock className="size-5 text-amber-600" />
              {both ? "Line and Expected Scheduling Date needed" : `${shown?.missing[0]} needed`}
            </AlertDialogTitle>
            <AlertDialogDescription render={<div />} className="space-y-2 text-left">
              <p>
                <b className="text-foreground">{shown?.order.orderNo}</b> has no {shown?.missing.join(" and no ")} yet.
                {" "}Fill {both ? "both" : "it"} in before {shown?.what}.
              </p>
              <p>
                Pre-production ticks, production entries and packing all wait until an order has its line and its expected
                scheduling date.
                {!canEdit && " Ask someone who can edit orders to fill them in."}
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
            {canEdit && <Button onClick={fillIn}>Fill {both ? "them" : "it"} in now</Button>}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {canEdit && <OrderDialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} order={shownEditing} />}
    </>
  );

  return { gate, caught, popup };
}
