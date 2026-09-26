"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  CalendarDays, ChartGantt, ClipboardList, KeyRound, LayoutDashboard, LogOut, NotebookPen, PackageCheck,
  PackageOpen, Scissors, Users,
} from "lucide-react";
import { ChangePasswordDialog } from "@/components/change-password-dialog";
import { ConnectionStatus } from "@/components/connection-status";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UsersRolesDialog } from "@/components/users-roles-dialog";
import { useCan, type Permission } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Each page, and the permission needed to see it. `iconOnly` shows just its icon in the bar, its label on hover. */
export const PAGES: { href: string; label: string; icon: typeof LayoutDashboard; need: Permission; iconOnly?: boolean }[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, need: "dashboard.view" },
  { href: "/orders", label: "Orders", icon: ClipboardList, need: "orders.view" },
  { href: "/pre-production", label: "Pre-production", icon: PackageCheck, need: "preproduction.view" },
  { href: "/log", label: "Production Log", icon: NotebookPen, need: "log.view" },
  { href: "/post-production", label: "Post-production", icon: PackageOpen, need: "postproduction.view" },
  { href: "/lines", label: "Line calendar", icon: ChartGantt, need: "lines.view" },
  // The Assistant is not here on purpose: it is the button at the bottom right of every page.
  { href: "/calendar", label: "Production calendar", icon: CalendarDays, need: "calendar.view", iconOnly: true },
];

export function AppNav() {
  const path = usePathname();
  if (path === "/login") return null; // the sign-in page stands alone
  return <Bar path={path} />;
}

function Bar({ path }: { path: string }) {
  const { can } = useCan();
  const [adminOpen, setAdminOpen] = useState(false);
  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/80">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-4 px-4 sm:gap-6 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold whitespace-nowrap">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Scissors className="size-4" />
          </span>
          <span className="hidden sm:inline">Sewing Planning</span>
        </Link>
        <nav className="-mx-1 flex items-center gap-1 overflow-x-auto [scrollbar-width:none]">
          {PAGES.filter((p) => can(p.need)).map(({ href, label, icon: Icon, iconOnly }) => {
            const active = href === "/" ? path === "/" : path.startsWith(href);
            const className = cn(
              "flex items-center gap-1.5 rounded-md py-1.5 text-sm whitespace-nowrap transition-colors",
              iconOnly ? "px-2" : "px-2.5",
              active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
            );
            if (iconOnly) {
              return (
                <Tooltip key={href}>
                  <TooltipTrigger render={<Link href={href} aria-label={label} className={className} />}>
                    <Icon className="size-4" />
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{label}</TooltipContent>
                </Tooltip>
              );
            }
            return (
              <Link key={href} href={href} className={className}>
                <Icon className="size-4" />
                {label}
              </Link>
            );
          })}
        </nav>
        <ConnectionStatus />
        {can("admin.users") && (
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Users and roles"
              onClick={() => setAdminOpen(true)} />}>
              <Users />
            </TooltipTrigger>
            <TooltipContent side="bottom">Users &amp; roles</TooltipContent>
          </Tooltip>
        )}
        <ThemeToggle />
        <UserMenu />
      </div>
      <UsersRolesDialog open={adminOpen} onOpenChange={setAdminOpen} />
    </header>
  );
}

function UserMenu() {
  const { me } = useCan();
  const [pwOpen, setPwOpen] = useState(false);
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.replace("/login");
  }
  return (
    <div className="flex shrink-0 items-center gap-1">
      {me && <span className="hidden text-sm text-muted-foreground md:inline" title={me.user.username}>{me.user.displayName}</span>}
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Change password" onClick={() => setPwOpen(true)} />}>
          <KeyRound />
        </TooltipTrigger>
        <TooltipContent side="bottom">Change password</TooltipContent>
      </Tooltip>
      <Button variant="ghost" size="sm" onClick={logout} aria-label="Log out">
        <LogOut /> <span className="hidden sm:inline">Log out</span>
      </Button>
      <ChangePasswordDialog open={pwOpen} onOpenChange={setPwOpen} />
    </div>
  );
}
