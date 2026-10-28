import { useEffect, useMemo, useRef, useState } from "react";
import { FlaskConical, Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { callApi } from "@/lib/whatsapp-client";
import { useOrg } from "@/lib/org-context";
import { aidwar } from "@/integrations/aidwar/client";
import { MAX_DOCUMENT_MB, apiReadyTemplates } from "@/lib/public-api";
import {
  CONSOLE_ENDPOINTS,
  CONSOLE_ENDPOINT_IDS,
  consoleEndpointFor,
  isConsoleEndpoint,
  type ConsoleEndpoint,
} from "@/lib/public-api-console";
import { templateVariableSpec, type TemplateComponent } from "@/lib/templates";
import { WhatsAppPhone, type DeliveryStatus } from "@/components/developers/whatsapp-phone";

/**
 * Settings → API & webhooks → Try it (Batch 38 item 7). Fires a REAL call
 * through the same /api/v1 handlers an API key reaches, with a short-lived
 * console credential the server mints and never shows
 * (/api/developer/console): send a template or a free-form message, look a
 * message up, create or list contacts, list templates, check the wallet
 * (CONSOLE_ENDPOINTS). A send shows its cost first and the customer's
 * WhatsApp as it will look (drawn from the template's real parts), then the
 * exact request (curl, credential masked), the full response and the
 * delivery status as it moves. The docs' "Try it" opens it on one endpoint
 * (?try=<spec id>#try-it). The tab itself is only there for owners and
 * admins with public_api on.
 */

type TemplateRow = {
  name: string;
  language: string;
  status: string;
  category: string | null;
  components: unknown;
};
type Quote = {
  ok: boolean;
  error?: string;
  billed?: boolean;
  category?: string;
  rate?: number;
  currency?: string;
  available?: number;
  covers?: boolean;
};
type CallResult = {
  request: { method: string; path: string; curl: string };
  response: { status: number; body: unknown };
};

const TICKS: Record<string, DeliveryStatus> = {
  sent: "sent",
  delivered: "delivered",
  read: "read",
};
const SELECT = "h-9 rounded-md border border-input bg-background px-3 text-sm";
const POLL_MS = 3000;
const POLL_FOR_MS = 2 * 60_000;
const DONE = new Set(["read", "failed"]);

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? "").replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** The endpoint the page was opened on: ?try=<spec id> from the docs, or ?endpoint=<console id>. */
function endpointFromAddress(): ConsoleEndpoint | null {
  if (typeof window === "undefined") return null;
  const q = new URLSearchParams(window.location.search);
  const fromDocs = q.get("try");
  if (fromDocs) return consoleEndpointFor(fromDocs);
  const direct = q.get("endpoint");
  return isConsoleEndpoint(direct) ? direct : null;
}

export function ApiConsoleCard() {
  const { active } = useOrg();
  const orgId = active?.organization.id ?? null;
  const [endpoint, setEndpoint] = useState<ConsoleEndpoint>(
    () => endpointFromAddress() ?? "send_template",
  );
  const [templates, setTemplates] = useState<TemplateRow[] | null>(null);
  const [picked, setPicked] = useState("");
  const [to, setTo] = useState("");
  const [params, setParams] = useState<string[]>([]);
  const [docUrl, setDocUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [messageId, setMessageId] = useState("");
  const [contact, setContact] = useState({ phone: "", name: "", tags: "", optedIn: false });
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CallResult | null>(null);
  const [status, setStatus] = useState<{ status: string; at: string } | null>(null);
  const pollRef = useRef<number | null>(null);
  const sectionRef = useRef<HTMLElement>(null);

  // Opened from the docs' "Try it": bring the console into view.
  useEffect(() => {
    if (endpointFromAddress()) sectionRef.current?.scrollIntoView({ block: "start" });
  }, []);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    void (async () => {
      const { data } = await aidwar
        .from("message_templates")
        .select("name, language, status, category, components")
        .eq("organization_id", orgId)
        .eq("status", "APPROVED");
      if (!cancelled)
        setTemplates(((data ?? []) as TemplateRow[]).sort((a, b) => a.name.localeCompare(b.name)));
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  useEffect(
    () => () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    },
    [],
  );

  const sendable = useMemo(
    () => new Set(apiReadyTemplates(templates ?? []).map((t) => `${t.name}|${t.language}`)),
    [templates],
  );
  const template = templates?.find((t) => `${t.name}|${t.language}` === picked) ?? null;
  const spec = useMemo(
    () =>
      template ? templateVariableSpec((template.components ?? []) as TemplateComponent[]) : null,
    [template],
  );

  useEffect(() => {
    setParams(Array.from({ length: spec?.body.length ?? 0 }, () => ""));
  }, [spec]);

  // The cost, before anything is sent.
  useEffect(() => {
    setQuote(null);
    if (endpoint !== "send_template" || !orgId || !template || to.replace(/\D/g, "").length < 8)
      return;
    const timer = window.setTimeout(async () => {
      const r = await callApi<Quote>("/api/developer/console", {
        body: {
          organization_id: orgId,
          action: "quote",
          template_name: template.name,
          language: template.language,
          to,
        },
      });
      setQuote(r.data ?? { ok: false, error: r.error ?? "We couldn't work out the cost." });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [endpoint, orgId, template, to]);

  const stopPolling = () => {
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = null;
  };

  const callConsole = async (body: Record<string, unknown>): Promise<CallResult | null> => {
    const r = await callApi<CallResult>("/api/developer/console", {
      body: { organization_id: orgId, action: "call", ...body },
    });
    if (r.error || !r.data) {
      toast.error(r.error ?? "The call didn't go through.");
      return null;
    }
    return r.data;
  };

  const poll = (id: string) => {
    stopPolling();
    const started = Date.now();
    pollRef.current = window.setInterval(async () => {
      if (Date.now() - started > POLL_FOR_MS) return stopPolling();
      const r = await callConsole({ endpoint: "message_status", message_id: id });
      const b = (r?.response.body ?? null) as { status?: string; updated_at?: string } | null;
      if (b?.status) setStatus({ status: b.status, at: b.updated_at ?? "" });
      if (!b?.status || DONE.has(b.status)) stopPolling();
    }, POLL_MS);
  };

  /** What this endpoint sends: its body or its filters. */
  const request = async (): Promise<Record<string, unknown> | null> => {
    switch (endpoint) {
      case "message_status":
        return { message_id: messageId.trim() };
      case "send_session":
        return { body: { to, type: "text", text } };
      case "contact_upsert": {
        const tags = contact.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        return {
          body: {
            phone: contact.phone,
            ...(contact.name.trim() ? { name: contact.name.trim() } : {}),
            ...(tags.length ? { tags } : {}),
            ...(contact.optedIn ? { opted_in: true } : {}),
          },
        };
      }
      case "contacts_list":
      case "templates_list":
      case "account_balance":
        return { query: filters };
      case "send_template": {
        if (!template) return null;
        let document: Record<string, string> | undefined;
        if (spec?.headerMedia?.format === "DOCUMENT") {
          if (file) {
            if (file.size > MAX_DOCUMENT_MB * 1024 * 1024) {
              toast.error(`The file is larger than ${MAX_DOCUMENT_MB} MB.`);
              return null;
            }
            document = { base64: await readAsBase64(file), filename: file.name };
          } else if (docUrl.trim()) {
            document = {
              url: docUrl.trim(),
              filename: docUrl.trim().split("/").pop() || "document.pdf",
            };
          }
        }
        return {
          body: {
            to,
            template_name: template.name,
            language: template.language,
            ...(document ? { document } : {}),
            body_params: params,
          },
        };
      }
    }
  };

  const run = async () => {
    if (!orgId) return;
    stopPolling();
    setStatus(null);
    setBusy(true);
    try {
      const input = await request();
      if (!input) return;
      const res = await callConsole({ endpoint, ...input });
      setResult(res);
      const id = (res?.response.body as { message_id?: string } | null)?.message_id;
      if (
        (endpoint === "send_template" || endpoint === "send_session") &&
        res?.response.status === 202 &&
        id
      ) {
        setMessageId(id);
        setStatus({ status: "queued", at: "" });
        poll(id);
      }
    } finally {
      setBusy(false);
    }
  };

  const phoneOk = (v: string) => v.replace(/\D/g, "").length >= 8;
  const canSend = (() => {
    switch (endpoint) {
      case "message_status":
        return Boolean(messageId.trim());
      case "send_session":
        return phoneOk(to) && Boolean(text.trim());
      case "contact_upsert":
        return phoneOk(contact.phone);
      case "contacts_list":
      case "templates_list":
      case "account_balance":
        return true;
      case "send_template":
        return Boolean(
          template &&
          sendable.has(picked) &&
          to.trim() &&
          params.every((v) => v.trim()) &&
          (spec?.headerMedia?.format !== "DOCUMENT" || file || /^https:\/\//i.test(docUrl.trim())),
        );
    }
  })();

  const ACTION: Record<ConsoleEndpoint, string> = {
    send_template: "Send",
    send_session: "Send",
    message_status: "Get status",
    contact_upsert: "Save contact",
    contacts_list: "List contacts",
    templates_list: "List templates",
    account_balance: "Check balance",
  };
  const isSend = endpoint === "send_template" || endpoint === "send_session";
  const filter = (k: string) => filters[k] ?? "";
  const setFilter = (k: string, v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const ticks: DeliveryStatus = status ? (TICKS[status.status] ?? "pending") : "pending";

  const preview =
    endpoint === "send_template" && template ? (
      <WhatsAppPhone
        compact
        status={result && status ? ticks : null}
        message={{
          kind: "template",
          components: (template.components ?? []) as Array<Record<string, unknown>>,
          params: params.map((v, i) => v.trim() || `{{${spec?.body[i] ?? i + 1}}}`),
          ...(file
            ? { fileName: file.name }
            : docUrl.trim()
              ? { fileName: docUrl.trim().split("/").pop() || "document.pdf" }
              : {}),
        }}
      />
    ) : endpoint === "send_session" && text.trim() ? (
      <WhatsAppPhone
        compact
        status={result && status ? ticks : null}
        message={{ kind: "text", text }}
      />
    ) : null;

  return (
    <section
      id="try-it"
      ref={sectionRef}
      className="scroll-mt-24 rounded-2xl border border-border/70 bg-card p-6 shadow-sm sm:p-8"
    >
      <div className="flex items-start gap-3">
        <FlaskConical className="mt-0.5 h-5 w-5 text-primary" aria-hidden="true" />
        <div>
          <h2 className="text-base font-semibold text-foreground">Try it</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Make a real API call from here — it goes through the same API your software uses, is
            charged like any API message and shows in your inbox as sent via the API. No API key
            needed: AiDwar uses a 10-minute console session that never leaves our servers.
          </p>
        </div>
      </div>

      <div className={`mt-5 grid gap-6 ${isSend ? "md:grid-cols-[minmax(0,1fr)_auto]" : ""}`}>
        <div className="grid content-start gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="console-endpoint">Endpoint</Label>
            <select
              id="console-endpoint"
              className={SELECT}
              value={endpoint}
              onChange={(e) => {
                setEndpoint(e.target.value as ConsoleEndpoint);
                setResult(null);
                setStatus(null);
                stopPolling();
              }}
            >
              {CONSOLE_ENDPOINT_IDS.map((id) => (
                <option key={id} value={id}>
                  {CONSOLE_ENDPOINTS[id].method} {CONSOLE_ENDPOINTS[id].path} —{" "}
                  {CONSOLE_ENDPOINTS[id].label.toLowerCase()}
                </option>
              ))}
            </select>
          </div>

          {endpoint === "send_template" ? (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="console-template">Approved template</Label>
                <select
                  id="console-template"
                  className={SELECT}
                  value={picked}
                  onChange={(e) => setPicked(e.target.value)}
                >
                  <option value="">{templates === null ? "Loading…" : "Pick a template"}</option>
                  {(templates ?? []).map((t) => {
                    const key = `${t.name}|${t.language}`;
                    return (
                      <option key={key} value={key} disabled={!sendable.has(key)}>
                        {t.name} ({t.language})
                        {sendable.has(key) ? "" : " — not sendable from the API yet"}
                      </option>
                    );
                  })}
                </select>
              </div>

              {spec?.headerMedia?.format === "DOCUMENT" ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="console-file">Document (PDF, up to {MAX_DOCUMENT_MB} MB)</Label>
                  <Input
                    id="console-file"
                    type="file"
                    accept="application/pdf"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                  <Input
                    placeholder="…or paste an https:// link to the PDF"
                    aria-label="Link to the PDF"
                    value={docUrl}
                    disabled={Boolean(file)}
                    onChange={(e) => setDocUrl(e.target.value)}
                  />
                </div>
              ) : null}

              {params.map((v, i) => (
                <div key={i} className="grid gap-1.5">
                  <Label htmlFor={`console-param-${i}`}>
                    Body value {`{{${spec?.body[i] ?? i + 1}}}`}
                  </Label>
                  <Input
                    id={`console-param-${i}`}
                    value={v}
                    onChange={(e) =>
                      setParams((p) => p.map((x, j) => (j === i ? e.target.value : x)))
                    }
                  />
                </div>
              ))}

              {spec && (spec.urlButtons.length || spec.copyCodeButtons.length) ? (
                <p className="text-xs text-muted-foreground">
                  This template has buttons that need values; the console can't fill them yet.
                </p>
              ) : null}
            </>
          ) : null}

          {isSend ? (
            <div className="grid gap-1.5">
              <Label htmlFor="console-to">Test phone (with country code)</Label>
              <Input
                id="console-to"
                placeholder="+919812345678"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          ) : null}

          {endpoint === "send_session" ? (
            <div className="grid gap-1.5">
              <Label htmlFor="console-text">Message</Label>
              <textarea
                id="console-text"
                rows={4}
                className="rounded-md border border-input bg-background px-3 py-2 text-sm"
                placeholder="Hi *Asha*, your order has shipped."
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Reaches only a customer who wrote to you in the last 24 hours; otherwise the answer
                is 409 window_closed and nothing is sent. *bold* _italic_ ~strike~ work as on
                WhatsApp.
              </p>
            </div>
          ) : null}

          {endpoint === "send_template" && quote ? (
            <p className="text-sm" role="status">
              {quote.ok
                ? quote.billed
                  ? `Cost: ${quote.currency} ${Number(quote.rate ?? 0).toFixed(2)} (${quote.category}) — ${quote.covers ? `${quote.currency} ${Number(quote.available ?? 0).toFixed(2)} available` : "not enough credits"}.`
                  : `Not charged: billing is off for this workspace (${quote.category}).`
                : quote.error}
            </p>
          ) : null}

          {endpoint === "message_status" ? (
            <div className="grid gap-1.5">
              <Label htmlFor="console-message">message_id</Label>
              <Input
                id="console-message"
                value={messageId}
                onChange={(e) => setMessageId(e.target.value)}
              />
            </div>
          ) : null}

          {endpoint === "contact_upsert" ? (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="console-contact-phone">Phone (with country code)</Label>
                <Input
                  id="console-contact-phone"
                  placeholder="+919812345678"
                  value={contact.phone}
                  onChange={(e) => setContact((c) => ({ ...c, phone: e.target.value }))}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="console-contact-name">Name</Label>
                <Input
                  id="console-contact-name"
                  value={contact.name}
                  onChange={(e) => setContact((c) => ({ ...c, name: e.target.value }))}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="console-contact-tags">Tags (comma-separated)</Label>
                <Input
                  id="console-contact-tags"
                  placeholder="vip, returning"
                  value={contact.tags}
                  onChange={(e) => setContact((c) => ({ ...c, tags: e.target.value }))}
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={contact.optedIn}
                  onChange={(e) => setContact((c) => ({ ...c, optedIn: e.target.checked }))}
                />
                The customer agreed to hear from you (opted_in). It never undoes an opt-out.
              </label>
            </>
          ) : null}

          {endpoint === "contacts_list" ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="grid gap-1.5">
                <Label htmlFor="console-f-tag">Tag</Label>
                <Input
                  id="console-f-tag"
                  value={filter("tag")}
                  onChange={(e) => setFilter("tag", e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="console-f-optin">Consent</Label>
                <select
                  id="console-f-optin"
                  className={SELECT}
                  value={filter("opt_in")}
                  onChange={(e) => setFilter("opt_in", e.target.value)}
                >
                  <option value="">Any</option>
                  <option value="opted_in">opted_in</option>
                  <option value="opted_out">opted_out</option>
                  <option value="unknown">unknown</option>
                </select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="console-f-limit">Limit</Label>
                <Input
                  id="console-f-limit"
                  inputMode="numeric"
                  placeholder="50"
                  value={filter("limit")}
                  onChange={(e) => setFilter("limit", e.target.value)}
                />
              </div>
            </div>
          ) : null}

          {endpoint === "templates_list" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="console-f-status">Status</Label>
                <select
                  id="console-f-status"
                  className={SELECT}
                  value={filter("status")}
                  onChange={(e) => setFilter("status", e.target.value)}
                >
                  <option value="">Any</option>
                  {["APPROVED", "PENDING", "REJECTED", "PAUSED"].map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="console-f-category">Category</Label>
                <select
                  id="console-f-category"
                  className={SELECT}
                  value={filter("category")}
                  onChange={(e) => setFilter("category", e.target.value)}
                >
                  <option value="">Any</option>
                  {["UTILITY", "MARKETING", "AUTHENTICATION"].map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : null}

          {endpoint === "account_balance" ? (
            <div className="grid gap-1.5">
              <Label htmlFor="console-f-country">
                Prices for a country (two letters) — optional
              </Label>
              <Input
                id="console-f-country"
                placeholder="IN"
                maxLength={2}
                value={filter("country")}
                onChange={(e) => setFilter("country", e.target.value.toUpperCase())}
              />
            </div>
          ) : null}

          <div>
            <Button
              type="button"
              onClick={() => void run()}
              disabled={
                !canSend || busy || (endpoint === "send_template" && quote?.covers === false)
              }
            >
              {busy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Send className="mr-2 h-4 w-4" />
              )}
              {ACTION[endpoint]}
            </Button>
          </div>
        </div>

        {isSend ? (
          <div className="flex flex-col items-center gap-2">
            {preview ?? (
              <p className="max-w-[18rem] pt-2 text-center text-xs text-muted-foreground">
                {endpoint === "send_template"
                  ? "Pick a template to see it as your customer will."
                  : "Type a message to see it as your customer will."}
              </p>
            )}
            {preview ? (
              <p className="text-xs text-muted-foreground">What your customer sees</p>
            ) : null}
          </div>
        ) : null}
      </div>

      {result ? (
        <div className="mt-6 grid gap-3">
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">Request</p>
            <pre className="max-h-72 overflow-auto rounded-lg bg-muted p-3 text-xs">
              {result.request.curl}
            </pre>
          </div>
          <div>
            <p className="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground">
              Response{" "}
              <Badge variant={result.response.status < 300 ? "secondary" : "destructive"}>
                {result.response.status}
              </Badge>
            </p>
            <pre className="max-h-72 overflow-auto rounded-lg bg-muted p-3 text-xs">
              {JSON.stringify(result.response.body, null, 2)}
            </pre>
          </div>
          {status ? (
            <p className="text-sm" role="status">
              Status: <strong>{status.status}</strong>
              {pollRef.current ? " — checking every few seconds…" : ""}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
