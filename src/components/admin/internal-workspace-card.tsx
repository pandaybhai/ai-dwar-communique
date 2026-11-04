import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { callApi } from "@/lib/whatsapp-client";

type State = {
  internal: { at: string; by: string; reason: string } | null;
  billing_enabled_at: string | null;
  has_plan: boolean;
  active_mandate: boolean;
};

/**
 * Batch 58: Super Admin "Internal workspace - don't bill" for one workspace
 * (setInternalWorkspace, internal-workspace.server.ts). Audit-logged on the
 * workspace's activity log and the platform's.
 */
export function InternalWorkspaceCard({
  organizationId,
  onChanged,
}: {
  organizationId: string;
  onChanged?: () => void;
}) {
  const [state, setState] = useState<State | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await callApi<State>("/api/admin/billing", {
      body: { action: "internal_workspace", organization_id: organizationId },
    });
    if (error || !data) {
      toast.error(error ?? "We couldn't read this workspace's billing switch.");
      return;
    }
    setState(data);
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (internal: boolean) => {
    const confirmText = internal
      ? "Stop billing this workspace? No plan-fee invoices, dunning, billing notices or credit debits from now on. Usage is still recorded."
      : "Bill this workspace again from now on? Nothing from the internal period is charged.";
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    const { data, error } = await callApi<{ ok?: boolean; error?: string }>("/api/admin/billing", {
      body: { action: "set_internal_workspace", organization_id: organizationId, internal, reason },
    });
    setBusy(false);
    if (error || data?.error) {
      toast.error(error ?? data?.error ?? "That didn't work.");
      return;
    }
    toast.success(internal ? "Marked internal — this workspace isn't billed." : "Billing is on again from now.");
    setReason("");
    await load();
    onChanged?.();
  };

  if (!state) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const on = Boolean(state.internal);

  return (
    <div className="space-y-3">
      <label className="flex items-center justify-between gap-3 rounded-xl border p-3 text-sm">
        <span>
          <span className="font-medium">Internal workspace - don't bill</span>
          <span className="block text-xs text-muted-foreground">
            {on
              ? `On since ${new Date(state.internal!.at).toLocaleDateString("en-IN")} — ${state.internal!.reason}`
              : state.billing_enabled_at
                ? `Billed since ${new Date(state.billing_enabled_at).toLocaleDateString("en-IN")}.`
                : "Not billed yet (no plan with billing on)."}
          </span>
        </span>
        <Switch
          checked={on}
          disabled={busy || (!on && reason.trim().length < 3)}
          onCheckedChange={(next) => void save(next)}
          aria-label="Internal workspace - don't bill"
        />
      </label>
      {!on ? (
        <div className="space-y-1.5">
          <Label htmlFor="internal-reason" className="text-xs font-medium text-muted-foreground">
            Reason (required to switch on)
          </Label>
          <Textarea
            id="internal-reason"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Our own test workspace"
          />
        </div>
      ) : null}
      {on && state.billing_enabled_at ? (
        <p className="text-xs text-destructive">
          Billing was switched on again (billing_enabled_at is set). Switch off and on to re-apply.
        </p>
      ) : null}
      {state.active_mandate ? (
        <p className="text-xs text-amber-700">
          This workspace has an active auto-pay mandate. Marking it internal doesn't cancel the
          mandate — cancel it from Payments if it shouldn't be charged.
        </p>
      ) : null}
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
    </div>
  );
}
