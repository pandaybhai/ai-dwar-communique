import { useCallback, useEffect, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { callApi } from "@/lib/whatsapp-client";
import { FEATURES } from "@/lib/feature-registry";
import { MESSAGE_CATEGORIES, money, rateMoney, ledgerLabel } from "@/lib/billing";

type AnyRow = Record<string, unknown>;

type OrgBilling = {
  summary: AnyRow;
  settings: AnyRow | null;
  rate_cards: AnyRow[];
  ledger: AnyRow[];
  overrides: { flag_key: string; enabled: boolean }[];
  meta_rates: AnyRow[];
  plans: AnyRow[];
  recommendation: { plan_key: string | null; reason: string };
  organization: AnyRow | null;
  billing_account: AnyRow | null;
  billing_accounts: AnyRow[];
  bsp_accounts: AnyRow[];
  packs: AnyRow[];
  payments: AnyRow[];
};

const SETTINGS_FIELDS: { key: string; label: string; type: "number" | "text" | "switch" }[] = [
  { key: "plan_fee_override", label: "Plan fee override", type: "number" },
  { key: "starter_credits", label: "Starter credits", type: "number" },
  { key: "meta_float_target", label: "Meta float target", type: "number" },
  { key: "overdraft_limit", label: "Overdraft allowed", type: "number" },
  { key: "low_credit_threshold", label: "Warn below", type: "number" },
  { key: "auto_topup_enabled", label: "Auto top-up", type: "switch" },
  { key: "auto_topup_threshold", label: "Auto top-up below", type: "number" },
  { key: "auto_topup_pack_id", label: "Auto top-up pack", type: "text" },
  { key: "monthly_budget_cap", label: "Monthly budget cap", type: "number" },
  { key: "campaign_approval_threshold", label: "Campaign needs approval above", type: "number" },
  { key: "ai_answers_included_override", label: "AI answers included", type: "number" },
  { key: "credits_expire_months", label: "Credits expire after (months)", type: "number" },
  { key: "notes", label: "Notes", type: "text" },
];

const FUNDING_MODELS = [
  { value: "meta_direct", label: "Client pays Meta directly" },
  { value: "aidwar_prepaid", label: "We fund Meta for them" },
  { value: "bsp", label: "Through a partner (BSP)" },
];

const STATE_CODES = [
  "27 Maharashtra",
  "07 Delhi",
  "29 Karnataka",
  "33 Tamil Nadu",
  "24 Gujarat",
  "36 Telangana",
  "19 West Bengal",
  "09 Uttar Pradesh",
  "08 Rajasthan",
  "32 Kerala",
];

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      <div className="mt-4 space-y-4">{children}</div>
    </div>
  );
}

export function OrgBillingSheet({
  organizationId,
  organizationName,
  open,
  onClose,
}: {
  organizationId: string;
  organizationName: string;
  open: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<OrgBilling | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [planKey, setPlanKey] = useState("");
  const [planStatus, setPlanStatus] = useState("active");
  const [account, setAccount] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<Record<string, string | boolean>>({});
  const [funding, setFunding] = useState("meta_direct");
  const [rateDraft, setRateDraft] = useState<Record<string, { mode: string; value: string }>>({});
  const [walletAmount, setWalletAmount] = useState("");
  const [walletReason, setWalletReason] = useState("");
  const [impact, setImpact] = useState<{ featureKey: string; lines: string[] } | null>(null);

  const load = useCallback(async () => {
    setData(null);
    const result = await callApi<OrgBilling>("/api/admin/billing", {
      body: { action: "org", organization_id: organizationId },
    });
    if (result.error || !result.data) {
      toast.error(result.error ?? "We couldn't load this workspace's billing.");
      return;
    }
    const d = result.data;
    setData(d);
    setPlanKey(String((d.summary["plan"] as AnyRow | undefined)?.["key"] ?? d.recommendation.plan_key ?? ""));
    setPlanStatus(String((d.organization?.["plan_status"] as string) ?? "active"));
    setFunding(String((d.organization?.["funding_model"] as string) ?? "meta_direct"));
    const acc: Record<string, string> = {};
    for (const [k, v] of Object.entries(d.billing_account ?? {})) {
      if (typeof v === "string") acc[k] = v;
    }
    setAccount(acc);
    const s: Record<string, string | boolean> = {};
    for (const field of SETTINGS_FIELDS) {
      const value = d.settings?.[field.key];
      s[field.key] =
        field.type === "switch" ? value === true : value === null || value === undefined ? "" : String(value);
    }
    setSettings(s);
  }, [organizationId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function act(action: string, body: Record<string, unknown>, id: string, done = "Saved.") {
    setBusy(id);
    const result = await callApi<{ ok?: boolean; error?: string }>("/api/admin/billing", {
      body: { action, organization_id: organizationId, ...body },
    });
    setBusy(null);
    if (result.error || result.data?.error) {
      toast.error(result.error ?? result.data?.error ?? "That didn't work.");
      return false;
    }
    toast.success(done);
    await load();
    return true;
  }

  const effective = (key: string): boolean => {
    const override = data?.overrides.find((o) => o.flag_key === key);
    if (override) return override.enabled;
    return false;
  };

  async function toggleFeature(featureKey: string, enabled: boolean) {
    if (!enabled) {
      setBusy(featureKey);
      const result = await callApi<{ dependents?: string[]; live?: Record<string, number> }>(
        "/api/admin/billing",
        { body: { action: "feature_impact", organization_id: organizationId, feature_key: featureKey } },
      );
      setBusy(null);
      const dependents = result.data?.dependents ?? [];
      const live = result.data?.live ?? {};
      const lines = [
        ...dependents.map((d) => `${d} will be switched off too`),
        ...Object.entries(live)
          .filter(([, count]) => Number(count) > 0)
          .map(([label, count]) => `${count} ${label.replace(/_/g, " ")} will stop`),
      ];
      if (lines.length > 0) {
        setImpact({ featureKey, lines });
        return;
      }
    }
    await act("set_feature", { feature_key: featureKey, enabled }, featureKey, "Feature updated.");
  }

  const metaRateFor = (category: string): number | null => {
    const row = (data?.meta_rates ?? []).find(
      (r) => r["category"] === category && (r["country_code"] ?? "IN") === "IN",
    );
    return row ? Number(row["rate"]) : null;
  };

  const currentCard = (category: string): AnyRow | null =>
    (data?.rate_cards ?? []).find(
      (r) => r["category"] === category && r["organization_id"] === organizationId,
    ) ?? null;

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>Billing · {organizationName}</SheetTitle>
          <SheetDescription>
            Plan, features, paperwork, rates and wallet for this workspace.
          </SheetDescription>
        </SheetHeader>

        {!data ? (
          <div className="mt-6 space-y-4">
            <Skeleton className="h-10 w-full rounded-xl" />
            <Skeleton className="h-40 w-full rounded-2xl" />
            <Skeleton className="h-40 w-full rounded-2xl" />
          </div>
        ) : (
          <Tabs defaultValue="plan" className="mt-6">
            <TabsList className="flex w-full flex-wrap">
              <TabsTrigger value="plan">Plan</TabsTrigger>
              <TabsTrigger value="features">Features</TabsTrigger>
              <TabsTrigger value="account">Account</TabsTrigger>
              <TabsTrigger value="rates">Rates</TabsTrigger>
              <TabsTrigger value="settings">Settings</TabsTrigger>
              <TabsTrigger value="wallet">Wallet</TabsTrigger>
              <TabsTrigger value="ledger">Ledger</TabsTrigger>
            </TabsList>

            {/* a) Plan */}
            <TabsContent value="plan" className="mt-4 space-y-4">
              <Section title="Plan" description="What this workspace pays for every month.">
                <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
                  <p className="flex items-center gap-2 text-sm font-medium text-primary">
                    <Sparkles className="h-4 w-4" />
                    {data.recommendation.plan_key
                      ? `We'd put them on ${data.recommendation.plan_key}`
                      : "No plan fits them yet"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{data.recommendation.reason}</p>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Plan">
                    <select
                      value={planKey}
                      onChange={(e) => setPlanKey(e.target.value)}
                      className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
                    >
                      <option value="">Choose a plan</option>
                      {data.plans.map((p) => {
                        const plan = (p["plans"] ?? {}) as AnyRow;
                        return (
                          <option key={String(plan["key"])} value={String(plan["key"])}>
                            {String(plan["name"])} · {money(Number(p["price_monthly"] ?? 0))}/mo
                          </option>
                        );
                      })}
                    </select>
                  </Field>
                  <Field label="Status">
                    <select
                      value={planStatus}
                      onChange={(e) => setPlanStatus(e.target.value)}
                      className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
                    >
                      <option value="active">Active</option>
                      <option value="trialing">Trial</option>
                      <option value="past_due">Past due</option>
                      <option value="cancelled">Cancelled</option>
                    </select>
                  </Field>
                </div>

                <Button
                  disabled={!planKey || busy === "plan"}
                  onClick={() => void act("assign_plan", { plan_key: planKey, status: planStatus }, "plan", "Plan assigned.")}
                >
                  {busy === "plan" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Assign plan
                </Button>
              </Section>
            </TabsContent>

            {/* b) Features */}
            <TabsContent value="features" className="mt-4 space-y-4">
              <Section title="Features" description="Anything switched off disappears cleanly from their workspace.">
                <div className="divide-y divide-border/60">
                  {FEATURES.map((feature) => {
                    const on = effective(feature.key);
                    const override = data.overrides.find((o) => o.flag_key === feature.key);
                    return (
                      <div key={feature.key} className="flex items-center justify-between gap-4 py-3">
                        <div>
                          <p className="text-sm font-medium text-foreground">{feature.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {override ? "Set by hand — differs from the plan" : "Following the plan"}
                          </p>
                        </div>
                        <Switch
                          checked={on}
                          disabled={busy === feature.key}
                          onCheckedChange={(v) => void toggleFeature(feature.key, v)}
                        />
                      </div>
                    );
                  })}
                </div>
              </Section>
            </TabsContent>

            {/* c) Billing account */}
            <TabsContent value="account" className="mt-4 space-y-4">
              <Section title="Billing account" description="Who the invoice is made out to.">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Name">
                    <Input value={account["name"] ?? ""} onChange={(e) => setAccount((p) => ({ ...p, name: e.target.value }))} />
                  </Field>
                  <Field label="Legal name">
                    <Input value={account["legal_name"] ?? ""} onChange={(e) => setAccount((p) => ({ ...p, legal_name: e.target.value }))} />
                  </Field>
                  <Field label="GSTIN" hint="15 characters, like 27AAAAA0000A1Z5">
                    <Input
                      value={account["gstin"] ?? ""}
                      onChange={(e) => setAccount((p) => ({ ...p, gstin: e.target.value.toUpperCase() }))}
                    />
                  </Field>
                  <Field label="State">
                    <select
                      value={account["state_code"] ?? ""}
                      onChange={(e) => setAccount((p) => ({ ...p, state_code: e.target.value }))}
                      className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
                    >
                      <option value="">Choose a state</option>
                      {STATE_CODES.map((s) => (
                        <option key={s} value={s.slice(0, 2)}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Country">
                    <Input value={account["country"] ?? "IN"} onChange={(e) => setAccount((p) => ({ ...p, country: e.target.value }))} />
                  </Field>
                  <Field label="Currency">
                    <Input value={account["currency"] ?? "INR"} onChange={(e) => setAccount((p) => ({ ...p, currency: e.target.value }))} />
                  </Field>
                  <Field label="Billing email">
                    <Input value={account["billing_email"] ?? ""} onChange={(e) => setAccount((p) => ({ ...p, billing_email: e.target.value }))} />
                  </Field>
                  <Field label="Billing number" hint="Where money notices go">
                    <Input value={account["billing_whatsapp"] ?? ""} onChange={(e) => setAccount((p) => ({ ...p, billing_whatsapp: e.target.value }))} />
                  </Field>
                </div>
                <Field label="Address">
                  <Textarea
                    rows={3}
                    value={account["address"] ?? ""}
                    onChange={(e) => setAccount((p) => ({ ...p, address: e.target.value }))}
                  />
                </Field>
                <div className="flex items-center justify-between rounded-xl border border-border/70 px-4 py-3">
                  <span className="text-sm text-foreground">TDS applicable</span>
                  <Switch
                    checked={account["tds_applicable"] === "true"}
                    onCheckedChange={(v) => setAccount((p) => ({ ...p, tds_applicable: v ? "true" : "false" }))}
                  />
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={busy === "account"}
                    onClick={() =>
                      void act(
                        "save_billing_account",
                        {
                          account_id: data.billing_account?.["id"] ?? null,
                          account: { ...account, tds_applicable: account["tds_applicable"] === "true" },
                        },
                        "account",
                        "Billing account saved.",
                      )
                    }
                  >
                    {busy === "account" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    Save account
                  </Button>
                  {data.billing_accounts.length > 0 ? (
                    <select
                      onChange={(e) =>
                        e.target.value &&
                        void act("link_billing_account", { account_id: e.target.value }, "link", "Linked.")
                      }
                      defaultValue=""
                      className="h-10 rounded-lg border border-input bg-background px-3 text-sm"
                    >
                      <option value="">Link an existing account…</option>
                      {data.billing_accounts.map((a) => (
                        <option key={String(a["id"])} value={String(a["id"])}>
                          {String(a["name"])}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </div>
              </Section>
            </TabsContent>

            {/* d) Rates */}
            <TabsContent value="rates" className="mt-4 space-y-4">
              <Section title="Rates · India" description="What we pay Meta, and what this workspace pays us.">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b border-border/70">
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="py-2">Category</th>
                        <th className="py-2">Meta rate</th>
                        <th className="py-2">Mode</th>
                        <th className="py-2">Value</th>
                        <th className="py-2">Client pays</th>
                        <th className="py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {MESSAGE_CATEGORIES.map((category) => {
                        const card = currentCard(category);
                        const draft = rateDraft[category] ?? {
                          mode: String(card?.["mode"] ?? "markup"),
                          value: String(
                            card?.["mode"] === "fixed"
                              ? (card?.["fixed_rate"] ?? "")
                              : (card?.["markup_percent"] ?? ""),
                          ),
                        };
                        const meta = metaRateFor(category);
                        const computed =
                          draft.mode === "fixed"
                            ? draft.value === ""
                              ? null
                              : Number(draft.value)
                            : meta === null || draft.value === ""
                              ? null
                              : meta * (1 + Number(draft.value) / 100);
                        return (
                          <tr key={category} className="border-b border-border/50 last:border-0">
                            <td className="py-2 capitalize">{category}</td>
                            <td className="py-2 text-muted-foreground">{rateMoney(meta)}</td>
                            <td className="py-2">
                              <select
                                value={draft.mode}
                                onChange={(e) =>
                                  setRateDraft((p) => ({ ...p, [category]: { ...draft, mode: e.target.value } }))
                                }
                                className="h-9 rounded-lg border border-input bg-background px-2 text-sm"
                              >
                                <option value="markup">Markup %</option>
                                <option value="fixed">Fixed</option>
                              </select>
                            </td>
                            <td className="py-2">
                              <Input
                                className="h-9 w-24"
                                inputMode="decimal"
                                value={draft.value}
                                onChange={(e) =>
                                  setRateDraft((p) => ({ ...p, [category]: { ...draft, value: e.target.value } }))
                                }
                              />
                            </td>
                            <td className="py-2 font-medium">{rateMoney(computed)}</td>
                            <td className="py-2">
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy === `rate_${category}`}
                                onClick={() =>
                                  void act(
                                    "save_rate",
                                    {
                                      country_code: "IN",
                                      category,
                                      mode: draft.mode,
                                      markup_percent: draft.mode === "markup" ? Number(draft.value || 0) : null,
                                      fixed_rate: draft.mode === "fixed" ? Number(draft.value || 0) : null,
                                      effective_from: new Date().toISOString().slice(0, 10),
                                    },
                                    `rate_${category}`,
                                    "New rate saved.",
                                  )
                                }
                              >
                                Save
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-muted-foreground">
                  Saving adds a new rate from today. Old rates stay on the record.
                </p>
              </Section>
            </TabsContent>

            {/* e) Settings */}
            <TabsContent value="settings" className="mt-4 space-y-4">
              <Section title="Money settings" description="Thresholds, caps and how Meta gets paid.">
                <Field label="Funding">
                  <select
                    value={funding}
                    onChange={(e) => setFunding(e.target.value)}
                    className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
                  >
                    {FUNDING_MODELS.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </Field>

                <div className="grid gap-4 sm:grid-cols-2">
                  {SETTINGS_FIELDS.map((field) =>
                    field.type === "switch" ? (
                      <div
                        key={field.key}
                        className="flex items-center justify-between rounded-xl border border-border/70 px-4 py-3"
                      >
                        <span className="text-sm text-foreground">{field.label}</span>
                        <Switch
                          checked={settings[field.key] === true}
                          onCheckedChange={(v) => setSettings((p) => ({ ...p, [field.key]: v }))}
                        />
                      </div>
                    ) : (
                      <Field key={field.key} label={field.label}>
                        <Input
                          inputMode={field.type === "number" ? "decimal" : "text"}
                          value={String(settings[field.key] ?? "")}
                          onChange={(e) => setSettings((p) => ({ ...p, [field.key]: e.target.value }))}
                        />
                      </Field>
                    ),
                  )}
                </div>

                <Button
                  disabled={busy === "settings"}
                  onClick={() =>
                    void act(
                      "save_settings",
                      { settings, funding_model: funding },
                      "settings",
                      "Settings saved.",
                    )
                  }
                >
                  {busy === "settings" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Save settings
                </Button>
              </Section>
            </TabsContent>

            {/* f) Wallet */}
            <TabsContent value="wallet" className="mt-4 space-y-4">
              <Section title="Wallet" description="Their balance, and how to correct it by hand.">
                <div className="grid grid-cols-3 gap-3">
                  {[
                    ["Balance", Number((data.summary["wallet"] as AnyRow | undefined)?.["balance"] ?? 0)],
                    ["Held", Number((data.summary["wallet"] as AnyRow | undefined)?.["held"] ?? 0)],
                    ["Available", Number((data.summary["wallet"] as AnyRow | undefined)?.["available"] ?? 0)],
                  ].map(([label, value]) => (
                    <div key={String(label)} className="rounded-xl border border-border/70 p-4">
                      <p className="text-xs text-muted-foreground">{label}</p>
                      <p className="mt-1 text-lg font-semibold text-foreground">{money(Number(value))}</p>
                    </div>
                  ))}
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Amount">
                    <Input inputMode="decimal" value={walletAmount} onChange={(e) => setWalletAmount(e.target.value)} />
                  </Field>
                  <Field label="Reason" hint="Required — it lands on the record.">
                    <Input value={walletReason} onChange={(e) => setWalletReason(e.target.value)} />
                  </Field>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={busy === "add_credits"}
                    onClick={() =>
                      void act(
                        "add_credits",
                        { amount: Number(walletAmount || 0), method: "bank_transfer", reason: walletReason },
                        "add_credits",
                        "Credits added.",
                      )
                    }
                  >
                    Add credits manually
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy === "adjustment"}
                    onClick={() =>
                      void act(
                        "adjustment",
                        { amount: Number(walletAmount || 0), reason: walletReason },
                        "adjustment",
                        "Adjustment recorded.",
                      )
                    }
                  >
                    Adjustment (+/−)
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy === "float"}
                    onClick={() =>
                      void act(
                        "onboarding_float",
                        { amount: Number(walletAmount || 0) },
                        "float",
                        "Onboarding float recorded.",
                      )
                    }
                  >
                    Record onboarding float
                  </Button>
                </div>
              </Section>
            </TabsContent>

            {/* g) Ledger + payments */}
            <TabsContent value="ledger" className="mt-4 space-y-4">
              <Section title="Ledger" description="Every credit and debit, newest first.">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b border-border/70 text-left text-xs text-muted-foreground">
                      <tr>
                        <th className="py-2">When</th>
                        <th className="py-2">What</th>
                        <th className="py-2">Amount</th>
                        <th className="py-2">Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.ledger.map((entry) => (
                        <tr key={String(entry["id"])} className="border-b border-border/50 last:border-0">
                          <td className="py-2 text-xs text-muted-foreground">
                            {new Date(String(entry["created_at"])).toLocaleString("en-IN")}
                          </td>
                          <td className="py-2">{ledgerLabel(String(entry["entry_type"]))}</td>
                          <td className="py-2">{money(Number(entry["amount"] ?? 0))}</td>
                          <td className="py-2 text-muted-foreground">
                            {money(Number(entry["balance_after"] ?? 0))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>

              <Section title="Payments" description="What they've paid us, and how.">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b border-border/70 text-left text-xs text-muted-foreground">
                      <tr>
                        <th className="py-2">When</th>
                        <th className="py-2">Provider</th>
                        <th className="py-2">Status</th>
                        <th className="py-2">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.payments.map((p) => (
                        <tr key={String(p["id"])} className="border-b border-border/50 last:border-0">
                          <td className="py-2 text-xs text-muted-foreground">
                            {new Date(String(p["created_at"])).toLocaleString("en-IN")}
                          </td>
                          <td className="py-2">{String(p["provider"] ?? "—")}</td>
                          <td className="py-2">{String(p["status"] ?? "—")}</td>
                          <td className="py-2">{money(Number(p["amount"] ?? 0))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>
            </TabsContent>
          </Tabs>
        )}

        <AlertDialog open={impact !== null} onOpenChange={(v) => !v && setImpact(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Switch this off?</AlertDialogTitle>
              <AlertDialogDescription>
                Here's what happens to {organizationName} the moment you do:
              </AlertDialogDescription>
            </AlertDialogHeader>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {(impact?.lines ?? []).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep it on</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  const key = impact?.featureKey;
                  setImpact(null);
                  if (key) {
                    void act("set_feature", { feature_key: key, enabled: false, force: true }, key, "Feature switched off.");
                  }
                }}
              >
                Switch it off
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  );
}
