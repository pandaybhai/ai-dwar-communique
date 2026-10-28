import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { callApi } from "@/lib/whatsapp-client";
import { activeRunsLine, FLOW_RESTORE_DAYS } from "@/lib/flow-delete";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * Batch 35: "Delete flow" — the confirm dialog says how many conversations
 * are running in it, and why it can't be deleted when it is a built-in or
 * platform flow. Used by the Flows list and the flow editor.
 */
export function DeleteFlowDialog({
  organizationId,
  flow,
  open,
  onOpenChange,
  onDeleted,
}: {
  organizationId: string;
  flow: { id: string; name: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const [check, setCheck] = useState<{ active_runs: number; refusal: string | null } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const flowId = flow?.id ?? null;
  useEffect(() => {
    if (!open || !flowId) return;
    setCheck(null);
    setFailed(null);
    let cancelled = false;
    void callApi<{ active_runs: number; refusal: string | null }>("/api/flows/v2", {
      body: { action: "delete_check", organization_id: organizationId, flow_id: flowId },
    }).then(({ data, error }) => {
      if (cancelled) return;
      if (data) setCheck(data);
      else setFailed(error ?? "We couldn't check this flow.");
    });
    return () => {
      cancelled = true;
    };
  }, [open, flowId, organizationId]);

  const remove = async () => {
    if (!flow) return;
    setBusy(true);
    const { data, error } = await callApi<{ ended_runs: number }>("/api/flows/v2", {
      body: { action: "delete_flow", organization_id: organizationId, flow_id: flow.id },
    });
    setBusy(false);
    if (error || !data) {
      toast.error(error ?? "We couldn't delete this flow.");
      return;
    }
    toast.success(
      data.ended_runs
        ? `Flow deleted. ${data.ended_runs} running conversation${data.ended_runs === 1 ? "" : "s"} ended quietly.`
        : "Flow deleted.",
    );
    onOpenChange(false);
    onDeleted();
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{flow?.name ?? "this flow"}”?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground" data-testid="delete-flow-body">
              {failed ? (
                <p className="text-destructive">{failed}</p>
              ) : !check ? (
                <p className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" /> Checking running conversations…
                </p>
              ) : check.refusal ? (
                <p className="text-destructive">{check.refusal}</p>
              ) : (
                <>
                  <p>{activeRunsLine(check.active_runs)}</p>
                  <p>
                    Its keywords and triggers stop at once. Past conversations, answers and messages
                    stay. You can restore it from “Deleted flows” for {FLOW_RESTORE_DAYS} days.
                  </p>
                </>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="rounded-full">Keep it</AlertDialogCancel>
          <Button
            variant="destructive"
            className="rounded-full"
            disabled={busy || !check || Boolean(check.refusal)}
            onClick={() => void remove()}
          >
            {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            Delete flow
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
