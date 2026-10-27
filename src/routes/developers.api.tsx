import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import {
  API_ERRORS,
  IDEMPOTENCY_WINDOW_HOURS,
  MAX_DOCUMENT_MB,
  RATE_PER_KEY_PER_MIN,
  RATE_PER_WORKSPACE_PER_MIN,
  SEND_PATH,
  SIGNATURE_TOLERANCE_SECONDS,
  STATUS_PATH,
  VERIFY_SIGNATURE_EXAMPLE,
  WEBHOOK_BODY_EXAMPLE,
  WEBHOOK_EVENT_NAMES,
  WEBHOOK_RETRY_HOURS,
  WEBHOOK_TIMEOUT_SECONDS,
  curlExample,
  javascriptExample,
  statusCurlExample,
} from "@/lib/public-api";

const TITLE = "Public API — AiDwar";
const DESCRIPTION =
  "Send invoices and other documents on WhatsApp from your own billing software with the AiDwar Public API: authentication, the send call, errors, idempotency, webhooks and rate limits.";
const ORIGIN = "https://aidwar.in";
const EXAMPLE = {
  origin: ORIGIN,
  templateName: "invoice_document",
  language: "en_US",
  paramCount: 3,
};

export const Route = createFileRoute("/developers/api")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
    ],
  }),
  component: ApiDocsPage,
});

function Code({ children, label }: { children: string; label: string }) {
  return (
    <pre
      aria-label={label}
      className="overflow-x-auto rounded-xl border border-border/70 bg-muted/50 p-4 font-mono text-xs leading-relaxed text-foreground"
    >
      <code>{children}</code>
    </pre>
  );
}

function Section({ id, heading, children }: { id: string; heading: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 space-y-3">
      <h2 className="text-xl font-semibold text-foreground">{heading}</h2>
      {children}
    </section>
  );
}

const TOC: Array<[string, string]> = [
  ["authentication", "Authentication"],
  ["send", "Send a document template"],
  ["status", "Message status"],
  ["errors", "Errors"],
  ["idempotency", "Idempotency"],
  ["webhooks", "Webhooks"],
  ["limits", "Rate limits"],
  ["window", "The 24-hour window and pricing"],
];

function ApiDocsPage() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader />
      <main className="mx-auto w-full max-w-4xl flex-1 px-5 py-16 sm:px-8 sm:py-24">
        <p className="text-sm font-medium text-primary">Developers</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">Public API</h1>
        <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground">
          Send an invoice, a receipt or any PDF to a customer on WhatsApp straight from your own
          billing software, POS or Zoho — through your own approved WhatsApp template, from your
          AiDwar number. Every message is charged to your AiDwar wallet like any other send, shows
          up in your inbox (marked “Sent via API”), and you hear back when it is sent, delivered,
          read or failed. The API is part of the Scale plan; ask us to switch it on for any other
          plan.
        </p>
        <nav
          aria-label="On this page"
          className="mt-8 rounded-xl border border-border/70 p-4 text-sm"
        >
          <ol className="grid gap-1 sm:grid-cols-2">
            {TOC.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`} className="text-primary hover:underline">
                  {label}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="mt-12 space-y-12 text-[15px] leading-relaxed text-muted-foreground">
          <Section id="authentication" heading="Authentication">
            <p>
              Create a key in AiDwar under <b>Settings → API &amp; webhooks</b> (owners and admins).
              It is shown once — copy it into your server's secrets. Send it on every call:
            </p>
            <Code label="Authorization header">{"Authorization: Bearer adw_live_…"}</Code>
            <p>
              Keep keys on your server, never in a web page or an app. Revoke a key in the same
              screen and it stops working at once. A missing, wrong or revoked key gets{" "}
              <code>401</code>.
            </p>
          </Section>

          <Section id="send" heading="Send a document template">
            <p>
              <code>
                POST {ORIGIN}
                {SEND_PATH}
              </code>{" "}
              sends one approved template with a <b>document</b> header to one customer. First
              create the template in AiDwar (Templates → Create template → “Invoice or receipt with
              a PDF”), edit the words and submit it — Meta reviews it, usually within minutes. A
              UTILITY template works best.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] text-left text-sm">
                <thead className="text-foreground">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Field</th>
                    <th className="py-2 font-medium">What to send</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/70">
                  <tr>
                    <td className="py-2 pr-4 font-mono">to</td>
                    <td className="py-2">
                      The customer's WhatsApp number with its country code, in any format (+91 98123
                      45678).
                    </td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-mono">template_name</td>
                    <td className="py-2">Your approved template's name.</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-mono">language</td>
                    <td className="py-2">
                      Optional: the template's language code. Needed only when the template is
                      approved in more than one language.
                    </td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-mono">document</td>
                    <td className="py-2">
                      {`{ "url": "https://…" }`} or {`{ "base64": "…" }`}, with{" "}
                      <code>filename</code> (what the customer sees). PDF only, up to{" "}
                      {MAX_DOCUMENT_MB} MB. A link must be a public https address; we download it
                      once, within 15 seconds.
                    </td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-mono">body_params</td>
                    <td className="py-2">
                      The template's {"{{1}}, {{2}}…"} values, in order — exactly as many as it has.
                      No new lines or tabs.
                    </td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-mono">idempotency_key</td>
                    <td className="py-2">
                      Optional but recommended: your own id for this send, e.g. the invoice number
                      (also accepted as an <code>Idempotency-Key</code> header).
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <h3 className="font-semibold text-foreground">curl</h3>
            <Code label="curl example">{curlExample(EXAMPLE)}</Code>
            <h3 className="font-semibold text-foreground">JavaScript (Node 18+)</h3>
            <Code label="JavaScript example">{javascriptExample(EXAMPLE)}</Code>
            <p>
              The answer is <code>202 Accepted</code>:
            </p>
            <Code label="Send response">
              {JSON.stringify(
                {
                  message_id: "6f1c2b0e-3c4d-4f7a-9a51-2f0d8c1e7b42",
                  status: "queued",
                  wamid: "wamid.HBgM…",
                  idempotency_key: "inv-1001",
                },
                null,
                2,
              )}
            </Code>
            <p>
              <code>queued</code> means WhatsApp has the message; you hear <code>message.sent</code>
              , <code>message.delivered</code> and <code>message.read</code> on your webhook as they
              happen. A customer who opted out of your messages is never sent to (<code>409</code>).
            </p>
          </Section>

          <Section id="status" heading="Message status">
            <p>
              <code>
                GET {ORIGIN}
                {STATUS_PATH}
              </code>{" "}
              — the status (<code>queued</code>, <code>sent</code>, <code>delivered</code>,{" "}
              <code>read</code>, <code>failed</code> with its reason) and when each happened. Only
              messages your workspace sent through the API.
            </p>
            <Code label="Status example">{statusCurlExample(ORIGIN)}</Code>
          </Section>

          <Section id="errors" heading="Errors">
            <p>
              Every error is JSON:{" "}
              <code>{`{ "error": "a sentence for people", "code": "a_code_for_programs" }`}</code>.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] text-left text-sm">
                <thead className="text-foreground">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium">Codes</th>
                    <th className="py-2 font-medium">Meaning</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/70 align-top">
                  {API_ERRORS.map((e) => (
                    <tr key={e.status}>
                      <td className="py-2 pr-4 font-mono text-foreground">{e.status}</td>
                      <td className="py-2 pr-4 font-mono text-xs">{e.codes.join(", ")}</td>
                      <td className="py-2">{e.meaning}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section id="idempotency" heading="Idempotency">
            <p>
              Send an <code>idempotency_key</code> (your invoice number is ideal). Repeating a call
              with the same key within {IDEMPOTENCY_WINDOW_HOURS} hours returns the first answer —
              the message is never sent twice, even if two calls arrive at the same moment (the
              second gets <code>409 idempotency_in_progress</code> while the first is still
              sending). The same key with different content is{" "}
              <code>409 idempotency_key_reused</code>. If we refused the first call before sending
              anything (for example <code>402</code>), the key is free: fix it and send again. If
              WhatsApp itself rejected the message, that answer is final for the key; use a new key
              to try again.
            </p>
          </Section>

          <Section id="webhooks" heading="Webhooks">
            <p>
              Set one https address under <b>Settings → API &amp; webhooks</b>. You get a signing
              secret once (rotate it there any time). For every message the API sent we POST JSON
              for{" "}
              {WEBHOOK_EVENT_NAMES.map((e, i) => (
                <span key={e}>
                  {i ? ", " : ""}
                  <code>{e}</code>
                </span>
              ))}
              :
            </p>
            <Code label="Webhook body">{WEBHOOK_BODY_EXAMPLE}</Code>
            <p>
              Each request carries <code>X-AiDwar-Timestamp</code> (unix seconds) and{" "}
              <code>X-AiDwar-Signature: sha256=HMAC-SHA256(secret, timestamp + "." + body)</code> in
              hex. Check it on the raw body and refuse a timestamp more than{" "}
              {SIGNATURE_TOLERANCE_SECONDS / 60} minutes off:
            </p>
            <Code label="Signature check">{VERIFY_SIGNATURE_EXAMPLE}</Code>
            <p>
              Answer any 2xx within {WEBHOOK_TIMEOUT_SECONDS} seconds. Anything else (a timeout, a
              500, a redirect — we never follow one) is retried with growing waits for up to{" "}
              {WEBHOOK_RETRY_HOURS} hours. Events can arrive out of order (a read before a
              delivered); each arrives once per message per event, so use <code>message_id</code>{" "}
              and <code>event</code> to de-duplicate. “Send test event” in Settings sends{" "}
              <code>webhook.test</code> and shows the result.
            </p>
          </Section>

          <Section id="limits" heading="Rate limits">
            <p>
              {RATE_PER_KEY_PER_MIN} requests a minute per key and {RATE_PER_WORKSPACE_PER_MIN} a
              minute per workspace, sends and status reads alike. Over the limit you get{" "}
              <code>429</code> with a <code>Retry-After</code> header (seconds). WhatsApp's own
              limit on how many new customers your number can message a day still applies.
            </p>
          </Section>

          <Section id="window" heading="The 24-hour window and pricing">
            <p>
              Templates can be sent at any time — the 24-hour customer-service window only limits
              free-form replies, not templates. Each delivered template is charged to your AiDwar
              wallet at the rate for its category (utility for an invoice) — see the{" "}
              <Link to="/pricing" className="text-primary hover:underline">
                message credit rates on the pricing page
              </Link>
              . WhatsApp doesn't charge a utility template sent while the customer's 24-hour window
              is open, and neither do we. If the wallet can't cover the message, the call is refused
              with <code>402</code> and nothing is sent.
            </p>
          </Section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
