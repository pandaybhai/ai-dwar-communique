import { useCallback, useEffect, useState } from "react";
import { Copy, KeyRound, Store, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { callApi } from "@/lib/whatsapp-client";

type App = {
  id: string;
  shop_domain: string;
  client_id: string;
  label: string | null;
  install_link: string | null;
  status: "active" | "disconnected";
  secret_set: boolean;
  updated_at: string;
};

const api = (body: Record<string, unknown>) =>
  callApi<Record<string, unknown>>("/api/admin/ai", { body });

/** Super-admin: one custom-distribution Shopify app per store. Secret is write-only. */
export function ShopifyCustomAppPanel({ organizationId }: { organizationId: string }) {
  const [app, setApp] = useState<App | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ shop_domain: "", client_id: "", client_secret: "", install_link: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error: err } = await api({ action: "shopify_app_load", organization_id: organizationId });
    if (err) return setError(err);
    const first = ((data?.["apps"] as App[]) ?? [])[0] ?? null;
    setApp(first);
    setForm({
      shop_domain: first?.shop_domain ?? "",
      client_id: first?.client_id ?? "",
      client_secret: "",
      install_link: first?.install_link ?? "",
    });
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    const { error: err } = await api({ action: "shopify_app_save", organization_id: organizationId, ...form });
    setBusy(false);
    if (err) return void toast.error(err);
    toast.success("Saved. The secret is stored safely and won't be shown again.");
    await load();
  };

  const remove = async () => {
    if (!app || !window.confirm(`Remove the custom app for ${app.shop_domain}?`)) return;
    setBusy(true);
    const { error: err } = await api({ action: "shopify_app_delete", organization_id: organizationId, id: app.id });
    setBusy(false);
    if (err) return void toast.error(err);
    toast.success("Removed. This store now uses the public AiDwar app.");
    await load();
  };

  const copy = async () => {
    if (!form.install_link) return;
    await navigator.clipboard.writeText(form.install_link);
    toast.success("Install link copied — send it to the merchant.");
  };

  return (
    <section className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Store className="h-4 w-4 text-primary" />
          <h3 className="font-semibold">Shopify custom app</h3>
        </div>
        {app ? (
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${app.status === "active" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
            {app.status === "active" ? "Active" : "Disconnected"}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        For stores that install through their own app. Other stores keep using the public AiDwar app.
      </p>

      {error ? (
        <p className="mt-4 text-sm text-destructive">{error}</p>
      ) : app === undefined ? (
        <Skeleton className="mt-4 h-48 w-full rounded-xl" />
      ) : (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="sca-shop">Shop domain</Label>
            <Input id="sca-shop" placeholder="store.myshopify.com" value={form.shop_domain} disabled={Boolean(app)}
              onChange={(e) => setForm({ ...form, shop_domain: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sca-id">Client ID</Label>
            <Input id="sca-id" value={form.client_id} onChange={(e) => setForm({ ...form, client_id: e.target.value })} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="sca-secret">Client secret</Label>
            <Input id="sca-secret" type="password" autoComplete="off"
              placeholder={app?.secret_set ? "Saved — type a new one to replace it" : "Paste the client secret"}
              value={form.client_secret} onChange={(e) => setForm({ ...form, client_secret: e.target.value })} />
            {app?.secret_set ? (
              <p className="flex items-center gap-1 text-xs text-muted-foreground"><KeyRound className="h-3 w-3" /> A secret is saved. It is never shown.</p>
            ) : null}
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="sca-link">Install link</Label>
            <div className="flex gap-2">
              <Input id="sca-link" placeholder="Paste the link generated in Shopify" value={form.install_link}
                onChange={(e) => setForm({ ...form, install_link: e.target.value })} />
              <Button type="button" variant="outline" disabled={!form.install_link} onClick={() => void copy()}>
                <Copy className="mr-1.5 h-4 w-4" /> Copy link for merchant
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</Button>
            {app ? (
              <Button variant="outline" disabled={busy} onClick={() => void remove()}>
                <Trash2 className="mr-1.5 h-4 w-4" /> Remove
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
