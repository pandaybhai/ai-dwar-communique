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
import { MAX_DOCUMENT_MB, SEND_PATH, STATUS_PATH, apiReadyTemplates } from "@/lib/public-api";
import { templateVariableSpec, type TemplateComponent } from "@/lib/templates";

/**
 * Settings → API & webhooks → Try it (Batch 38 item 7). Fires a REAL call
 * through the same /api/v1 handlers an API key reaches, with a short-lived
 * console credential the server mints and never shows
 * (/api/developer/console). Shows the cost first, then the exact request
 * (curl, credential masked) and the full response, then polls the status.
 * The tab itself is only there for owners and admins with public_api on.
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

export function ApiConsoleCard() {
  const { active } = useOrg();
  const orgId = active?.organization.id ?? null;
  const [endpoint, setEndpoint] = useState<"send_template" | "message_status">("send_template");
  const [templates, setTemplates] = useState<TemplateRow[] | null>(null);
  const [picked, setPicked] = useState("");
  const [to, setTo] = useState("");
  const [params, setParams] = useState<string[]>([]);
  const [docUrl, setDocUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [messageId, setMessageId] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CallResult | null>(null);
  const [status, setStatus] = useState<{ status: string; at: string } | null>(null);
  const pollRef = useRef<number | null>(null);

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
    if (!orgId || !template || to.replace(/\D/g, "").length < 8) return;
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
  }, [orgId, template, to]);

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

  const run = async () => {
    if (!orgId) return;
    stopPolling();
    setStatus(null);
    setBusy(true);
    try {
      if (endpoint === "message_status") {
        setResult(await callConsole({ endpoint, message_id: messageId.trim() }));
        return;
      }
      if (!template) return;
      let document: Record<string, string> | undefined;
      if (spec?.headerMedia?.format === "DOCUMENT") {
        if (file) {
          if (file.size > MAX_DOCUMENT_MB * 1024 * 1024) {
            toast.error(`The file is larger than ${MAX_DOCUMENT_MB} MB.`);
            return;
          }
          document = { base64: await readAsBase64(file), filename: file.name };
        } else if (docUrl.trim()) {
          document = {
            url: docUrl.trim(),
            filename: docUrl.trim().split("/").pop() || "document.pdf",
          };
        }
      }
      const res = await callConsole({
        endpoint,
        body: {
          to,
          template_name: template.name,
          language: template.language,
          ...(document ? { document } : {}),
          body_params: params,
        },
      });
      setResult(res);
      const id = (res?.response.body as { message_id?: string } | null)?.message_id;
      if (res && res.response.status === 202 && id) {
        setMessageId(id);
        setStatus({ status: "queued", at: "" });
        poll(id);
      }
    } finally {
      setBusy(false);
    }
  };

  const canSend =
    endpoint === "message_status"
      ? Boolean(messageId.trim())
      : Boolean(
          template &&
          sendable.has(picked) &&
          to.trim() &&
          params.every((v) => v.trim()) &&
          (spec?.headerMedia?.format !== "DOCUMENT" || file || /^https:\/\//i.test(docUrl.trim())),
        );

  return (
    <section className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm sm:p-8">
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

      <div className="mt-5 grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="console-endpoint">Endpoint</Label>
          <select
            id="console-endpoint"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value as typeof endpoint)}
          >
            <option value="send_template">POST {SEND_PATH} — send a template</option>
            <option value="message_status">GET {STATUS_PATH} — a message's status</option>
          </select>
        </div>

        {endpoint === "send_template" ? (
          <>
            <div className="grid gap-1.5">
              <Label htmlFor="console-template">Approved template</Label>
              <select
                id="console-template"
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
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

            <div className="grid gap-1.5">
              <Label htmlFor="console-to">Test phone (with country code)</Label>
              <Input
                id="console-to"
                placeholder="+919812345678"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>

            {quote ? (
              <p className="text-sm" role="status">
                {quote.ok
                  ? quote.billed
                    ? `Cost: ${quote.currency} ${Number(quote.rate ?? 0).toFixed(2)} (${quote.category}) — ${quote.covers ? `${quote.currency} ${Number(quote.available ?? 0).toFixed(2)} available` : "not enough credits"}.`
                    : `Not charged: billing is off for this workspace (${quote.category}).`
                  : quote.error}
              </p>
            ) : null}
          </>
        ) : (
          <div className="grid gap-1.5">
            <Label htmlFor="console-message">message_id</Label>
            <Input
              id="console-message"
              value={messageId}
              onChange={(e) => setMessageId(e.target.value)}
            />
          </div>
        )}

        <div>
          <Button
            type="button"
            onClick={() => void run()}
            disabled={!canSend || busy || (endpoint === "send_template" && quote?.covers === false)}
          >
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Send className="mr-2 h-4 w-4" />
            )}
            {endpoint === "send_template" ? "Send" : "Get status"}
          </Button>
        </div>

        {result ? (
          <div className="grid gap-3">
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
      </div>
    </section>
  );
}
