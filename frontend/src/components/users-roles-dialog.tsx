"use client";

import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  api, ApiError, refreshAll, useAdminPermissions, useAdminRoles, useAdminUsers,
  type AdminRole, type AdminUser, type Permission, type PermissionInfo,
} from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const errText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

export function UsersRolesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data: u } = useAdminUsers(open);
  const { data: r } = useAdminRoles(open);
  const { data: p } = useAdminPermissions(open);
  const roles = r?.roles ?? [];
  const perms = p?.permissions ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <div className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">Administration</div>
          <DialogTitle className="text-xl">Users &amp; roles</DialogTitle>
          <DialogDescription>
            A user can have more than one role. Deactivate accounts instead of deleting them, so the history stays
            traceable. Changes apply at once - within a few seconds on screens already open.
          </DialogDescription>
        </DialogHeader>

        {open && (
          <div className="grid gap-8 md:grid-cols-2">
            <section className="grid content-start gap-4">
              <SectionTitle>Add user</SectionTitle>
              <AddUser roles={roles} />
              <div className="grid gap-2">
                {(u?.users ?? []).map((x) => <UserCard key={x.id} user={x} roles={roles} />)}
              </div>
            </section>

            <section className="grid content-start gap-4">
              <SectionTitle>Create role</SectionTitle>
              <p className="-mt-2 text-sm text-muted-foreground">
                Roles are permission groups. Create a role here, then give it to users.
              </p>
              <CreateRole perms={perms} />
              <div className="grid gap-2">
                {roles.map((x) => <RoleCard key={x.id} role={x} perms={perms} />)}
              </div>
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">{children}</h3>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid gap-1.5"><Label className="text-xs uppercase tracking-wide text-muted-foreground">{label}</Label>{children}</div>;
}

function Check({ checked, onChange, disabled, children }: {
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; children: ReactNode;
}) {
  return (
    <label className={cn("flex items-center gap-2 text-sm", disabled ? "opacity-60" : "cursor-pointer")}>
      <input type="checkbox" className="size-4 accent-primary" checked={checked} disabled={disabled}
        onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

const toggle = <T,>(list: T[], item: T, on: boolean) => (on ? [...new Set([...list, item])] : list.filter((x) => x !== item));

function RolePicker({ roles, value, onChange }: { roles: AdminRole[]; value: number[]; onChange: (v: number[]) => void }) {
  return (
    <div className="grid gap-1.5">
      {roles.map((r) => (
        <Check key={r.id} checked={value.includes(r.id)} onChange={(on) => onChange(toggle(value, r.id, on))}>
          {r.name}
        </Check>
      ))}
    </div>
  );
}

/** Permissions grouped by page, view and edit side by side. */
function PermissionPicker({ perms, value, onChange, locked }: {
  perms: PermissionInfo[]; value: Permission[]; onChange: (v: Permission[]) => void; locked?: boolean;
}) {
  const sections = [...new Set(perms.map((p) => p.section))];
  return (
    <div className="grid gap-2 rounded-lg border p-3">
      {sections.map((s) => (
        <div key={s} className="grid gap-1 sm:grid-cols-[8.5rem_1fr] sm:items-start">
          <div className="text-xs font-semibold text-muted-foreground sm:pt-0.5">{s}</div>
          <div className="grid gap-1">
            {perms.filter((p) => p.section === s).map((p) => (
              <Check key={p.key} checked={locked || value.includes(p.key)} disabled={locked}
                onChange={(on) => onChange(toggle(value, p.key, on))}>
                {p.label}
              </Check>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// --- users ---------------------------------------------------------------------

function AddUser({ roles }: { roles: AdminRole[] }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [roleIds, setRoleIds] = useState<number[]>([]);
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post("/api/admin/users", { username, displayName, password, roleIds, active });
      await refreshAll();
      toast.success(`User ${username} added`);
      setUsername(""); setDisplayName(""); setPassword(""); setRoleIds([]); setActive(true);
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="grid gap-3">
      <Field label="User ID"><Input value={username} onChange={(e) => setUsername(e.target.value)}
        placeholder="e.g. production.viewer" autoComplete="off" required /></Field>
      <Field label="Display name"><Input value={displayName} onChange={(e) => setDisplayName(e.target.value)}
        placeholder="e.g. Production Viewer" required /></Field>
      <Field label="Temporary password"><Input type="text" value={password} onChange={(e) => setPassword(e.target.value)}
        autoComplete="new-password" placeholder="At least 6 characters - they can change it after signing in" required /></Field>
      <Field label="Roles"><RolePicker roles={roles} value={roleIds} onChange={setRoleIds} /></Field>
      <Check checked={active} onChange={setActive}>Active account</Check>
      <Button type="submit" disabled={busy} className="justify-self-end">{busy ? "Adding…" : "Add user"}</Button>
    </form>
  );
}

function UserCard({ user, roles }: { user: AdminUser; roles: AdminRole[] }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className={cn("rounded-lg border bg-muted/30 p-3", !user.active && "opacity-60")}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium">
            {user.displayName}
            {!user.active && <span className="ml-2 rounded bg-slate-200 px-1.5 text-[10px] font-semibold uppercase dark:bg-slate-700">Deactivated</span>}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-1">
            {user.roles.length
              ? user.roles.map((r) => <span key={r.id} className="text-xs text-blue-700 dark:text-blue-400">{r.name}</span>)
              : <span className="text-xs text-muted-foreground">No roles - cannot see anything</span>}
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            Last sign-in: {user.lastLoginAt ? fmtDateTime(user.lastLoginAt) : "never"}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="font-mono text-xs text-muted-foreground">{user.username}</span>
          {!editing && <Button variant="outline" size="xs" onClick={() => setEditing(true)}>Manage</Button>}
        </div>
      </div>
      {editing && <EditUser user={user} roles={roles} done={() => setEditing(false)} />}
    </div>
  );
}

function EditUser({ user, roles, done }: { user: AdminUser; roles: AdminRole[]; done: () => void }) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [password, setPassword] = useState("");
  const [roleIds, setRoleIds] = useState(user.roles.map((r) => r.id));
  const [active, setActive] = useState(user.active);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api.put(`/api/admin/users/${user.id}`, { displayName, password, roleIds, active });
      await refreshAll();
      toast.success(`${displayName} updated${password ? " - new password set, their other sessions ended" : ""}`);
      done();
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 grid gap-3 border-t pt-3">
      <Field label="Display name"><Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></Field>
      <Field label="New password">
        <Input type="text" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password"
          placeholder="Leave blank to keep the current one" />
      </Field>
      <Field label="Roles"><RolePicker roles={roles} value={roleIds} onChange={setRoleIds} /></Field>
      <Check checked={active} onChange={setActive}>Active account (untick to deactivate - signs them out at once)</Check>
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={done} disabled={busy}>Cancel</Button>
        <Button size="sm" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
      </div>
    </div>
  );
}

// --- roles ---------------------------------------------------------------------

function CreateRole({ perms }: { perms: PermissionInfo[] }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<Permission[]>([]);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post("/api/admin/roles", { code, name, permissions: chosen });
      await refreshAll();
      toast.success(`Role ${name} created`);
      setCode(""); setName(""); setChosen([]);
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="grid gap-3">
      <Field label="Role code"><Input value={code} onChange={(e) => setCode(e.target.value)}
        placeholder="e.g. log_editor" autoComplete="off" required /></Field>
      <Field label="Role name"><Input value={name} onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Production Log Editor" required /></Field>
      <Field label="Permissions"><PermissionPicker perms={perms} value={chosen} onChange={setChosen} /></Field>
      <Button type="submit" disabled={busy} className="justify-self-end">{busy ? "Creating…" : "Create role"}</Button>
    </form>
  );
}

function RoleCard({ role, perms }: { role: AdminRole; perms: PermissionInfo[] }) {
  const [editing, setEditing] = useState(false);
  const labels = perms.filter((p) => role.permissions.includes(p.key)).map((p) => `${p.section}: ${p.label.toLowerCase()}`);
  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium">
            {role.name} <span className="font-mono text-xs font-normal text-blue-700 dark:text-blue-400">{role.code}</span>
            {role.builtIn && <span className="ml-2 rounded bg-slate-200 px-1.5 text-[10px] font-semibold uppercase dark:bg-slate-700">Built in</span>}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {role.builtIn ? "Every permission, always." : labels.length ? labels.join(" · ") : "No permissions yet."}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">{role.userCount} user{role.userCount === 1 ? "" : "s"}</div>
        </div>
        {!editing && <Button variant="outline" size="xs" onClick={() => setEditing(true)}>Manage</Button>}
      </div>
      {editing && <EditRole role={role} perms={perms} done={() => setEditing(false)} />}
    </div>
  );
}

function EditRole({ role, perms, done }: { role: AdminRole; perms: PermissionInfo[]; done: () => void }) {
  const [name, setName] = useState(role.name);
  const [chosen, setChosen] = useState<Permission[]>(role.permissions);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api.put(`/api/admin/roles/${role.id}`, { name, permissions: chosen });
      await refreshAll();
      toast.success(`Role ${name} updated`);
      done();
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete the role "${role.name}"? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await api.del(`/api/admin/roles/${role.id}`);
      await refreshAll();
      toast.success(`Role ${role.name} deleted`);
    } catch (err) {
      toast.error(errText(err));
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 grid gap-3 border-t pt-3">
      <Field label="Role name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Permissions">
        <PermissionPicker perms={perms} value={chosen} onChange={setChosen} locked={role.builtIn} />
        {role.builtIn && <p className="text-xs text-muted-foreground">The Administrator role always has every permission.</p>}
      </Field>
      <div className="flex items-center justify-between gap-2">
        {!role.builtIn ? (
          <Button variant="destructive" size="sm" onClick={remove} disabled={busy || role.userCount > 0}
            title={role.userCount > 0 ? "Take this role off its users first" : undefined}>
            Delete role
          </Button>
        ) : <span />}
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={done} disabled={busy}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
        </div>
      </div>
    </div>
  );
}
