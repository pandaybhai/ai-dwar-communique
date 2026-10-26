import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Bot, CheckCircle2, Gauge, KeyRound, LifeBuoy, Loader2, Save, WalletCards, XCircle } from "lucide-react";
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
type BackupStatus = {
  order: string[];
  anthropic: {
    configured: boolean;
    model: string;
    key_source?: "vault" | "env" | null;
    chosen_model?: string | null;
    env_override?: boolean;
    models?: Array<{ id: string; label: string }>;
  };
  openai: { configured: boolean; model: string; careful_model: string; key_source?: "vault" | "env" | null };
};
type BackupResult = {
  provider: string;
  model: string;
  ok: boolean;
  seconds: number;
  reason: string | null;
  error: string | null;
};
type SpeedWindow = { replies: number; p50_ms: number | null; p90_ms: number | null; slowest_ms: number | null; over_slow: number };
type ReplySpeed = {
  slow_ms: number;
  error: string | null;
  workspaces: Array<{ organization_id: string; name: string | null; last_24h: SpeedWindow; last_7d: SpeedWindow }>;
  slow: Array<{
    run_id: string;
    organization_id: string;
    name: string | null;
    conversation_id: string | null;
    at: string;
    ms: number;
    reason: string | null;
    pickup: string | null;
  }>;
};
type Overview = {
  backup?: BackupStatus;
  reply_speed?: ReplySpeed;
  burst_wait?: {
    quiet_ms: number;
    cap_ms: number;
    saved: boolean;
    column_missing?: boolean;
    default_quiet_ms: number;
    default_cap_ms: number;
  };
  markup: number;
  platform_cap: { amount: number; currency: string; spent: number };
  providers: Provider[];
  tiers: Tier[];
  models: Model[];
  /** Null when ai_cost_totals couldn't be read (totals_error says why) — never a partial sum. */
  totals: { cost: number; billed: number; margin: number; runs: number } | null;
  totals_error?: string | null;
};

function money(value: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(value);
}

function AdminAi() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [markup, setMarkup] = useState("3");
  const [platformCap, setPlatformCap] = useState("0");
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
    setPlatformCap(String(result.data.platform_cap?.amount ?? 0));
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
  if (!data) {
    return (
      <div className="space-y-4">
        <ErrorState message={error ?? "AI operations could not be loaded."} />
        <Button variant="outline" onClick={() => void load()}>Try again</Button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <PageHeader title="AI operations" description="The provider truth, cost basis, merchant pricing, and tier mapping live here." />
      {error ? <ErrorState message={error} /> : null}

      {data.totals_error ? (
        <p role="status" className="rounded-xl bg-amber-500/10 px-3.5 py-2.5 text-sm text-amber-800 dark:text-amber-300">
          {data.totals_error}
        </p>
      ) : null}
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Provider cost · 30 days", data.totals ? money(data.totals.cost) : "Unavailable"],
          ["Billed revenue · 30 days", data.totals ? money(data.totals.billed) : "Unavailable"],
          ["Margin · 30 days", data.totals ? money(data.totals.margin) : "Unavailable"],
          ["Runs · 30 days", data.totals ? String(data.totals.runs) : "Unavailable"],
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

      <PlatformCapCard
        cap={data.platform_cap ?? { amount: 0, currency: "INR", spent: 0 }}
        value={platformCap}
        onChange={setPlatformCap}
        busy={busy === "platform_cap"}
        onSave={() => act("set_platform_cap", { amount: Number(platformCap) }, "platform_cap")}
      />

      {data.backup ? <BackupCard backup={data.backup} onChanged={load} /> : null}

      {data.reply_speed ? <ReplySpeedCard speed={data.reply_speed} /> : null}

      {data.burst_wait ? <BurstWaitCard wait={data.burst_wait} onChanged={load} /> : null}

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

      <section className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
        <h2 className="text-lg font-semibold">Customer and owner rules</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          These now live in the Aiden control centre, next to scripts and workspace behaviour.
        </p>
        <Link to="/admin/aiden" className="mt-3 inline-flex text-sm font-medium text-primary hover:underline">
          Open Rules in Aiden control →
        </Link>
      </section>
    </div>
  );
}
/**
 * Per-merchant caps bound each workspace; total exposure is caps x merchants.
 * This is the ceiling on all of it, with a warning before it bites.
 */
function PlatformCapCard({
  cap,
  value,
  onChange,
  busy,
  onSave,
}: {
  cap: { amount: number; currency: string; spent: number };
  value: string;
  onChange: (next: string) => void;
  busy: boolean;
  onSave: () => void;
}) {
  const set = cap.amount > 0;
  const pct = set ? Math.min(100, Math.round((cap.spent / cap.amount) * 100)) : 0;
  const over = set && cap.spent >= cap.amount;
  const warn = set && !over && pct >= 80;

  return (
    <section className="rounded-xl border border-border/70 bg-card p-5 shadow-sm">
      <div className="flex items-start gap-3">
        <Gauge className="mt-0.5 h-5 w-5 text-primary" />
        <div className="flex-1">
          <h2 className="font-semibold">Platform monthly ceiling</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            There is no unlimited setting: this is the most the platform will bill across every organisation in a calendar month, and an unset or invalid ceiling stops every run rather than letting spend through. When it is reached, runs stop everywhere with the same plain-words message merchants already see.
          </p>

          <div className="mt-4 space-y-2">
            <div className="flex items-baseline justify-between text-sm">
              <span className="font-medium text-foreground">
                {money(cap.spent)} used{set ? ` of ${money(cap.amount)}` : ""}
              </span>
              {set ? <span className="text-muted-foreground">{pct}%</span> : <span className="font-medium text-destructive">No valid ceiling — all runs stopped</span>}
            </div>
            {set ? (
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full rounded-full transition-all ${over ? "bg-destructive" : warn ? "bg-amber-500" : "bg-primary"}`}
                  style={{ width: `${Math.max(pct, 2)}%` }}
                />
              </div>
            ) : null}
            {over ? (
              <p className="flex items-center gap-2 text-sm font-medium text-destructive">
                <AlertTriangle className="h-4 w-4" />The ceiling is reached — AI runs are stopped platform-wide.
              </p>
            ) : warn ? (
              <p className="flex items-center gap-2 text-sm font-medium text-amber-600">
                <AlertTriangle className="h-4 w-4" />Past 80% of the ceiling. Raise it or spend stops for every merchant.
              </p>
            ) : null}
          </div>

          <div className="mt-4 flex max-w-sm items-end gap-3">
            <div className="flex-1 space-y-2">
              <Label htmlFor="platform-cap">Monthly ceiling ({cap.currency})</Label>
              <Input
                id="platform-cap"
                type="number"
                min="1"
                step="100"
                value={value}
                onChange={(event) => onChange(event.target.value)}
              />
            </div>
            <Button disabled={busy} onClick={onSave}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}Save
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

const REASON_WORDS: Record<string, string> = {
  bad_key: "Bad key",
  no_credit: "No credit",
  wrong_model: "Wrong model",
  rate_limited: "Rate limited",
  unreachable: "Couldn't reach it",
  other: "Error",
};

const KEY_SOURCE_WORDS: Record<string, string> = {
  vault: "key from Platform providers",
  env: "key from server settings",
};

/**
 * How long Aiden waits for a second text before answering. Two texts inside
 * the wait get one reply; a longer wait means every reply arrives later.
 */
function BurstWaitCard({
  wait,
  onChanged,
}: {
  wait: NonNullable<Overview["burst_wait"]>;
  onChanged: () => Promise<void>;
}) {
  const [quiet, setQuiet] = useState(String(wait.quiet_ms / 1000));
  const [cap, setCap] = useState(String(wait.cap_ms / 1000));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    const result = await callApi<{ ok: boolean }>("/api/admin/ai", {
      body: {
        action: "set_burst_wait",
        quiet_ms: Math.round(Number(quiet) * 1000),
        cap_ms: Math.round(Number(cap) * 1000),
      },
    });
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    await onChanged();
  }

  return (
    <section className="rounded-xl border border-border/70 bg-card p-5 shadow-sm">
      <div className="flex items-start gap-3">
        <Gauge className="mt-0.5 h-5 w-5 text-primary" />
        <div className="flex-1 space-y-3">
          <div>
            <h2 className="font-semibold">Wait for a second message</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Aiden answers once the customer has gone quiet for this long, so two quick texts get one answer — and
              never waits longer than the limit after their first text.{" "}
              {wait.saved
                ? ""
                : `Using the defaults (${wait.default_quiet_ms / 1000} s quiet, ${wait.default_cap_ms / 1000} s at most)${
                    wait.column_missing ? " until migration 20261090 is applied" : ""
                  }.`}
            </p>
          </div>
          <div className="flex max-w-md flex-wrap items-end gap-3">
            <div className="min-w-[8rem] flex-1 space-y-2">
              <Label htmlFor="burst-quiet">Quiet for (s)</Label>
              <Input
                id="burst-quiet"
                type="number"
                min={0}
                max={10}
                step={0.5}
                value={quiet}
                onChange={(e) => setQuiet(e.target.value)}
              />
            </div>
            <div className="min-w-[8rem] flex-1 space-y-2">
              <Label htmlFor="burst-cap">At most (s)</Label>
              <Input
                id="burst-cap"
                type="number"
                min={0}
                max={10}
                step={0.5}
                value={cap}
                onChange={(e) => setCap(e.target.value)}
              />
            </div>
            <Button disabled={busy} onClick={() => void save()}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}Save
            </Button>
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
      </div>
    </section>
  );
}

/** Batch 29: the targets the PR states (received → WhatsApp accepted the first message). */
const SPEED_TARGET = { p50_ms: 5_000, p90_ms: 12_000 };

/** What a slow reply's reason means (ai_runs.metadata.reply_speed.reason). */
const SLOW_REASONS: Record<string, string> = {
  catch_up: "Picked up late by the catch-up sweep",
  reanswer: "Re-answered after its first pass died",
  waiting: "Waiting before Aiden started (storing, flows, automations)",
  burst: "Waiting for a second message",
  prelude: "Aiden's set-up reads",
  early_search: "Catalogue search",
  retrieval: "Reading the business's material",
  model: "The AI model",
  checks: "Checking the answer",
  send: "Sending to WhatsApp",
};

function seconds(ms: number | null): string {
  return ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`;
}

function SpeedCells({ w }: { w: SpeedWindow }) {
  const over = (v: number | null, limit: number) => (v !== null && v > limit ? "text-amber-700 dark:text-amber-300" : "");
  return (
    <>
      <td className={`px-3 py-2 tabular-nums ${over(w.p50_ms, SPEED_TARGET.p50_ms)}`}>{seconds(w.p50_ms)}</td>
      <td className={`px-3 py-2 tabular-nums ${over(w.p90_ms, SPEED_TARGET.p90_ms)}`}>{seconds(w.p90_ms)}</td>
      <td className="px-3 py-2 tabular-nums">{seconds(w.slowest_ms)}</td>
      <td className="px-3 py-2 tabular-nums text-muted-foreground">{w.replies}</td>
    </>
  );
}

/**
 * Batch 29: how fast Aiden answers — from receiving the customer's message
 * to WhatsApp accepting the first reply — per workspace, from one SQL
 * aggregate (reply_speed_stats), and every reply over 30 s with its reason.
 */
function ReplySpeedCard({ speed }: { speed: ReplySpeed }) {
  return (
    <section className="rounded-xl border border-border/70 bg-card p-5 shadow-sm">
      <div className="flex items-start gap-3">
        <Gauge className="mt-0.5 h-5 w-5 text-primary" />
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <h2 className="font-semibold">Reply speed</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              From receiving a customer's message to WhatsApp accepting Aiden's first reply. Target: half of replies under{" "}
              {SPEED_TARGET.p50_ms / 1000} s, nine in ten under {SPEED_TARGET.p90_ms / 1000} s.
            </p>
          </div>
          {speed.error ? (
            <p role="status" className="rounded-xl bg-amber-500/10 px-3.5 py-2.5 text-sm text-amber-800 dark:text-amber-300">
              {speed.error}
            </p>
          ) : speed.workspaces.length === 0 ? (
            <p className="text-sm text-muted-foreground">No timed replies in the last 7 days yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-left text-sm">
                <thead className="text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Workspace</th>
                    <th className="px-3 py-2 font-semibold">24 h p50</th>
                    <th className="px-3 py-2 font-semibold">p90</th>
                    <th className="px-3 py-2 font-semibold">Slowest</th>
                    <th className="px-3 py-2 font-semibold">Replies</th>
                    <th className="px-3 py-2 font-semibold">7 d p50</th>
                    <th className="px-3 py-2 font-semibold">p90</th>
                    <th className="px-3 py-2 font-semibold">Slowest</th>
                    <th className="px-3 py-2 font-semibold">Replies</th>
                  </tr>
                </thead>
                <tbody>
                  {speed.workspaces.map((w) => (
                    <tr key={w.organization_id} className="border-t border-border/60">
                      <td className="px-3 py-2 font-medium">{w.name ?? w.organization_id.slice(0, 8)}</td>
                      <SpeedCells w={w.last_24h} />
                      <SpeedCells w={w.last_7d} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!speed.error && speed.slow.length > 0 ? (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">Replies over {speed.slow_ms / 1000} s · 7 days</h3>
              <ul className="divide-y divide-border/60 rounded-lg border border-border/60 text-sm">
                {speed.slow.map((r) => (
                  <li key={r.run_id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2">
                    <span className="tabular-nums font-medium">{seconds(r.ms)}</span>
                    <span>{SLOW_REASONS[r.reason ?? ""] ?? r.reason ?? "Unknown"}</span>
                    <span className="text-muted-foreground">{r.name ?? r.organization_id.slice(0, 8)}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{new Date(r.at).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/**
 * The AI backup (used only when the Lovable gateway is out of credit or
 * failing): which backup keys are set — never the keys themselves — and where
 * they come from, the models (the Anthropic one is chosen here), and a live
 * test that sends one tiny prompt to each.
 */
function BackupCard({ backup, onChanged }: { backup: BackupStatus; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<BackupResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingModel, setSavingModel] = useState(false);
  const none = !backup.anthropic.configured && !backup.openai.configured;
  const models = backup.anthropic.models ?? [];

  async function chooseModel(model: string) {
    setSavingModel(true);
    setError(null);
    const result = await callApi<{ ok: boolean }>("/api/admin/ai", { body: { action: "set_backup_model", anthropic_model: model } });
    setSavingModel(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setResults(null);
    await onChanged();
  }

  async function test() {
    setBusy(true);
    setError(null);
    const result = await callApi<{ results: BackupResult[] }>("/api/admin/ai", { body: { action: "backup_test" } });
    setBusy(false);
    if (result.error || !result.data) {
      setError(result.error ?? "The test could not be run.");
      return;
    }
    setResults(result.data.results);
  }

  const rows: Array<{ provider: string; label: string; configured: boolean; source: string | null; models: string }> = [
    {
      provider: "anthropic",
      label: "Anthropic",
      configured: backup.anthropic.configured,
      source: backup.anthropic.key_source ?? null,
      models: backup.anthropic.model,
    },
    {
      provider: "openai",
      label: "OpenAI",
      configured: backup.openai.configured,
      source: backup.openai.key_source ?? null,
      models:
        backup.openai.model === backup.openai.careful_model
          ? backup.openai.model
          : `${backup.openai.model} (careful: ${backup.openai.careful_model})`,
    },
  ];

  return (
    <section className="rounded-xl border border-border/70 bg-card p-5 shadow-sm">
      <div className="flex items-start gap-3">
        <LifeBuoy className="mt-0.5 h-5 w-5 text-primary" />
        <div className="flex-1 space-y-4">
          <div>
            <h2 className="font-semibold">AI backup</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Answers only when the Lovable AI gateway is out of credit, rate-limited past its quota, failing or unreachable — never for a workspace on its own key. It uses the Anthropic and OpenAI keys stored under Platform providers below (else the server settings ANTHROPIC_API_KEY / OPENAI_API_KEY). Keys are never shown here.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {rows.map((row) => (
              <div key={row.provider} className="rounded-lg border border-border/70 p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{row.label}</span>
                  <span className={row.configured ? "text-primary" : "text-muted-foreground"}>
                    {row.configured ? "Configured: yes" : "Configured: no"}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Model: {row.models}
                  {row.source ? ` · ${KEY_SOURCE_WORDS[row.source] ?? row.source}` : ""}
                </p>
              </div>
            ))}
          </div>
          {models.length ? (
            <div className="max-w-md space-y-2">
              <Label htmlFor="backup-anthropic-model">Anthropic backup model</Label>
              <Select
                value={backup.anthropic.chosen_model ?? models[0]!.id}
                onValueChange={(next) => void chooseModel(next)}
                disabled={savingModel || Boolean(backup.anthropic.env_override)}
              >
                <SelectTrigger id="backup-anthropic-model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {models.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.label} · {m.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {backup.anthropic.env_override
                  ? `The server setting ANTHROPIC_BACKUP_MODEL is set, so ${backup.anthropic.model} is used whatever is chosen here.`
                  : "Sonnet answers well for much less than Opus. Saved for the whole platform."}
              </p>
            </div>
          ) : null}
          {backup.order.length > 1 ? (
            <p className="text-xs text-muted-foreground">Tried in this order: {backup.order.join(" → ")}</p>
          ) : null}
          <div className="flex items-center gap-3">
            <Button variant="outline" disabled={busy || none} onClick={() => void test()}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Test backup
            </Button>
            {none ? <span className="text-sm text-muted-foreground">No backup key is set, so there is nothing to test.</span> : null}
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {results ? (
            <ul className="space-y-2 text-sm">
              {results.map((r) => (
                <li key={`${r.provider}:${r.model}`} className="flex items-start gap-2">
                  {r.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />}
                  <span className="min-w-0">
                    <span className="font-medium capitalize">{r.provider}</span> · {r.model} —{" "}
                    {r.ok ? (
                      `answered in ${r.seconds.toFixed(1)} s`
                    ) : (
                      <span className="text-destructive">
                        {REASON_WORDS[r.reason ?? "other"] ?? "Error"}: <span className="break-words">{r.error}</span>
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </section>
  );
}
