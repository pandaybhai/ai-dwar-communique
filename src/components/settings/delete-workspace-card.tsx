import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
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
import { aidwar } from "@/integrations/aidwar/client";
import { useOrg } from "@/lib/org-context";

type RequestRow = { id: string; status: string; created_at: string };

/** Owner-only self-serve workspace deletion request. */
export function DeleteWorkspaceCard() {
  const { active, profile } = useOrg();
  const isOwner = active?.role === "owner";
  const orgId = active?.organization.id;
  const orgName = active?.organization.name ?? "";

  const [loading, setLoading] = useState(true);
  const [request, setRequest] = useState<RequestRow | null>(null);
  const [confirm, setConfirm] = useState("");
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    const { data } = await aidwar
      .from("deletion_requests")
      .select("id, status, created_at")
      .eq("organization_id", orgId)
      .in("status", ["pending", "acknowledged"])
      .maybeSingle();
    setRequest((data as RequestRow | null) ?? null);
    setLoading(false);
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!isOwner) return null;

  async function submit() {
    if (!orgId) return;
    setSubmitting(true);
    const { data: userData } = await aidwar.auth.getUser();
    const { error } = await aidwar.from("deletion_requests").insert({
      organization_id: orgId,
      requested_by: userData.user?.id,
      requester_email: profile?.email ?? userData.user?.email ?? null,
      reason: reason.trim() || null,
      status: "pending",
    });
    setSubmitting(false);
    setOpen(false);
    if (error) {
      toast.error("We couldn't submit your deletion request. Please try again.");
      return;
    }
    setConfirm("");
    setReason("");
    toast.success("Deletion request received. We'll confirm by email.");
    await load();
  }

  return (
    <div className="rounded-2xl border border-destructive/30 bg-destructive/[0.03] p-6 shadow-sm sm:p-8">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
          <AlertTriangle className="size-5" />
        </div>
        <div>
          <h2 className="text-base font-semibold text-foreground">Delete workspace</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Permanently deletes this workspace and everything in it — contacts, conversations and
            messages, campaigns, templates, automations, team members, and the stored WhatsApp
            credentials, access token and two-step PIN. This can&apos;t be undone.
          </p>
        </div>
      </div>

      {loading ? (
        <Skeleton className="mt-6 h-24 w-full rounded-xl" />
      ) : request ? (
        <div className="mt-6 rounded-xl border border-border bg-card p-4 text-sm">
          <p className="font-medium text-foreground">Deletion request received</p>
          <p className="mt-1 text-muted-foreground">
            Requested on {new Date(request.created_at).toLocaleDateString()}. We acknowledge within 7
            days and complete deletion within 30 days, then confirm by email. To cancel, write to{" "}
            <a href="mailto:privacy@aidwar.in" className="text-primary hover:underline">
              privacy@aidwar.in
            </a>
            .
          </p>
        </div>
      ) : (
        <div className="mt-6 max-w-md space-y-4">
          <div className="space-y-2">
            <Label htmlFor="delete_reason">Reason (optional)</Label>
            <Textarea
              id="delete_reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Anything you'd like us to know"
              rows={2}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="delete_confirm">
              Type <span className="font-semibold text-foreground">{orgName}</span> to confirm
            </Label>
            <Input
              id="delete_confirm"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={orgName}
            />
          </div>
          <Button
            variant="destructive"
            className="rounded-full"
            disabled={confirm.trim() !== orgName}
            onClick={() => setOpen(true)}
          >
            Request deletion
          </Button>
          <p className="text-xs text-muted-foreground">
            See the{" "}
            <Link to="/data-deletion" className="text-primary hover:underline">
              data deletion policy
            </Link>{" "}
            for what we delete and what we&apos;re required to keep.
          </p>
        </div>
      )}

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{orgName}”?</AlertDialogTitle>
            <AlertDialogDescription>
              All workspace data is erased and the stored Meta access token is revoked and deleted.
              We acknowledge within 7 days, complete within 30 days, and confirm by email. This
              can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Keep workspace</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void submit();
              }}
              disabled={submitting}
            >
              {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Yes, delete it
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
