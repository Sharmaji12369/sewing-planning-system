"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError } from "@/lib/api";

/** Any signed-in user can replace the temporary password an administrator gave them. */
export function ChangePasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        {open && <Form close={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function Form({ close }: { close: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (next !== again) return setError("The two new passwords are not the same");
    setBusy(true);
    setError("");
    try {
      await api.post("/api/auth/password", { current, next });
      toast.success("Password changed. You stay signed in here; other devices are signed out.");
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Change password</DialogTitle>
        <DialogDescription>At least 6 characters.</DialogDescription>
      </DialogHeader>
      <form id="pw-form" onSubmit={save} className="grid gap-3">
        <div className="grid gap-1.5">
          <Label>Current password</Label>
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        </div>
        <div className="grid gap-1.5">
          <Label>New password</Label>
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
        </div>
        <div className="grid gap-1.5">
          <Label>New password again</Label>
          <Input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </form>
      <DialogFooter>
        <Button variant="outline" onClick={close} disabled={busy}>Cancel</Button>
        <Button type="submit" form="pw-form" disabled={busy}>{busy ? "Saving…" : "Change password"}</Button>
      </DialogFooter>
    </>
  );
}
