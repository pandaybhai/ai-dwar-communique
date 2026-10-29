import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { callApi } from "@/lib/whatsapp-client";
import type { TemplateRow } from "@/lib/templates";
import { deleteTemplateRequest } from "./templates-data";

/**
 * Batch 51: "Delete template" from a gallery tile's menu. The dialog names the
 * template; Delete calls the Templates route's "delete" action, which refuses
 * while a campaign or an active flow still sends it (the reason shows here)
 * and otherwise deletes it on Meta and marks it as Meta's DELETED notice does.
 */
export function DeleteTemplateDialog({
  organizationId,
  template,
  onOpenChange,
  onDeleted,
}: {
  organizationId: string;
  template: TemplateRow | null;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const remove = async () => {
    if (!template) return;
    setBusy(true);
    setRefusal(null);
    const { error } = await callApi("/api/whatsapp/templates", {
      body: deleteTemplateRequest(organizationId, template.id),
    });
    setBusy(false);
    if (error) {
      setRefusal(error);
      return;
    }
    toast.success(`Deleted “${template.name}”.`);
    onOpenChange(false);
    onDeleted();
  };

  return (
    <AlertDialog
      open={template !== null}
      onOpenChange={(open) => {
        if (busy) return;
        if (!open) setRefusal(null);
        onOpenChange(open);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{template?.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            It is deleted on your WhatsApp business account too ({template?.language}). Meta doesn’t
            let a deleted template’s name be used again for 30 days, and this can’t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {refusal ? (
          <p
            role="alert"
            className="m-0 rounded-[14px] border border-danger-border bg-danger-soft px-3 py-2 text-sm text-danger-soft-foreground"
          >
            {refusal}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Keep it</AlertDialogCancel>
          <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
            {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : null}
            Delete template
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
