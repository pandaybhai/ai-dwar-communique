import { useCallback, useEffect, useState } from "react";
import { Check, ExternalLink, Loader2, Sparkles, Wallet } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { usePermissions } from "@/hooks/use-permissions";
import { money, withGst } from "@/lib/billing";
import { callApi } from "@/lib/whatsapp-client";
import { cn } from "@/lib/utils";

type Plan = {
  key: string;
  name: string;
  tagline: string | null;
  plan_version_id: string;
  price_monthly: number | null;
  price_annual: number | null;
  currency: string;
  limits: Record<string, unknown>;
  highlights: string[];
};

export type PlanState = {
  plan_status: string;
  plan_version_id: string | null;
  trial_ends_at: string | null;
  current_plan: { key: string; name: string } | null;
  suggested_plan: string | null;
  default_whatsapp: string | null;
  gstin: string | null;
  pending_payment: { id: string; url: string | null; plan_key: string | null } | null;
  plans: Plan[];
};

const LIMIT_COPY: Record<string, string> = {
  contacts: "contacts",
  messages_monthly: "messages a month",
  ai_answers_monthly: "AI answers a month",
  team_members: "team members",
  whatsapp_numbers: "numbers",
  knowledge_pages: "website pages read",
};

function limitLines(limits: Record<string, unknown>): string[] {
  return Object.entries(limits)
    .filter(([key, value]) => key in LIMIT_COPY && (typeof value === "number" || value === null))
    .slice(0, 4)
    .map(([key, value]) =>
      value === null ? `Unlimited ${LIMIT_COPY[key]}` : `${Number(value).toLocaleString("en-IN")} ${LIMIT_COPY[key]}`,
    );
}

/**
 * The plan picker for a workspace on trial or locked. Pays the first month's
 * fee through a hosted payment link; activation lands through the webhook.
 */
export function PlanChooser({
  organizationId,
  mode,
  onActivated,
}: {
  organizationId: string;
  mode: "trial" | "locked" | "reactivate";
  onActivated?: () => void;
}) {
  const { can } = usePermissions();
  const [state, setState] = useState<PlanState | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [selected, setSelected] = useState<Plan | null>(null);
  const [gstin, setGstin] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await callApi<PlanState>(
      `/api/billing/plan?organization_id=${organizationId}`,
      { method: "GET" },
    );
    if (error || !data) {
      setFailed(error ?? "We couldn't load the plans just now.");
      return;
    }
    setFailed(null);
    setState(data);
    setGstin((g) => g || data.gstin || "");
    setWhatsapp((w) => w || data.default_whatsapp || "");
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Back from the payment page: poll until the webhook has switched the plan on.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has("payment")) return;
    let tries = 0;
    const timer = window.setInterval(async () => {
      tries += 1;
      const { data } = await callApi<PlanState>(
        `/api/billing/plan?organization_id=${organizationId}`,
        { method: "GET" },
      );
      if (data?.plan_status === "active" && data.plan_version_id) {
        window.clearInterval(timer);
        toast.success("Your plan is live. Welcome aboard!");
        onActivated?.();
        return;
      }
      if (tries >= 10) window.clearInterval(timer);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [organizationId, onActivated]);

  async function pay() {
    if (!selected) return;
    setBusy(true);
    const { data, error } = await callApi<{ url: string }>("/api/billing/plan", {
      body: {
        organization_id: organizationId,
        plan_key: selected.key,
        gstin: gstin.trim() || null,
        billing_whatsapp: whatsapp.trim() || null,
      },
    });
    setBusy(false);
    if (error || !data?.url) {
      toast.error(error ?? "We couldn't start the payment.");
      return;
    }
    window.location.assign(data.url);
  }

  if (failed) {
    return (
      <EmptyState
        icon={Wallet}
        title="We couldn't load the plans"
        description={failed}
        action={<Button onClick={() => void load()}>Try again</Button>}
      />
    );
  }

  if (!state) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-80 rounded-2xl" />
        ))}
      </div>
    );
  }

  const canPay = can("billing.pay");
  const daysLeft = state.trial_ends_at
    ? Math.max(0, Math.ceil((new Date(state.trial_ends_at).getTime() - Date.now()) / 864e5))
    : null;

  const heading =
    mode === "locked" || mode === "reactivate"
      ? "Reactivate your workspace"
      : "Choose your plan";
  const sub =
    mode === "locked" || mode === "reactivate"
      ? "Pay the first month and everything switches back on within a minute — nothing has been deleted."
      : daysLeft !== null
        ? `${daysLeft} day${daysLeft === 1 ? "" : "s"} left in your free trial. Pick a plan whenever you're ready — your credits and everything I've learned carry over.`
        : "Every plan starts with the same AI employee. Pick the size that fits.";

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-foreground">{heading}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{sub}</p>
      </div>

      {state.pending_payment?.url ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-primary/30 bg-primary/5 px-5 py-4 text-sm">
          <span>
            You started paying for <span className="font-semibold capitalize">{state.pending_payment.plan_key}</span>{" "}
            but didn't finish. The link is still open.
          </span>
          <Button asChild size="sm" className="rounded-full">
            <a href={state.pending_payment.url}>
              Finish payment <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
            </a>
          </Button>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {state.plans.map((plan) => {
          const custom = plan.price_monthly === null || plan.price_monthly <= 0;
          const suggested = state.suggested_plan === plan.key;
          const current = state.current_plan?.key === plan.key;
          return (
            <Card
              key={plan.key}
              className={cn(
                "flex flex-col rounded-2xl transition-shadow duration-200",
                suggested ? "border-primary shadow-lg shadow-primary/10" : "hover:shadow-md",
              )}
            >
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-lg">{plan.name}</CardTitle>
                  {suggested ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                      <Sparkles className="h-3 w-3" /> Your pick
                    </span>
                  ) : current ? (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                      Current
                    </span>
                  ) : null}
                </div>
                {plan.tagline ? (
                  <p className="text-sm text-muted-foreground">{plan.tagline}</p>
                ) : null}
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-4">
                <div>
                  {custom ? (
                    <p className="text-2xl font-bold">Custom</p>
                  ) : (
                    <>
                      <p className="text-2xl font-bold">
                        {money(plan.price_monthly, plan.currency)}
                        <span className="text-sm font-normal text-muted-foreground"> / month</span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        + 18% GST
                        {plan.price_annual
                          ? ` · ${money(plan.price_annual, plan.currency)} a year`
                          : ""}
                      </p>
                    </>
                  )}
                </div>
                <ul className="space-y-1.5 text-sm">
                  {[...limitLines(plan.limits), ...plan.highlights.slice(0, 4)].map((line) => (
                    <li key={line} className="flex items-start gap-2">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-auto pt-2">
                  {custom ? (
                    <Button asChild variant="outline" className="w-full rounded-full">
                      <a href="mailto:hello@aidwar.in?subject=Enterprise%20plan">Talk to us</a>
                    </Button>
                  ) : canPay ? (
                    <Button
                      className="w-full rounded-full"
                      variant={suggested ? "default" : "outline"}
                      onClick={() => setSelected(plan)}
                    >
                      {mode === "trial" ? "Choose plan" : "Reactivate"}
                    </Button>
                  ) : (
                    <p className="text-center text-xs text-muted-foreground">
                      Ask the workspace owner to choose a plan.
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Dialog open={selected !== null} onOpenChange={(o) => !o && !busy && setSelected(null)}>
        <DialogContent className="rounded-2xl sm:max-w-md">
          {selected ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {selected.name} — {money(selected.price_monthly, selected.currency)} a month
                </DialogTitle>
                <DialogDescription>
                  You pay the first month now. Auto-pay is optional and can be set up afterwards.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="gstin">GSTIN (optional)</Label>
                  <Input
                    id="gstin"
                    value={gstin}
                    onChange={(e) => setGstin(e.target.value.toUpperCase())}
                    placeholder="27AAAAA0000A1Z5"
                    maxLength={15}
                  />
                  <p className="text-xs text-muted-foreground">
                    Goes on your tax invoice so you can claim the GST back.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="bill-wa">Billing WhatsApp</Label>
                  <Input
                    id="bill-wa"
                    value={whatsapp}
                    onChange={(e) => setWhatsapp(e.target.value)}
                    placeholder="+91 98765 43210"
                  />
                  <p className="text-xs text-muted-foreground">
                    Where receipts and low-credit notes are sent.
                  </p>
                </div>
                <PriceBreakdown amount={selected.price_monthly ?? 0} currency={selected.currency} />
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setSelected(null)} disabled={busy}>
                  Back
                </Button>
                <Button onClick={pay} disabled={busy} className="rounded-full">
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Pay {money(withGst(selected.price_monthly ?? 0).total, selected.currency)}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PriceBreakdown({ amount, currency }: { amount: number; currency: string }) {
  const { base, gst, total } = withGst(amount);
  return (
    <div className="rounded-xl bg-muted/60 p-3 text-sm">
      <div className="flex justify-between">
        <span>First month</span>
        <span>{money(base, currency)}</span>
      </div>
      <div className="flex justify-between text-muted-foreground">
        <span>GST 18%</span>
        <span>{money(gst, currency)}</span>
      </div>
      <div className="mt-2 flex justify-between border-t border-border pt-2 font-semibold">
        <span>Total today</span>
        <span>{money(total, currency)}</span>
      </div>
    </div>
  );
}
