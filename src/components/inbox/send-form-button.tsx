import { useEffect, useState } from "react";
import { ClipboardList, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { aidwar } from "@/integrations/aidwar/client";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { callApi } from "@/lib/whatsapp-client";

/** "Send form" in the composer — only when forms are on and one is published. */
export function SendFormButton({
  organizationId,
  conversationId,
  onSent,
}: {
  organizationId: string | null;
  conversationId: string;
  onSent?: () => void;
}) {
  const { enabled } = useFeatureFlag("wa_forms");
  const [forms, setForms] = useState<Array<{ id: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!enabled || !organizationId) return;
    void aidwar
      .from("wa_forms")
      .select("id, name")
      .eq("organization_id", organizationId)
      .eq("status", "published")
      .order("created_at", { ascending: false })
      .then(({ data }) => setForms((data ?? []) as Array<{ id: string; name: string }>));
  }, [enabled, organizationId]);

  if (!enabled || !organizationId || forms.length === 0) return null;

  const send = async (id: string) => {
    setBusy(true);
    const { error } = await callApi("/api/forms", {
      body: { action: "send", organization_id: organizationId, id, conversation_id: conversationId },
    });
    setBusy(false);
    if (error) toast.error(error);
    else {
      toast.success("Form sent.");
      onSent?.();
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="h-11 w-11 shrink-0 rounded-full p-0"
          disabled={busy}
          aria-label="Send form"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardList className="h-4 w-4" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Send a form</DropdownMenuLabel>
        {forms.map((f) => (
          <DropdownMenuItem key={f.id} onClick={() => void send(f.id)}>
            {f.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
