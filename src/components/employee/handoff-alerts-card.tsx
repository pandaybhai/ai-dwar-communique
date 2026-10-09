import { useCallback, useEffect, useState } from "react";
import { BellRing, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { employeeApi } from "@/lib/employee-client";

type AlertsView = {
  phones: string[];
  email: string | null;
  business_numbers: string[];
  owner_phone: string | null;
  owner_is_business_number: boolean;
};

/**
 * Batch 16: who hears about a chat that needs a person (the customer asked
 * for one, or a flow handed it over). 1–2 staff WhatsApp numbers plus an
 * email; the business's own WhatsApp number is refused with the reason.
 */
export function HandoffAlertsCard({
  organizationId,
  canConfigure,
}: {
  organizationId: string;
  canConfigure: boolean;
}) {
  const [view, setView] = useState<AlertsView | null>(null);
  const [phones, setPhones] = useState<[string, string]>(["", ""]);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const apply = (data: AlertsView | null) => {
    setView(data);
    setPhones([data?.phones[0] ?? "", data?.phones[1] ?? ""]);
    setEmail(data?.email ?? "");
  };

  const load = useCallback(async () => {
    const { data } = await employeeApi<AlertsView>({ organization_id: organizationId, action: "handoff_alerts" });
    apply(data ?? null);
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setError(null);
    const { data, error: err } = await employeeApi<AlertsView>({
      organization_id: organizationId,
      action: "save_handoff_alerts",
      phones: phones.map((p) => p.trim()).filter(Boolean),
      email: email.trim(),
    });
    setSaving(false);
    if (err) {
      setError(err);
      return;
    }
    apply(data ?? null);
    toast.success("Saved — your team will hear about chats that need a person.");
  };

  const noStaff = view !== null && view.phones.length === 0 && !view.email;

  return (
    <section aria-labelledby="handoff-alerts-heading" className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
      <div className="flex items-start gap-3">
        <BellRing className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 id="handoff-alerts-heading" className="text-base font-semibold text-foreground">
            Who hears when a chat needs a person
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            I only hand a chat to your team when the customer asks for a person or a flow assigns it. Then I
            step back on that chat, show it as “Waiting for you” in the Inbox and message your staff from the
            AiDwar number — once, and one reminder after 30 minutes during business hours. When I don't know
            something I keep talking and note the question for you instead.
          </p>
        </div>
      </div>

      {noStaff && view?.owner_is_business_number ? (
        <p className="mt-4 rounded-xl bg-amber-500/10 px-3.5 py-2.5 text-sm text-amber-800 dark:text-amber-300">
          The phone on your account ({view.owner_phone}) is this business's own WhatsApp number, so an alert
          there would land in the same inbox it's about. Add a staff member's personal WhatsApp number below.
        </p>
      ) : null}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="space-y-1.5">
            <Label htmlFor={`handoff-phone-${i}`}>Staff WhatsApp {i + 1}{i === 1 ? " (optional)" : ""}</Label>
            <Input
              id={`handoff-phone-${i}`}
              inputMode="tel"
              placeholder="+91 98765 43210"
              disabled={!canConfigure}
              value={phones[i]}
              onChange={(e) => setPhones((p) => (i === 0 ? [e.target.value, p[1]] : [p[0], e.target.value]))}
            />
          </div>
        ))}
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="handoff-email">Email (used when WhatsApp can't reach them)</Label>
          <Input
            id="handoff-email"
            type="email"
            placeholder="team@yourshop.in"
            disabled={!canConfigure}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Alerts go from the AiDwar number as an approved WhatsApp message, any time of day — your staff don't
        need to have messaged it first. The email is used only if WhatsApp can't reach anyone.
      </p>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {canConfigure ? (
        <div className="mt-4">
          <Button size="sm" disabled={saving} onClick={() => void save()}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save
          </Button>
        </div>
      ) : null}
    </section>
  );
}
