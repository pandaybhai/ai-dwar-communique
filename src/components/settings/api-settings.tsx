import { useCallback, useEffect, useState } from "react";
import { Check, Copy, KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/empty-state";
import { callApi } from "@/lib/whatsapp-client";
import { useOrg } from "@/lib/org-context";

type KeyRow = {
  id: string;
  name: string;
  masked: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

function when(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        toast.success("Copied");
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
    </Button>
  );
}

/** Settings → API & webhooks (Batch 34). */
export function ApiSettingsTab() {
  return (
    <div className="space-y-6">
      <ApiKeysCard />
    </div>
  );
}

/** The workspace's API keys: create (shown once), list, revoke, last used. */
export function ApiKeysCard() {
  const { active } = useOrg();
  const orgId = active?.organization.id ?? null;
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orgId) return;
    const r = await callApi<{ keys: KeyRow[] }>(`/api/developer/keys?organization_id=${orgId}`, {
      method: "GET",
    });
    if (r.error) setError(r.error);
    else setKeys(r.data?.keys ?? []);
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("create");
    const r = await callApi<{ key: string }>("/api/developer/keys", {
      body: { organization_id: orgId, action: "create", name },
    });
    setBusy(null);
    if (r.error || !r.data) {
      toast.error(r.error ?? "We couldn't create the key.");
      return;
    }
    setFresh(r.data.key);
    setName("");
    void load();
  };

  const revoke = async (row: KeyRow) => {
    if (!window.confirm(`Revoke "${row.name}"? Anything using it stops working at once.`)) return;
    setBusy(row.id);
    const r = await callApi("/api/developer/keys", {
      body: { organization_id: orgId, action: "revoke", key_id: row.id },
    });
    setBusy(null);
    if (r.error) {
      toast.error(r.error);
      return;
    }
    toast.success("Key revoked");
    void load();
  };

  if (error) return <ErrorState message={error} />;
  if (!keys) return <Skeleton className="h-56 w-full rounded-2xl" />;

  return (
    <section className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm sm:p-8">
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 h-5 w-5 text-primary" aria-hidden="true" />
        <div>
          <h2 className="text-base font-semibold text-foreground">API keys</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Your own software (billing, POS, Zoho) uses a key to send approved templates from this
            workspace. Keep keys on your server, never in a web page or an app.
          </p>
        </div>
      </div>

      {fresh ? (
        <div className="mt-5 rounded-xl border border-primary/40 bg-primary/5 p-4" role="status">
          <p className="text-sm font-medium text-foreground">
            Copy your new key now — it won't be shown again.
          </p>
          <div className="mt-2 flex gap-2">
            <Input readOnly value={fresh} className="font-mono text-xs" aria-label="New API key" />
            <CopyButton value={fresh} label="Copy API key" />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={() => setFresh(null)}
          >
            I've saved it
          </Button>
        </div>
      ) : null}

      <form onSubmit={create} className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="api-key-name">New key name</Label>
          <Input
            id="api-key-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Billing software"
            maxLength={80}
          />
        </div>
        <Button
          type="submit"
          className="rounded-full"
          disabled={busy === "create" || name.trim().length < 2}
        >
          {busy === "create" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Create key
        </Button>
      </form>

      {keys.length === 0 ? (
        <p className="mt-5 text-sm text-muted-foreground">No keys yet.</p>
      ) : (
        <ul className="mt-5 divide-y divide-border/70 rounded-xl border border-border/70">
          {keys.map((k) => (
            <li
              key={k.id}
              className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm"
            >
              <div className="min-w-0">
                <p className="font-medium text-foreground">
                  {k.name} {k.revoked_at ? <Badge variant="outline">Revoked</Badge> : null}
                </p>
                <p className="font-mono text-xs text-muted-foreground">{k.masked}</p>
                <p className="text-xs text-muted-foreground">
                  Created {when(k.created_at)} · Last used {when(k.last_used_at)}
                </p>
              </div>
              {k.revoked_at ? null : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy === k.id}
                  onClick={() => void revoke(k)}
                >
                  {busy === k.id ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

