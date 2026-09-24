import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/empty-state";
import { callApi } from "@/lib/whatsapp-client";

type Settings = {
  reader_primary: Engine;
  reader_fallback_order: Engine[];
  tavily_extract_depth: "basic" | "advanced";
  map_engine: Engine;
  tavily_monthly_credit_cap: number;
  tavily_workspace_monthly_cap: number;
  day0_page_limit: number;
  full_crawl_trigger: "on_number_connected" | "on_plan_active" | "manual";
  backfill_pages_per_day: number;
  on_demand_read: boolean;
  refresh_days: number;
  manual_refresh_cooldown_hours: number;
  firecrawl_monthly_credit_cap: number;
  firecrawl_workspace_monthly_cap: number;
  plan_page_overrides: Record<string, number>;
};
type Engine = "own" | "tavily" | "firecrawl";
const ENGINE_OPTS: Array<{ v: Engine; label: string }> = [
  { v: "tavily", label: "Tavily" },
  { v: "firecrawl", label: "Firecrawl" },
  { v: "own", label: "Own reader" },
];
const ORDERS: Engine[][] = [
  ["tavily", "firecrawl", "own"],
  ["firecrawl", "tavily", "own"],
  ["tavily", "own"],
  ["firecrawl", "own"],
  ["own"],
];
type Meta = { version: number; updated_at: string | null; updated_by_name: string | null };
type Plan = { id: string; name: string; pages: number };
type Loaded = { settings: Settings; meta: Meta; plans: Plan[] };

const NUMBERS: Array<{ key: keyof Settings; label: string; help: string }> = [
  { key: "day0_page_limit", label: "Quick read (pages)", help: "When an owner sends a link on WhatsApp." },
  { key: "backfill_pages_per_day", label: "Nightly pages per workspace", help: "0 turns the nightly read off." },
  { key: "refresh_days", label: "Refresh every (days)", help: "Changed pages only. 0 turns it off." },
  { key: "manual_refresh_cooldown_hours", label: "\"Read changes now\" cooldown (hours)", help: "How often a merchant can ask." },
  { key: "firecrawl_monthly_credit_cap", label: "Firecrawl credits / month (platform)", help: "After this, our own reader takes over." },
  { key: "firecrawl_workspace_monthly_cap", label: "Firecrawl credits / month (per workspace)", help: "Same fallback, per workspace." },
  { key: "tavily_monthly_credit_cap", label: "Tavily credits / month (platform)", help: "After this, the next reader in the fallback order." },
  { key: "tavily_workspace_monthly_cap", label: "Tavily credits / month (per workspace)", help: "Same fallback, per workspace." },
];

function Choice<T extends string>({ value, options, onChange }: { value: T; options: Array<{ v: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          className={`rounded-full border px-3 py-1.5 text-sm transition-colors duration-150 ${
            value === o.v ? "border-primary bg-primary/10 font-medium text-foreground" : "border-border text-muted-foreground hover:bg-muted"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ReadingSettingsPanel() {
  const [data, setData] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const { data: res, error: err } = await callApi<Loaded>("/api/admin/ai", { body: { action: "reading_load" } });
    if (err || !res) return setError(err ?? "Couldn't load the reading settings.");
    setData(res);
    setDraft(res.settings);
    setError(null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !data) return <ErrorState message={error} />;
  if (!data || !draft) return <Skeleton className="h-96 w-full rounded-2xl" />;

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft({ ...draft, [k]: v });
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.settings);

  const save = async () => {
    setSaving(true);
    const { data: res, error: err } = await callApi<Loaded>("/api/admin/ai", {
      body: { action: "reading_save", base_version: data.meta.version, settings: draft },
    });
    setSaving(false);
    if (err || !res) {
      toast.error(err ?? "Couldn't save.");
      return;
    }
    setData(res);
    setDraft(res.settings);
    toast.success("Reading settings saved.");
  };

  return (
    <div className="space-y-6 rounded-2xl border border-border/70 bg-card p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">How Aiden reads websites</h2>
          <p className="text-sm text-muted-foreground">
            Applies to every workspace. Reading order is fixed: home, contact/about, policies, FAQ, pricing, collections, products, the rest; blog and archives last. Cart, checkout and login pages are never read.
          </p>
        </div>
        <span className="text-xs text-muted-foreground">
          Version {data.meta.version}
          {data.meta.updated_at
            ? ` · Last changed by ${data.meta.updated_by_name ?? "an admin"}, ${new Date(data.meta.updated_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}`
            : ""}
        </span>
      </div>

      <div className="space-y-2">
        <Label>Main reader</Label>
        <Choice value={draft.reader_primary} onChange={(v) => set("reader_primary", v)} options={ENGINE_OPTS} />
      </div>
      <div className="space-y-2">
        <Label>If it fails, thin page (under 300 characters), limit reached or refused</Label>
        <Choice
          value={draft.reader_fallback_order.join(",")}
          onChange={(v) => set("reader_fallback_order", v.split(",") as Engine[])}
          options={ORDERS.map((o) => ({ v: o.join(","), label: o.map((e) => ENGINE_OPTS.find((x) => x.v === e)?.label).join(" → ") }))}
        />
      </div>
      <div className="space-y-2">
        <Label>Tavily depth</Label>
        <Choice
          value={draft.tavily_extract_depth}
          onChange={(v) => set("tavily_extract_depth", v)}
          options={[
            { v: "basic", label: "Basic (retries a thin page with advanced)" },
            { v: "advanced", label: "Advanced (2× credits)" },
          ]}
        />
      </div>
      <div className="space-y-2">
        <Label>Finding pages</Label>
        <Choice
          value={draft.map_engine}
          onChange={(v) => set("map_engine", v)}
          options={[
            { v: "own", label: "Sitemap (Tavily only if none)" },
            { v: "tavily", label: "Tavily" },
            { v: "firecrawl", label: "Firecrawl" },
          ]}
        />
      </div>

      <div className="space-y-2">
        <Label>Read the whole site</Label>
        <Choice
          value={draft.full_crawl_trigger}
          onChange={(v) => set("full_crawl_trigger", v)}
          options={[
            { v: "on_number_connected", label: "When a number is connected" },
            { v: "on_plan_active", label: "When a plan is active" },
            { v: "manual", label: "Only when asked" },
          ]}
        />
      </div>

      <div className="flex items-center justify-between gap-4 rounded-xl bg-muted/40 p-4">
        <div>
          <Label htmlFor="ondemand">Read a page on demand</Label>
          <p className="text-xs text-muted-foreground">When a customer's question finds nothing, read one matching unread page (max 3 per chat).</p>
        </div>
        <Switch id="ondemand" checked={draft.on_demand_read} onCheckedChange={(v) => set("on_demand_read", v)} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {NUMBERS.map((n) => (
          <div key={n.key} className="space-y-1.5">
            <Label htmlFor={n.key}>{n.label}</Label>
            <Input
              id={n.key}
              type="number"
              min={0}
              value={String(draft[n.key] as number)}
              onChange={(e) => set(n.key, Number(e.target.value) as never)}
            />
            <p className="text-xs text-muted-foreground">{n.help}</p>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <Label>Page limit per plan</Label>
        <p className="text-xs text-muted-foreground">Leave blank to use the plan's own limit. Shopify products never count against it.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {data.plans.map((p) => (
            <div key={p.id} className="flex items-center gap-3">
              <span className="w-28 text-sm">{p.name}</span>
              <Input
                type="number"
                min={1}
                placeholder={`${p.pages} (plan)`}
                value={draft.plan_page_overrides[p.id] ? String(draft.plan_page_overrides[p.id]) : ""}
                onChange={(e) => {
                  const o = { ...draft.plan_page_overrides };
                  const n = Number(e.target.value);
                  if (n > 0) o[p.id] = n;
                  else delete o[p.id];
                  set("plan_page_overrides", o);
                }}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={!dirty || saving} onClick={() => setDraft(data.settings)}>
          Discard
        </Button>
        <Button disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save reading settings"}
        </Button>
      </div>
    </div>
  );
}
