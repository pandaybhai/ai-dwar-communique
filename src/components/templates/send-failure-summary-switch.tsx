import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { aidwar } from "@/integrations/aidwar/client";
import { usePermissions } from "@/hooks/use-permissions";
import { callApi } from "@/lib/whatsapp-client";

/**
 * Batch 63 (B): the workspace's daily "couldn't be delivered" summary on or
 * off (organizations.branding.send_failure_summary; only false is off).
 * Shown with settings.manage: in a template's Sent report (both designs) and
 * in Aiden Workspace's Settings → Notifications.
 *
 * Batch 67: and "Also send the daily failure summary on WhatsApp"
 * (branding.send_failure_summary_whatsapp; only false is off) — to the
 * workspace owner's phone on file, once AiDwar's WhatsApp template is approved.
 */
export function SendFailureSummarySwitch({
  organizationId,
  className = "",
}: {
  organizationId: string;
  className?: string;
}) {
  const { can } = usePermissions();
  const [on, setOn] = useState<boolean | null>(null);
  const [waOn, setWaOn] = useState<boolean>(true);
  const allowed = can("settings.manage");

  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    void aidwar
      .from("organizations")
      .select("branding")
      .eq("id", organizationId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!alive || error) return;
        const b = ((data as { branding?: Record<string, unknown> | null } | null)?.branding ??
          {}) as Record<string, unknown>;
        setOn(b["send_failure_summary"] !== false);
        setWaOn(b["send_failure_summary_whatsapp"] !== false);
      });
    return () => {
      alive = false;
    };
  }, [organizationId, allowed]);

  if (!allowed || on === null) return null;

  const change = async (enabled: boolean) => {
    setOn(enabled);
    const { error } = await callApi("/api/template-sends", {
      body: { organization_id: organizationId, action: "set_summary", enabled },
    });
    if (error) {
      setOn(!enabled);
      toast.error(error);
    } else toast.success(enabled ? "Daily summary on." : "Daily summary off.");
  };

  const changeWhatsapp = async (enabled: boolean) => {
    setWaOn(enabled);
    const { error } = await callApi("/api/template-sends", {
      body: { organization_id: organizationId, action: "set_summary_whatsapp", enabled },
    });
    if (error) {
      setWaOn(!enabled);
      toast.error(error);
    } else
      toast.success(
        enabled ? "WhatsApp copy of the summary on." : "WhatsApp copy of the summary off.",
      );
  };

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <label
        data-testid="send-failure-summary"
        className="flex items-start gap-3 rounded-xl border border-border/70 bg-muted/20 p-3 text-sm"
      >
        <Switch
          checked={on}
          onCheckedChange={(v) => void change(v)}
          aria-label="Daily summary of failed sends"
        />
        <span>
          <span className="block font-medium text-foreground">Daily email when sends fail</span>
          <span className="block text-xs text-muted-foreground">
            Once a day, only when a template message couldn't be delivered or an API send was
            refused: the number, the template and why. It goes to your alert email, or to the owners
            and admins.
          </span>
        </span>
      </label>
      <label
        data-testid="send-failure-summary-whatsapp"
        className="flex items-start gap-3 rounded-xl border border-border/70 bg-muted/20 p-3 text-sm"
      >
        <Switch
          checked={on && waOn}
          disabled={!on}
          onCheckedChange={(v) => void changeWhatsapp(v)}
          aria-label="Also send the daily failure summary on WhatsApp"
        />
        <span>
          <span className="block font-medium text-foreground">
            Also send the daily failure summary on WhatsApp
          </span>
          <span className="block text-xs text-muted-foreground">
            A short WhatsApp message with the count and a link, to the workspace owner's phone
            number on file.
          </span>
        </span>
      </label>
    </div>
  );
}
