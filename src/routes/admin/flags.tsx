import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Flag, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { EmptyState, ErrorState, PageHeader, PageSkeleton } from "@/components/empty-state";
import { aidwar } from "@/integrations/aidwar/client";

export const Route = createFileRoute("/admin/flags")({
  component: AdminFlags,
});

type FlagRow = { id: string; key: string; name: string; description: string | null; default_enabled: boolean };
type OrgRow = { id: string; name: string };
type Override = { organization_id: string; flag_key: string; enabled: boolean };

function AdminFlags() {
  const [flags, setFlags] = useState<FlagRow[] | null>(null);
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newKey, setNewKey] = useState("");
  const [newName, setNewName] = useState("");
  const [newDefault, setNewDefault] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const [{ data: f, error: err }, { data: o }, { data: ov }] = await Promise.all([
      aidwar.from("feature_flags").select("id, key, name, description, default_enabled").order("key"),
      aidwar.from("organizations").select("id, name").order("name"),
      aidwar.from("organization_feature_overrides").select("organization_id, flag_key, enabled"),
    ]);
    if (err) {
      setError("We couldn't load feature flags. Please refresh.");
      setFlags([]);
      return;
    }
    setFlags((f ?? []) as FlagRow[]);
    setOrgs((o ?? []) as OrgRow[]);
    setOverrides((ov ?? []) as Override[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createFlag(e: React.FormEvent) {
    e.preventDefault();
    const key = newKey.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
    if (!key || newName.trim().length < 2) {
      setError("Give the flag a key and a name.");
      return;
    }
    setCreating(true);
    const { error: err } = await aidwar
      .from("feature_flags")
      .insert({ key, name: newName.trim(), default_enabled: newDefault });
    setCreating(false);
    if (err) {
      setError("We couldn't create that flag. Keys must be unique.");
      return;
    }
    setNewKey("");
    setNewName("");
    await load();
  }

  async function setDefault(flag: FlagRow, enabled: boolean) {
    setBusy(`default:${flag.key}`);
    const { error: err } = await aidwar.from("feature_flags").update({ default_enabled: enabled }).eq("id", flag.id);
    setBusy(null);
    if (err) setError("We couldn't update that flag.");
    else await load();
  }

  function resolve(orgId: string, flag: FlagRow) {
    const ov = overrides.find((o) => o.organization_id === orgId && o.flag_key === flag.key);
    return ov ? ov.enabled : flag.default_enabled;
  }

  async function setOverride(orgId: string, flag: FlagRow, enabled: boolean) {
    setBusy(`${orgId}:${flag.key}`);
    const { error: err } = await aidwar
      .from("organization_feature_overrides")
      .upsert({ organization_id: orgId, flag_key: flag.key, enabled }, { onConflict: "organization_id,flag_key" });
    setBusy(null);
    if (err) setError("We couldn't save that override.");
    else await load();
  }

  async function clearOverride(orgId: string, flag: FlagRow) {
    setBusy(`${orgId}:${flag.key}`);
    const { error: err } = await aidwar
      .from("organization_feature_overrides")
      .delete()
      .eq("organization_id", orgId)
      .eq("flag_key", flag.key);
    setBusy(null);
    if (err) setError("We couldn't reset that override.");
    else await load();
  }

  if (!flags) return <PageSkeleton />;

  return (
    <>
      <PageHeader
        title="Feature Flags"
        description="Global defaults plus per-organization overrides. Disabled features disappear cleanly from the workspace."
      />
      {error ? <div className="mb-6"><ErrorState message={error} /></div> : null}

      <form
        onSubmit={createFlag}
        className="mb-8 grid gap-4 rounded-2xl border border-border/70 bg-card p-5 shadow-sm sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end"
      >
        <div className="space-y-2">
          <Label htmlFor="flag_key">Key</Label>
          <Input id="flag_key" value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="ai_features" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="flag_name">Name</Label>
          <Input id="flag_name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="AI Features" />
        </div>
        <div className="flex items-center gap-2 pb-2">
          <Switch id="flag_default" checked={newDefault} onCheckedChange={setNewDefault} />
          <Label htmlFor="flag_default" className="text-sm">On by default</Label>
        </div>
        <Button type="submit" className="rounded-full" disabled={creating}>
          {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
          Add flag
        </Button>
      </form>

      {flags.length === 0 ? (
        <EmptyState icon={Flag} title="No feature flags yet" description="Create your first flag to start controlling what customers can see." />
      ) : (
        <div className="space-y-8">
          <section className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
            <header className="border-b border-border/70 px-5 py-4">
              <h2 className="text-sm font-semibold text-foreground">Global defaults</h2>
            </header>
            <ul className="divide-y divide-border/70">
              {flags.map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-4 px-5 py-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{f.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      <code>{f.key}</code>
                      {f.description ? ` · ${f.description}` : ""}
                    </p>
                  </div>
                  <Switch
                    checked={f.default_enabled}
                    disabled={busy === `default:${f.key}`}
                    onCheckedChange={(v) => setDefault(f, v)}
                  />
                </li>
              ))}
            </ul>
          </section>

          <section className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
            <header className="border-b border-border/70 px-5 py-4">
              <h2 className="text-sm font-semibold text-foreground">Per-organization overrides</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Toggling sets an explicit override. Use Reset to fall back to the global default.
              </p>
            </header>
            {orgs.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-muted-foreground">No organizations to configure yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Organization</th>
                      {flags.map((f) => (
                        <th key={f.id} className="px-4 py-3 font-semibold">{f.name}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/70">
                    {orgs.map((o) => (
                      <tr key={o.id} className="transition-colors duration-200 hover:bg-muted/30">
                        <td className="px-4 py-3 font-medium text-foreground">{o.name}</td>
                        {flags.map((f) => {
                          const has = overrides.some(
                            (ov) => ov.organization_id === o.id && ov.flag_key === f.key,
                          );
                          return (
                            <td key={f.id} className="px-4 py-3">
                              <div className="flex items-center gap-2">
                                <Switch
                                  checked={resolve(o.id, f)}
                                  disabled={busy === `${o.id}:${f.key}`}
                                  onCheckedChange={(v) => setOverride(o.id, f, v)}
                                />
                                {has ? (
                                  <button
                                    type="button"
                                    className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                                    onClick={() => clearOverride(o.id, f)}
                                  >
                                    Reset
                                  </button>
                                ) : (
                                  <span className="text-xs text-muted-foreground">default</span>
                                )}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
