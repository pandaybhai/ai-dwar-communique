import { useCallback, useEffect, useState } from "react";
import { BookOpen, Check, Copy, KeyRound, Loader2, Webhook } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/empty-state";
import { callApi } from "@/lib/whatsapp-client";
import { useOrg } from "@/lib/org-context";
import { aidwar } from "@/integrations/aidwar/client";
import { DOCS_PATH, apiReadyTemplates, curlExample } from "@/lib/public-api";
import { POSTMAN_PATH, WEBHOOK_EVENTS } from "@/lib/public-api-spec";

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
      <ApiQuickstartCard />
      <ApiKeysCard />
      <WebhookCard />
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

type Delivery = {
  id: string;
  event: string;
  state: string;
  attempts: number;
  last_status: number | null;
  last_error: string | null;
  last_attempt_at: string | null;
  delivered_at: string | null;
  created_at: string;
  next_attempt_at: string | null;
};
type WebhookState = {
  url: string | null;
  status: string | null;
  last_delivery: Delivery | null;
  recent: Delivery[];
};

function deliveryLine(d: Delivery): string {
  const code = d.last_status ? `HTTP ${d.last_status}` : (d.last_error ?? "");
  if (d.state === "delivered")
    return `Delivered ${when(d.delivered_at)}${code ? ` · ${code}` : ""}`;
  if (d.state === "failed")
    return `Failed after ${d.attempts} ${d.attempts === 1 ? "try" : "tries"}${code ? ` · ${code}` : ""}`;
  if (d.state === "skipped") return "Not sent — no webhook was set";
  return d.attempts
    ? `Retrying (${d.attempts} ${d.attempts === 1 ? "try" : "tries"} so far${code ? `, ${code}` : ""}) · next ${when(d.next_attempt_at)}`
    : "Waiting to be sent";
}

type WebhookRow = {
  webhook_id: string;
  url: string;
  events: string[];
  all_events: boolean;
  status: "active" | "disabled";
};

/** Event checkboxes for one webhook: every event, or the ones ticked. */
function EventPicker({
  value,
  onChange,
  idPrefix,
}: {
  value: string[] | null;
  onChange: (next: string[] | null) => void;
  idPrefix: string;
}) {
  const all = value === null;
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-foreground">Events this webhook receives</legend>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={all}
          onChange={(e) => onChange(e.target.checked ? null : WEBHOOK_EVENTS.map((ev) => ev.name))}
        />
        Every event (including new ones)
      </label>
      {!all ? (
        <ul className="grid gap-1.5 sm:grid-cols-2" aria-label="Webhook events">
          {WEBHOOK_EVENTS.map((ev) => (
            <li key={ev.name}>
              <label className="flex items-start gap-2 text-xs" htmlFor={`${idPrefix}-${ev.name}`}>
                <input
                  id={`${idPrefix}-${ev.name}`}
                  type="checkbox"
                  className="mt-0.5"
                  checked={value.includes(ev.name)}
                  onChange={(e) =>
                    onChange(
                      e.target.checked ? [...value, ev.name] : value.filter((n) => n !== ev.name),
                    )
                  }
                />
                <span>
                  <span className="font-mono text-foreground">{ev.name}</span>
                  <span className="block text-muted-foreground">{ev.when}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
    </fieldset>
  );
}

/**
 * The workspace's webhooks (up to 5; one before the v1.2 database update):
 * each with its address, its events, its signing secret (shown once), a
 * test and its last results.
 */
export function WebhookCard() {
  const { active } = useOrg();
  const orgId = active?.organization.id ?? null;
  const [state, setState] = useState<
    (WebhookState & { mode?: string; limit?: number; webhooks?: WebhookRow[] }) | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[] | null>(null);
  const [editing, setEditing] = useState<{ id: string; events: string[] | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orgId) return;
    const r = await callApi<
      WebhookState & { mode?: string; limit?: number; webhooks?: WebhookRow[] }
    >(`/api/developer/webhook?organization_id=${orgId}`, { method: "GET" });
    if (r.error) setError(r.error);
    else setState(r.data);
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    const key = `${action}:${String(extra["webhook_id"] ?? "")}`;
    setBusy(key);
    const r = await callApi<{
      secret?: string;
      result?: { ok: boolean; status: number | null; error: string | null };
    }>("/api/developer/webhook", { body: { organization_id: orgId, action, ...extra } });
    setBusy(null);
    if (r.error || !r.data) {
      toast.error(r.error ?? "Something went wrong.");
      return;
    }
    if (r.data.secret) setSecret(r.data.secret);
    if (action === "test" && r.data.result) {
      if (r.data.result.ok) toast.success(`Test event delivered (HTTP ${r.data.result.status}).`);
      else
        toast.error(
          `Test event not delivered: ${r.data.result.status ? `HTTP ${r.data.result.status}` : r.data.result.error}.`,
        );
    } else if (action === "create" || action === "save") {
      toast.success("Webhook saved");
      setUrl("");
      setEvents(null);
    } else if (action === "update") {
      toast.success("Webhook updated");
      setEditing(null);
    } else if (action === "remove") toast.success("Webhook removed");
    void load();
  };

  if (error) return <ErrorState message={error} />;
  if (!state) return <Skeleton className="h-56 w-full rounded-2xl" />;

  const multi = state.mode === "multi";
  const webhooks: WebhookRow[] =
    state.webhooks ??
    (state.url
      ? [{ webhook_id: "", url: state.url, events: [], all_events: true, status: "active" }]
      : []);
  const limit = state.limit ?? 1;
  const busyOn = (action: string, id: string) => busy === `${action}:${id}`;

  return (
    <section className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm sm:p-8">
      <div className="flex items-start gap-3">
        <Webhook className="mt-0.5 h-5 w-5 text-primary" aria-hidden="true" />
        <div>
          <h2 className="text-base font-semibold text-foreground">
            Webhooks{multi ? ` (${webhooks.length} of ${limit})` : ""}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            We POST each event to your address as it happens, signed with that webhook's own secret
            (X-AiDwar-Signature). Failed deliveries are retried for 24 hours.{" "}
            <a href={`${DOCS_PATH}/webhooks`} className="text-primary hover:underline nd:underline nd:underline-offset-2">
              Events and payloads
            </a>
          </p>
        </div>
      </div>

      {secret ? (
        <div className="mt-5 rounded-xl border border-primary/40 bg-primary/5 p-4" role="status">
          <p className="text-sm font-medium text-foreground">
            Copy your signing secret now — it won't be shown again.
          </p>
          <div className="mt-2 flex gap-2">
            <Input
              readOnly
              value={secret}
              className="font-mono text-xs"
              aria-label="Webhook signing secret"
            />
            <CopyButton value={secret} label="Copy signing secret" />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={() => setSecret(null)}
          >
            I've saved it
          </Button>
        </div>
      ) : null}

      {webhooks.length ? (
        <ul className="mt-5 space-y-3" aria-label="Your webhooks">
          {webhooks.map((w) => {
            const id = w.webhook_id;
            const withId = multi ? { webhook_id: id } : {};
            return (
              <li key={id || w.url} className="rounded-xl border border-border/70 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">
                    {w.url}
                  </span>
                  <Badge variant={w.status === "active" ? "secondary" : "outline"}>
                    {w.status === "active" ? "Active" : "Disabled"}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {w.all_events ? "Every event" : w.events.join(", ")}
                </p>
                {editing?.id === id && multi ? (
                  <div className="mt-3 space-y-3">
                    <EventPicker
                      value={editing.events}
                      onChange={(next) => setEditing({ id, events: next })}
                      idPrefix={`edit-${id}`}
                    />
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        disabled={busyOn("update", id) || editing.events?.length === 0}
                        onClick={() =>
                          void act("update", { webhook_id: id, events: editing.events ?? "*" })
                        }
                      >
                        Save events
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditing(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busyOn("test", multi ? id : "")}
                    onClick={() => void act("test", withId)}
                  >
                    {busyOn("test", multi ? id : "") ? (
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    ) : null}
                    Send test event
                  </Button>
                  {multi ? (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setEditing({ id, events: w.all_events ? null : w.events })}
                      >
                        Choose events
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busyOn("update", id)}
                        onClick={() =>
                          void act("update", {
                            webhook_id: id,
                            status: w.status === "active" ? "disabled" : "active",
                          })
                        }
                      >
                        {w.status === "active" ? "Pause" : "Resume"}
                      </Button>
                    </>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busyOn("rotate", multi ? id : "")}
                    onClick={() => {
                      if (
                        window.confirm(
                          "Make a new signing secret? The old one stops working at once.",
                        )
                      )
                        void act("rotate", withId);
                    }}
                  >
                    Rotate secret
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busyOn("remove", multi ? id : "")}
                    onClick={() => {
                      if (window.confirm("Remove this webhook? Updates stop being sent to it."))
                        void act("remove", withId);
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {webhooks.length < limit ? (
        <form
          className="mt-5 space-y-3 rounded-xl border border-dashed border-border p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void act(multi ? "create" : "save", multi ? { url, events: events ?? "*" } : { url });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="api-webhook-url">
              {webhooks.length ? "Add another webhook (https)" : "Webhook address (https)"}
            </Label>
            <Input
              id="api-webhook-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://your-system.example.com/aidwar"
            />
          </div>
          {multi ? <EventPicker value={events} onChange={setEvents} idPrefix="new" /> : null}
          <Button
            type="submit"
            className="rounded-full"
            disabled={
              busy?.startsWith("create") ||
              busy?.startsWith("save") ||
              !url.trim() ||
              events?.length === 0
            }
          >
            {busy?.startsWith("create") || busy?.startsWith("save") ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            Save
          </Button>
        </form>
      ) : null}

      <div className="mt-5">
        <h3 className="text-sm font-medium text-foreground">Last delivery</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {state.last_delivery
            ? `${state.last_delivery.event} — ${deliveryLine(state.last_delivery)}`
            : "Nothing sent yet."}
        </p>
        {state.recent.length > 1 ? (
          <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
            {state.recent.map((d) => (
              <li key={d.id}>
                <span className="font-mono">{d.event}</span> · {when(d.created_at)} ·{" "}
                {deliveryLine(d)}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

/** The docs, and a ready curl for one of this workspace's own approved document templates. */
export function ApiQuickstartCard() {
  const { active } = useOrg();
  const orgId = active?.organization.id ?? null;
  const [templates, setTemplates] = useState<Array<{
    name: string;
    language: string;
    paramCount: number;
  }> | null>(null);
  const [picked, setPicked] = useState(0);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    void (async () => {
      const { data } = await aidwar
        .from("message_templates")
        .select("name, language, status, components")
        .eq("organization_id", orgId)
        .eq("status", "APPROVED");
      if (!cancelled)
        setTemplates(
          apiReadyTemplates(
            (data ?? []) as Array<{
              name: string;
              language: string;
              status: string;
              components: unknown;
            }>,
          ),
        );
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const origin = typeof window !== "undefined" ? window.location.origin : "https://aidwar.in";
  const template = templates?.[picked] ?? null;
  const curl = template
    ? curlExample({
        origin,
        templateName: template.name,
        language: template.language,
        paramCount: template.paramCount,
      })
    : null;

  return (
    <section className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm sm:p-8">
      <div className="flex items-start gap-3">
        <BookOpen className="mt-0.5 h-5 w-5 text-primary" aria-hidden="true" />
        <div>
          <h2 className="text-base font-semibold text-foreground">
            Send invoices from your own software
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Your billing software calls AiDwar with the customer's number and the invoice PDF; we
            send it through your approved template, charge it like any message and show it in your
            inbox.{" "}
            <a
              href={DOCS_PATH}
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline nd:underline nd:underline-offset-2"
            >
              Read the API docs
            </a>{" "}
            (templates, replies, contacts, incoming messages, balance) or{" "}
            <a href={POSTMAN_PATH} download className="text-primary hover:underline nd:underline nd:underline-offset-2">
              download the Postman collection
            </a>
            .
          </p>
        </div>
      </div>
      {templates === null ? (
        <Skeleton className="mt-5 h-24 w-full rounded-xl" />
      ) : !template || !curl ? (
        <p className="mt-5 text-sm text-muted-foreground">
          No approved template with a document header yet. In Templates, choose Create template →
          “Invoice or receipt with a PDF”, upload a sample PDF and submit it; once Meta approves it,
          a ready-to-run example appears here.
        </p>
      ) : (
        <div className="mt-5 space-y-2">
          {templates.length > 1 ? (
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label="Template for the example"
            >
              {templates.map((t, i) => (
                <Button
                  key={`${t.name}-${t.language}`}
                  type="button"
                  size="sm"
                  variant={i === picked ? "default" : "outline"}
                  onClick={() => setPicked(i)}
                >
                  {t.name} ({t.language})
                </Button>
              ))}
            </div>
          ) : null}
          <div className="relative">
            <pre tabIndex={0} className="overflow-x-auto rounded-xl border border-border/70 bg-muted/50 p-4 font-mono text-xs leading-relaxed">
              <code>{curl}</code>
            </pre>
            <div className="absolute right-2 top-2">
              <CopyButton value={curl} label="Copy curl example" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Set AIDWAR_API_KEY to a key from below, replace the number, the link and the values, and
            run it.
          </p>
        </div>
      )}
    </section>
  );
}
