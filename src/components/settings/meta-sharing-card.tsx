import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { aidwar } from "@/integrations/aidwar/client";
import { writeConsent } from "@/lib/meta-pixel";

/**
 * Batch 70: a person's own "Don't share my activity with Meta". On: the
 * Conversions API never sends an event about them (sign-up, trial, checkout,
 * payments, their workspace's milestones), and this browser's ad cookies are
 * declined too. Kept on the person's own account (auth user_metadata
 * meta_share_opt_out), so it follows them to every workspace and device.
 */
export function MetaSharingCard() {
  const [optedOut, setOptedOut] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void aidwar.auth.getUser().then(
      ({ data }) => {
        if (live) setOptedOut(data.user?.user_metadata?.["meta_share_opt_out"] === true);
      },
      () => {
        if (live) setOptedOut(false);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const change = async (next: boolean) => {
    setBusy(true);
    const { error } = await aidwar.auth.updateUser({ data: { meta_share_opt_out: next } });
    setBusy(false);
    if (error) {
      toast.error("We couldn't save that. Please try again.");
      return;
    }
    if (next) writeConsent("declined");
    setOptedOut(next);
    toast.success(next ? "We won't share your activity with Meta." : "Saved.");
  };

  return (
    <Card data-testid="meta-sharing-card">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Label htmlFor="meta-opt-out" className="text-base font-semibold text-foreground">
            Don't share my activity with Meta
          </Label>
          <p className="mt-1 text-sm text-muted-foreground">
            We tell Meta when you sign up, start a trial or pay us, to measure our own ads. Your
            customers, contacts and messages are never shared. Turn this on to stop it for you.
          </p>
        </div>
        <Switch
          id="meta-opt-out"
          checked={optedOut === true}
          disabled={optedOut === null || busy}
          onCheckedChange={(v) => void change(v)}
        />
      </div>
    </Card>
  );
}
