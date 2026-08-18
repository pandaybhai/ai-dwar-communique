import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Bot, KeyRound, Loader2, Save, WalletCards } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, ErrorState, PageHeader, PageSkeleton } from "@/components/empty-state";
import { callApi } from "@/lib/whatsapp-client";

export const Route = createFileRoute("/admin/ai")({
  head: () => ({
    meta: [
      { title: "AI Operations — AiDwar Admin" },
      { name: "description", content: "Manage platform AI providers, pricing, and merchant tiers." },
      { property: "og:title", content: "AI Operations — AiDwar Admin" },
      { property: "og:description", content: "Manage platform AI providers, pricing, and merchant tiers." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminAi,
});

type Provider = {
  provider: string;
  has_key: boolean;
  is_active: boolean;
  last_error: string | null;
  updated_at: string;
};
type Tier = { key: string; display_name: string; provider: string; model_id: string; is_active: boolean };
type Model = {
  provider: string;
  model_id: string;
  display_name: string;
  supports_tools: boolean;
  is_available: boolean;
  is_deprecated: boolean;
};
type Overview = {
  markup: number;
  providers: Provider[];
  tiers: Tier[];
  models: Model[];
  totals: { cost: number; billed: number; margin: number; runs: number };
};

function money(value: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(value);
}

function AdminAi() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [markup, setMarkup] = useState("3");
  const [keys, setKeys] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setError(null);
    const result = await callApi<Overview>("/api/admin/ai", { body: { action: "overview" } });
    if (result.error || !result.data) {
      setError(result.error ?? "AI operations could not be loaded.");
      return;
    }
    setData(result.data);
    setMarkup(String(result.data.markup));
  }, []);

  useEffect(() => void load(), [load]);

  async function act(action: string, body: Record<string, unknown>, id: string) {
    setBusy(id);
    setError(null);
    const result = await callApi<{ ok: boolean }>("/api/admin/ai", { body: { action, ...body } });
    setBusy(null);
    if (result.error) {
      setError(result.error);
      return false;
    }
    await load();
    return true;
  }

  if (!data && !error) return <PageSkeleton />;
  if (!data) return <ErrorState message={error ?? "AI operations could not be loaded."} onRetry={load} />;

  return (
    <div className="space-y-8">
      <PageHeader title="AI operations" description="The provider truth, cost basis, merchant pricing, and tier mapping live here." />
      {error ? <ErrorState message={error} /> : null}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Provider cost", money(data.totals.cost)],
          ["Billed revenue", money(data.totals.billed)],
          ["Margin", money(data.totals.margin)],
          ["Runs · 30 days", String(data.totals.runs)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-border/70 bg-card p-5 shadow-sm">
            <p className="text-xs font-semibold uppercase text-muted-foreground">{label}</p>
            <p className="mt-2 text-2xl font-bold text-foreground">{value}</p>
          </div>
        ))}
      </section>

      <section className="rounded-xl border border-border/70 bg-card p-5 shadow-sm">
        <div className="flex items-start gap-3">
          <WalletCards className="mt-0.5 h-5 w-5 text-primary" />
          <div className="flex-1">
            <h2 className="font-semibold">Platform markup</h2>
            <p className="mt-1 text-sm text-muted-foreground">Billed amount equals provider cost multiplied by this value unless an organization has a negotiated override.</p>
            <div className="mt-4 flex max-w-sm items-end gap-3">
              <div className="flex-1 space-y-2">
                <Label htmlFor="markup">Multiplier</Label>
                <Input id="markup" type="number" min="1" step="0.1" value={markup} onChange={(event) => setMarkup(event.target.value)} />
              </div>
              <Button disabled={busy === "markup"} onClick={() => act("set_markup", { multiplier: Number(markup) }, "markup")}>
                {busy === "markup" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}Save
              </Button>
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Platform providers</h2>
          <p className="text-sm text-muted-foreground">Keys are written directly to the secure vault and are never returned to this screen.</p>
        </div>
        {data.providers.length === 0 ? (
          <EmptyState icon={KeyRound} title="No providers registered" description="Apply the provider registry before accepting AI traffic." />
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {data.providers.map((provider) => (
              <div key={provider.provider} className="rounded-xl border border-border/70 bg-card p-5 shadow-sm">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h3 className="font-semibold capitalize">{provider.provider}</h3>
                    <p className="text-sm text-muted-foreground">{provider.has_key || provider.provider === "lovable" ? "Connected" : "No key stored"}</p>
                  </div>
                  <Switch checked={provider.is_active} disabled={busy === `active:${provider.provider}`} onCheckedChange={(enabled) => act("set_provider_active", { provider: provider.provider, enabled }, `active:${provider.provider}`)} />
                </div>
                {provider.provider !== "lovable" ? (
                  <div className="mt-4 flex gap-2">
                    <Input type="password" autoComplete="new-password" value={keys[provider.provider] ?? ""} onChange={(event) => setKeys((current) => ({ ...current, [provider.provider]: event.target.value }))} placeholder={provider.has_key ? "Replace stored key" : "Add provider key"} aria-label={`${provider.provider} API key`} />
                    <Button variant="outline" disabled={busy === `key:${provider.provider}`} onClick={async () => {
                      const saved = await act("set_provider_key", { provider: provider.provider, key: keys[provider.provider] ?? "" }, `key:${provider.provider}`);
                      if (saved) setKeys((current) => ({ ...current, [provider.provider]: "" }));
                    }}><KeyRound className="mr-2 h-4 w-4" />Store</Button>
                  </div>
                ) : null}
                {provider.last_error ? <p className="mt-3 text-sm text-destructive">{provider.last_error}</p> : null}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Merchant tier mapping</h2>
          <p className="text-sm text-muted-foreground">Merchants see only the tier name; the real provider and model remain visible here.</p>
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          {data.tiers.map((tier) => {
            const value = `${tier.provider}::${tier.model_id}`;
            return (
              <div key={tier.key} className="rounded-xl border border-border/70 bg-card p-5 shadow-sm">
                <div className="mb-4 flex items-center gap-3"><Bot className="h-5 w-5 text-primary" /><h3 className="font-semibold">{tier.display_name}</h3></div>
                <Select value={value} onValueChange={(next) => {
                  const separator = next.indexOf("::");
                  void act("set_tier_model", { tier: tier.key, provider: next.slice(0, separator), model_id: next.slice(separator + 2) }, `tier:${tier.key}`);
                }} disabled={busy === `tier:${tier.key}`}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {data.models.filter((model) => model.is_available && !model.is_deprecated).map((model) => (
                      <SelectItem key={`${model.provider}:${model.model_id}`} value={`${model.provider}::${model.model_id}`}>
                        {model.display_name} · {model.provider}/{model.model_id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}