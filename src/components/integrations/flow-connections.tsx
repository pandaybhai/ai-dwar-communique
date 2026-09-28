import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Copy, IndianRupee, Loader2, Sheet, Unplug, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/empty-state";
import { callApi } from "@/lib/whatsapp-client";
import { useOrg } from "@/lib/org-context";
import { usePermissions } from "@/hooks/use-permissions";

type Conn = { account_label: string | null; status: string; last_error: string | null; public_config: Record<string, unknown>; updated_at: string } | null;
type Resp = { google_available: boolean; google: Conn; razorpay: Conn; razorpay_webhook_url: string };

/** The merchant's own Google and Razorpay accounts, used by flow steps. */
export function FlowConnections() {
  const { activeOrgId } = useOrg() as unknown as { activeOrgId: string | null };
  const { can } = usePermissions();
  const manage = can("integrations.manage");
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ key_id: "", key_secret: "", webhook_secret: "" });

  const load = useCallback(async () => {
    if (!activeOrgId) return;
    const r = await callApi<Resp>(`/api/integrations/flow-connections?organization_id=${activeOrgId}`);
    if (r.error) setError(r.error);
    else setData(r.data);
  }, [activeOrgId]);

  useEffect(() => {
    void load();
    const q = new URLSearchParams(window.location.search).get("google");
    if (q === "connected") toast.success("Google connected.");
    if (q === "failed") toast.error("Google wasn't connected. Please try again.");
  }, [load]);

  const post = async (body: Record<string, unknown>, tag: string) => {
    setBusy(tag);
    const r = await callApi<{ ok?: boolean; url?: string }>("/api/integrations/flow-connections", { method: "POST", body: { organization_id: activeOrgId, ...body } });
    setBusy(null);
    if (r.error) {
      toast.error(r.error);
      return null;
    }
    return r.data;
  };

  if (error) return <ErrorState message={error} />;
  if (!data) return <Skeleton className="h-56 w-full rounded-2xl" />;

  const status = (c: Conn) =>
    c ? (c.status === "active" ? <Badge className="gap-1"><CheckCircle2 className="h-3 w-3" /> Connected</Badge> : <Badge variant="destructive" className="gap-1"><AlertTriangle className="h-3 w-3" /> Needs attention</Badge>) : <Badge variant="outline">Not connected</Badge>;

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div className="flex gap-3">
            <Sheet className="mt-0.5 h-5 w-5 text-primary" />
            <div>
              <h3 className="font-semibold">Google Sheets</h3>
              <p className="text-sm text-muted-foreground">Connect your own Google account so flows can add rows to your sheets.</p>
            </div>
          </div>
          {status(data.google)}
        </div>
        {data.google ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>{data.google.account_label}{data.google.last_error ? ` · ${data.google.last_error}` : ""}</span>
            {manage && (
              <div className="flex gap-2">
                {data.google.status !== "active" && data.google_available && <Button size="sm" onClick={async () => { const r = await post({ action: "google_start" }, "g"); if (r?.url) window.location.href = r.url; }}>Reconnect</Button>}
                <Button size="sm" variant="outline" disabled={busy === "gd"} onClick={async () => { if (await post({ action: "disconnect", provider: "google" }, "gd")) void load(); }}><Unplug className="mr-1 h-4 w-4" /> Disconnect</Button>
              </div>
            )}
          </div>
        ) : data.google_available ? (
          manage && <Button className="mt-4" disabled={busy === "g"} onClick={async () => { const r = await post({ action: "google_start" }, "g"); if (r?.url) window.location.href = r.url; }}>{busy === "g" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}Connect Google</Button>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">Google connection is being switched on by AiDwar — check back soon.</p>
        )}
      </section>

      <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div className="flex gap-3">
            <IndianRupee className="mt-0.5 h-5 w-5 text-primary" />
            <div>
              <h3 className="font-semibold">Razorpay payments</h3>
              <p className="text-sm text-muted-foreground">Use your own Razorpay account so flow payment links pay you directly.</p>
            </div>
          </div>
          {status(data.razorpay)}
        </div>
        {data.razorpay ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>{data.razorpay.account_label} · {String(data.razorpay.public_config["mode"] ?? "")} mode{data.razorpay.last_error ? ` · ${data.razorpay.last_error}` : ""}</span>
            {manage && <Button size="sm" variant="outline" disabled={busy === "rd"} onClick={async () => { if (await post({ action: "disconnect", provider: "razorpay" }, "rd")) void load(); }}><Unplug className="mr-1 h-4 w-4" /> Remove keys</Button>}
          </div>
        ) : manage ? (
          <div className="mt-4 space-y-3">
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>In Razorpay → Account & Settings → API Keys, generate a key.</li>
              <li>In Razorpay → Webhooks, add the link below, pick a secret, and tick <b>payment_link.paid</b>.</li>
            </ol>
            <div className="flex gap-2">
              <Input readOnly value={data.razorpay_webhook_url} />
              <Button variant="outline" size="icon" aria-label="Copy webhook link" onClick={() => { void navigator.clipboard.writeText(data.razorpay_webhook_url); toast.success("Copied"); }}><Copy className="h-4 w-4" /></Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5"><Label>Key ID</Label><Input placeholder="rzp_live_…" value={form.key_id} onChange={(e) => setForm({ ...form, key_id: e.target.value })} /></div>
              <div className="space-y-1.5"><Label>Key Secret</Label><Input type="password" value={form.key_secret} onChange={(e) => setForm({ ...form, key_secret: e.target.value })} /></div>
              <div className="space-y-1.5"><Label>Webhook secret</Label><Input type="password" value={form.webhook_secret} onChange={(e) => setForm({ ...form, webhook_secret: e.target.value })} /></div>
            </div>
            <Button disabled={busy === "r"} onClick={async () => { if (await post({ action: "razorpay_save", ...form }, "r")) { setForm({ key_id: "", key_secret: "", webhook_secret: "" }); toast.success("Razorpay connected."); void load(); } }}>
              {busy === "r" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}Save keys
            </Button>
            <p className="text-xs text-muted-foreground">Keys are stored encrypted and never shown again.</p>
          </div>
        ) : null}
      </section>
    </div>
  );
}
