import { useState } from "react";
import { CheckCheck } from "lucide-react";
import { toast } from "sonner";
import { callApi } from "@/lib/whatsapp-client";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/** The server's answer (OptInResult in src/lib/opt-in.server.ts). */
export type BulkOptInResult = {
  changed: number;
  skipped_opted_out: number;
  already_opted_in: number;
};

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** "12 marked opted in · 3 stayed opted out · 2 were already opted in". */
export function bulkOptInSummary(r: BulkOptInResult): string {
  const parts = [`${plural(r.changed, "contact", "contacts")} marked opted in`];
  if (r.skipped_opted_out) parts.push(`${r.skipped_opted_out.toLocaleString()} stayed opted out`);
  if (r.already_opted_in) parts.push(`${r.already_opted_in.toLocaleString()} already opted in`);
  return parts.join(" · ");
}

/** Batch 36: "Mark as opted in" for the contacts ticked on the list. */
export function BulkOptInBar({
  organizationId,
  selectedIds,
  onClear,
  onDone,
}: {
  organizationId: string;
  selectedIds: string[];
  onClear: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!selectedIds.length) return null;

  async function markSelected() {
    setBusy(true);
    const res = await callApi<BulkOptInResult>("/api/contacts/opt-in", {
      body: { action: "bulk", organization_id: organizationId, contact_ids: selectedIds },
    });
    setBusy(false);
    if (res.error || !res.data) {
      toast.error(res.error ?? "We couldn't update these contacts.");
      return;
    }
    toast.success(bulkOptInSummary(res.data));
    onClear();
    onDone();
  }

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-2xl border border-primary/20 bg-primary/5 px-4 py-2.5">
      <span className="text-sm font-medium text-foreground">
        {plural(selectedIds.length, "contact", "contacts")} selected
      </span>
      <Button
        size="sm"
        className="rounded-full"
        disabled={busy}
        onClick={() => void markSelected()}
      >
        <CheckCheck className="mr-1.5 h-4 w-4" />
        {busy ? "Updating…" : "Mark as opted in"}
      </Button>
      <Button size="sm" variant="ghost" className="rounded-full" disabled={busy} onClick={onClear}>
        Clear
      </Button>
      <span className="text-xs text-muted-foreground">Contacts who opted out stay opted out.</span>
    </div>
  );
}

/** Batch 36: one click for every "unknown" contact, after a confirm with the count. */
export function MarkAllUnknownOptedIn({
  organizationId,
  onDone,
}: {
  organizationId: string;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  async function openConfirm() {
    setCount(null);
    setOpen(true);
    const res = await callApi<{ count: number }>("/api/contacts/opt-in", {
      body: { action: "count_unknown", organization_id: organizationId },
    });
    if (res.error || !res.data) {
      setOpen(false);
      toast.error(res.error ?? "We couldn't count your contacts.");
      return;
    }
    setCount(res.data.count);
  }

  async function confirm() {
    setBusy(true);
    const res = await callApi<BulkOptInResult>("/api/contacts/opt-in", {
      body: { action: "all_unknown", organization_id: organizationId },
    });
    setBusy(false);
    setOpen(false);
    if (res.error || !res.data) {
      toast.error(res.error ?? "We couldn't update your contacts.");
      return;
    }
    toast.success(bulkOptInSummary(res.data));
    onDone();
  }

  return (
    <>
      <Button variant="ghost" className="rounded-full" onClick={() => void openConfirm()}>
        <CheckCheck className="mr-2 h-4 w-4" />
        Mark all unknown as opted in
      </Button>
      <AlertDialog open={open} onOpenChange={(o) => (!busy ? setOpen(o) : undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {count === null
                ? "Counting contacts…"
                : count === 0
                  ? "No contacts with Unknown status"
                  : `Mark ${plural(count, "contact", "contacts")} as opted in?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Only contacts whose status is Unknown change. Anyone who opted out stays opted out.
              WhatsApp requires consent, so do this only if these people agreed to hear from you.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || !count}
              onClick={(e) => {
                e.preventDefault();
                void confirm();
              }}
            >
              {busy ? "Updating…" : "Mark as opted in"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
