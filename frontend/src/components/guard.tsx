"use client";

import type { ReactNode } from "react";
import { ShieldX } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useCan, type Permission } from "@/lib/api";

/**
 * Shows a page only to users whose roles allow it. (The server refuses the
 * data anyway - this just explains why instead of showing an empty page.)
 */
export function Guard({ need, children }: { need: Permission; children: ReactNode }) {
  const { can, loading } = useCan();
  if (loading) return <div className="p-8 text-center text-sm text-muted-foreground">Loading…</div>;
  if (!can(need)) return <NoAccess />;
  return <>{children}</>;
}

export function NoAccess() {
  return (
    <Card className="mx-auto mt-10 max-w-md">
      <CardContent className="flex flex-col items-center gap-3 py-6 text-center">
        <ShieldX className="size-8 text-muted-foreground" />
        <div className="font-medium">You don&apos;t have access to this page</div>
        <p className="text-sm text-muted-foreground">
          Your role does not include it. Ask an administrator to add it under Users &amp; roles.
        </p>
      </CardContent>
    </Card>
  );
}
