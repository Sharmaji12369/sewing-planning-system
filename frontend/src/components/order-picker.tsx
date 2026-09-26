"use client";

import { Combobox } from "@base-ui/react/combobox";
import { ChevronDown, Search } from "lucide-react";

export interface OrderOption {
  value: string;
  label: string;       // what the box shows once picked
  search: string;      // lower-case text the typing is matched against
  note?: string;       // shown on the right, e.g. why it cannot be picked
  disabled?: boolean;
}

/** A dropdown you can type into: finds an order by number, style, line or colour. */
export function OrderPicker({ items, value, onChange, placeholder = "Search order, style or line…" }: {
  items: OrderOption[]; value: string | null; onChange: (v: string | null) => void; placeholder?: string;
}) {
  const selected = items.find((i) => i.value === value) ?? null;
  return (
    <Combobox.Root
      items={items}
      value={selected}
      onValueChange={(v: OrderOption | null) => onChange(v?.value ?? null)}
      itemToStringLabel={(i: OrderOption) => i.label}
      isItemEqualToValue={(a: OrderOption, b: OrderOption) => a.value === b.value}
      filter={(i: OrderOption, query: string) => i.search.includes(query.trim().toLowerCase())}
    >
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Combobox.Input
          placeholder={placeholder}
          aria-label="Order"
          className="h-8 w-full rounded-lg border border-input bg-transparent py-1 pr-8 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        />
        <Combobox.Trigger aria-label="Show all orders"
          className="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted">
          <ChevronDown className="size-4" />
        </Combobox.Trigger>
      </div>
      <Combobox.Portal>
        <Combobox.Positioner sideOffset={4} className="isolate z-50">
          <Combobox.Popup className="max-h-72 w-(--anchor-width) overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
            <Combobox.Empty className="px-2 py-1.5 text-sm text-muted-foreground empty:hidden">No order matches.</Combobox.Empty>
            <Combobox.List>
              {(i: OrderOption) => (
                <Combobox.Item key={i.value} value={i} disabled={i.disabled}
                  className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground data-selected:font-medium">
                  <span className="min-w-0 flex-1 truncate">{i.label}</span>
                  {i.note && <span className="shrink-0 text-xs text-muted-foreground">{i.note}</span>}
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
