/**
 * Batch 38 item 9: the developer portal's content — every page under
 * /developers, its sidebar, its search index and its Markdown — built from
 * the one description of the API (public-api-spec.ts), the plan table
 * (public-api-plans.ts) and the API's own constants (public-api.ts). The
 * React pages render these blocks; "Copy page as Markdown", llms.txt and
 * llms-full.txt serialise the very same blocks, so the docs, Postman,
 * OpenAPI and the AI-tool copies can't drift. Pure: no server code, no React.
 *
 * Public words only: nothing here may name an internal batch, the database
 * vendor or an app id (developer-portal.test.ts scans every page for them).
 */
import {
  API_ERRORS,
  API_ORIGIN,
  IDEMPOTENCY_WINDOW_HOURS,
  MAX_DOCUMENT_MB,
  RATE_PER_KEY_PER_MIN,
  RATE_PER_WORKSPACE_PER_MIN,
  SIGNATURE_TOLERANCE_SECONDS,
  VERIFY_SIGNATURE_EXAMPLE,
  WEBHOOK_RETRY_HOURS,
  WEBHOOK_TIMEOUT_SECONDS,
} from "@/lib/public-api";
import { MAX_CC } from "@/lib/public-api-cc";
import {
  API_ENDPOINTS,
  POSTMAN_PATH,
  SAMPLE_LABELS,
  SAMPLE_LANGUAGES,
  WEBHOOK_EVENTS,
  errorRow,
  prettyJson,
  sampleFor,
  type ApiEndpoint,
  type SampleLanguage,
  type WebhookEventSpec,
} from "@/lib/public-api-spec";
import {
  API_PLANS,
  PLAN_AVAILABILITY,
  PLAN_LABELS,
  endpointFor,
  eventFor,
  type Availability,
} from "@/lib/public-api-plans";
import { OPENAPI_PATH } from "@/lib/public-api-openapi";

export const DOCS_ROOT = "/developers";
export const LLMS_PATH = "/llms.txt";
export const LLMS_FULL_PATH = "/llms-full.txt";

// ------------------------------------------------------------ the model

/** Text with `code`, **bold** and [links](/path). */
export type Inline = string;

export type Sample = {
  lang: SampleLanguage | "json" | "bash" | "go" | "text";
  label: string;
  code: string;
};
/** What the right-hand code panel shows while a section is in view. */
export type CodeGroup = { title: string; samples: Sample[]; status?: number };

export type Block =
  | { kind: "p"; text: Inline }
  | { kind: "h3"; id: string; text: string }
  | { kind: "list"; items: Inline[]; ordered?: boolean }
  | { kind: "table"; head: string[]; rows: Inline[][] }
  | { kind: "callout"; tone: "info" | "warn" | "success"; title: string; text: Inline }
  | { kind: "code"; group: CodeGroup }
  | {
      kind: "cards";
      cards: Array<{
        title: string;
        text: Inline;
        href: string;
        icon: "invoice" | "chat" | "users" | "book" | "bolt" | "webhook";
      }>;
    }
  | { kind: "steps"; steps: Array<{ title: string; text: Inline; success: Inline }> }
  | { kind: "window" }
  | { kind: "params"; endpointId: string }
  | { kind: "errors"; endpointId?: string; status?: string }
  | { kind: "payload"; event: string }
  | { kind: "preview"; endpointId: string }
  | { kind: "links"; items: Array<{ label: string; href: string; method?: string }> };

export type Section = {
  id: string;
  title?: string;
  blocks: Block[];
  code?: CodeGroup;
  /** Shown under `code` on wide screens: a request's answer beside it, as the best API docs do. */
  aside?: CodeGroup;
};

export type PageKind = "overview" | "guide" | "reference" | "event" | "concept" | "index";

export type Page = {
  id: string;
  path: string;
  kind: PageKind;
  title: string;
  /** The sidebar's shorter label. */
  nav: string;
  /** Meta description and search snippet. */
  description: string;
  eyebrow?: string;
  sections: Section[];
  /** For reference pages. */
  endpoint?: ApiEndpoint;
  event?: WebhookEventSpec;
};

// ------------------------------------------------------------ helpers

const code = (lang: Sample["lang"], label: string, text: string): Sample => ({
  lang,
  label,
  code: text,
});

/** The four request languages for one endpoint and body. */
export function requestSamples(
  e: ApiEndpoint,
  body: Record<string, unknown> | undefined = e.body,
): Sample[] {
  return SAMPLE_LANGUAGES.map((lang) => code(lang, SAMPLE_LABELS[lang], sampleFor(lang, e, body)));
}

const endpoint = (id: string): ApiEndpoint => {
  const e = API_ENDPOINTS.find((x) => x.id === id);
  if (!e) throw new Error(`no endpoint ${id}`);
  return e;
};

const json = (value: unknown) => (typeof value === "string" ? value : prettyJson(value));

export const referencePath = (id: string) => `${DOCS_ROOT}/reference/${id}`;
export const eventPath = (name: string) => `${DOCS_ROOT}/webhooks/${name}`;
export const guidePath = (slug: string) => `${DOCS_ROOT}/guides/${slug}`;

const ref = (id: string) => {
  const e = endpoint(id);
  return `[${e.title}](${referencePath(id)})`;
};

/** The plans a row of the plan table names, in words. */
export function planWords(row: Availability | null): string {
  const plans = row?.plans ?? [...API_PLANS];
  return plans.map((p) => PLAN_LABELS[p]).join(" and ");
}

export function endpointPlans(e: ApiEndpoint): string {
  return planWords(endpointFor(e.method, e.path.replace(/\{(\w+)\}/g, "x1")));
}

// ------------------------------------------------------------ signature checks, in four languages

export const VERIFY_SAMPLES: Sample[] = [
  code("node", "Node.js", VERIFY_SIGNATURE_EXAMPLE),
  code(
    "python",
    "Python",
    `import hashlib
import hmac
import time

# raw_body: the request body exactly as received (bytes), before any JSON parsing.
def is_from_aidwar(raw_body: bytes, headers, secret: str) -> bool:
    timestamp = headers.get("X-AiDwar-Timestamp", "")
    signature = headers.get("X-AiDwar-Signature", "")
    # Refuse old or future deliveries (replays).
    if not timestamp or abs(time.time() - int(timestamp)) > ${SIGNATURE_TOLERANCE_SECONDS}:
        return False
    signed = timestamp.encode() + b"." + raw_body
    expected = "sha256=" + hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature, expected)`,
  ),
  code(
    "php",
    "PHP",
    `<?php
// $rawBody: file_get_contents("php://input"), before any JSON parsing.
function isFromAiDwar(string $rawBody, array $headers, string $secret): bool
{
    $timestamp = $headers["X-AiDwar-Timestamp"] ?? "";
    $signature = $headers["X-AiDwar-Signature"] ?? "";
    // Refuse old or future deliveries (replays).
    if ($timestamp === "" || abs(time() - (int) $timestamp) > ${SIGNATURE_TOLERANCE_SECONDS}) {
        return false;
    }
    $expected = "sha256=" . hash_hmac("sha256", $timestamp . "." . $rawBody, $secret);
    return hash_equals($expected, $signature);
}`,
  ),
  code(
    "go",
    "Go",
    `package webhooks

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"math"
	"net/http"
	"strconv"
	"time"
)

// IsFromAiDwar checks a delivery. rawBody is the request body exactly as received.
func IsFromAiDwar(rawBody []byte, h http.Header, secret string) bool {
	timestamp := h.Get("X-AiDwar-Timestamp")
	ts, err := strconv.ParseInt(timestamp, 10, 64)
	// Refuse old or future deliveries (replays).
	if err != nil || math.Abs(float64(time.Now().Unix()-ts)) > ${SIGNATURE_TOLERANCE_SECONDS} {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp + "."))
	mac.Write(rawBody)
	expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(h.Get("X-AiDwar-Signature")))
}`,
  ),
];

// ------------------------------------------------------------ demo templates (the WhatsApp previews)

/** Templates the previews render, as WhatsApp stores them (the same shape as your own). */
export const DEMO_TEMPLATES: Record<
  string,
  {
    label: string;
    category: string;
    components: Array<Record<string, unknown>>;
    params: string[];
    fileName?: string;
  }
> = {
  invoice_document: {
    label: "Invoice with a PDF",
    category: "UTILITY",
    components: [
      { type: "HEADER", format: "DOCUMENT" },
      {
        type: "BODY",
        text: "Hi {{1}}, your invoice *{{2}}* for {{3}} is attached. Thank you for shopping with us!",
      },
      { type: "FOOTER", text: "Reply STOP to opt out" },
    ],
    params: ["Asha", "INV-1001", "₹2,500.00"],
    fileName: "INV-1001.pdf",
  },
  order_shipped: {
    label: "Order shipped",
    category: "UTILITY",
    components: [
      { type: "HEADER", format: "IMAGE" },
      {
        type: "BODY",
        text: "Hi {{1}}, your order *{{2}}* is on its way 🚚\n_Tap below to follow it._",
      },
      { type: "FOOTER", text: "Track it any time" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "URL", text: "Track order", url: "https://shop.example.com/track/{{1}}" },
        ],
      },
    ],
    params: ["Asha", "#1042"],
  },
  festive_offer: {
    label: "Festive offer",
    category: "MARKETING",
    components: [
      { type: "HEADER", format: "TEXT", text: "Diwali sale ✨" },
      {
        type: "BODY",
        text: "Hi {{1}}, enjoy *{{2}} off* everything until {{3}}. ~Full price~ never again!",
      },
      { type: "FOOTER", text: "Reply STOP to opt out" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "COPY_CODE", text: "Copy code", example: "DIWALI20" },
          { type: "QUICK_REPLY", text: "Not interested" },
        ],
      },
    ],
    params: ["Asha", "20%", "Sunday"],
  },
};

/** The template a send endpoint's preview shows, and the values its example fills. */
export function previewFor(e: ApiEndpoint):
  | {
      kind: "template";
      components: Array<Record<string, unknown>>;
      params: string[];
      fileName?: string;
    }
  | { kind: "text"; text: string }
  | null {
  const body = (e.body ?? {}) as Record<string, unknown>;
  if (e.id === "send-template") {
    const t = DEMO_TEMPLATES["order_shipped"]!;
    return {
      kind: "template",
      components: t.components,
      params: (body["body_params"] as string[]) ?? t.params,
    };
  }
  if (e.id === "send-session") return { kind: "text", text: String(body["text"] ?? "") };
  if (e.id === "campaign-create") {
    const t = DEMO_TEMPLATES["festive_offer"]!;
    const first = ((body["audience"] as { phones?: Array<{ variables?: string[] }> })?.phones ??
      [])[0];
    return {
      kind: "template",
      components: t.components,
      params: [...(first?.variables ?? t.params), "Sunday"],
    };
  }
  return null;
}

// ------------------------------------------------------------ pages

const ORIGIN = API_ORIGIN;
const BASE_URL = `${ORIGIN}/api/v1`;

function overviewPage(): Page {
  return {
    id: "overview",
    path: DOCS_ROOT,
    kind: "overview",
    title: "AiDwar API",
    nav: "Overview",
    eyebrow: "Developers",
    description:
      "Send WhatsApp invoices and notifications, chat with customers and run campaigns from your own software. Plain-language docs, copy-paste examples and a test console.",
    sections: [
      {
        id: "what-you-can-do",
        title: "What you can do",
        blocks: [
          {
            kind: "cards",
            cards: [
              {
                title: "Send invoices & notifications",
                text: "Your billing or order system sends an approved WhatsApp template — with the invoice PDF attached — the moment it is ready.",
                href: guidePath("send-an-invoice-pdf"),
                icon: "invoice",
              },
              {
                title: "Two-way WhatsApp chat",
                text: "Hear every customer message on your webhook and reply in your own words while their 24-hour window is open.",
                href: guidePath("receive-customer-replies"),
                icon: "chat",
              },
              {
                title: "Contacts & campaigns",
                text: "Keep contacts and consent in sync, then launch campaigns to a tag, a segment or your own list — with the cost checked first.",
                href: guidePath("import-contacts-with-consent"),
                icon: "users",
              },
            ],
          },
        ],
      },
      {
        id: "who-its-for",
        title: "Who it's for",
        blocks: [
          {
            kind: "p",
            text: "Businesses that already run their own software — a billing tool, a shop, a CRM, an ERP — and want WhatsApp to be part of it. You (or your developer) call a simple HTTPS API with a key; AiDwar handles WhatsApp, templates, consent, delivery and the bill.",
          },
          {
            kind: "list",
            items: [
              "**No WhatsApp setup of your own:** messages leave from the number you already connected in AiDwar.",
              "**Everything shows in your inbox:** your team sees every API message next to the chats, marked *Sent via API*.",
              "**Safe by default:** opt-outs are respected, a request can never be sent twice, and your wallet is checked before anything goes out.",
            ],
          },
        ],
      },
      {
        id: "plan",
        title: "Plan needed",
        blocks: [
          {
            kind: "p",
            text: `The API is part of the **${API_PLANS.map((p) => PLAN_LABELS[p]).join("** and **")}** plans. [See every endpoint and event by plan](${DOCS_ROOT}/plans).`,
          },
        ],
      },
      {
        id: "pricing",
        title: "What a message costs",
        blocks: [
          {
            kind: "p",
            text:
              "Messages are paid from your AiDwar wallet at the same rate as messages from the app — no extra charge for using the API. Prices depend on the kind of message; your exact rate is always in Billing and in [Wallet balance and prices](" +
              referencePath("account-balance") +
              "); see the message credit rates on the pricing page, [aidwar.in/pricing](/pricing).",
          },
        ],
      },
      {
        id: "start",
        title: "Start",
        blocks: [
          {
            kind: "links",
            items: [
              {
                label: "Quickstart: your first WhatsApp invoice in 5 minutes",
                href: `${DOCS_ROOT}/quickstart`,
              },
              { label: "API reference", href: `${DOCS_ROOT}/reference` },
              { label: "Webhooks", href: `${DOCS_ROOT}/webhooks` },
              { label: "Errors, in plain words", href: `${DOCS_ROOT}/errors` },
              { label: "What's new", href: `${DOCS_ROOT}/changelog` },
            ],
          },
          {
            kind: "p",
            text: `Downloads, generated from the same description as these pages: the [Postman collection](${POSTMAN_PATH}), the [OpenAPI 3.1 file](${OPENAPI_PATH}) and [llms.txt](${LLMS_PATH}) for AI coding tools.`,
          },
        ],
      },
    ],
  };
}

function quickstartPage(): Page {
  const send = endpoint("send-template");
  const invoiceBody = send.more?.[0]?.body ?? send.body;
  const test = endpoint("webhook-test");
  return {
    id: "quickstart",
    path: `${DOCS_ROOT}/quickstart`,
    kind: "guide",
    eyebrow: "Get started",
    title: "Send your first WhatsApp invoice in 5 minutes",
    nav: "Quickstart",
    description:
      "Create an API key, get an invoice template approved, send your first message and receive delivery updates on your webhook — four steps, with what success looks like at each.",
    sections: [
      {
        id: "before-you-start",
        blocks: [
          {
            kind: "p",
            text: "You need an AiDwar workspace with WhatsApp connected and the API switched on (it is part of the Scale and Enterprise plans). Every step below says what success looks like, so you always know you're on track.",
          },
        ],
      },
      {
        id: "step-1",
        title: "1. Create an API key",
        blocks: [
          {
            kind: "steps",
            steps: [
              {
                title: "In AiDwar, open Settings → API & webhooks → API keys",
                text: "Give the key a name (say, *Billing*) and press **Create key**. Copy it straight away into your server's environment as `AIDWAR_API_KEY` — it is shown only once. Keys belong on your server, never in a web page or an app.",
                success:
                  "You see the key once, starting with `adw_live_`, and it appears in the list with its first few characters.",
              },
            ],
          },
        ],
        code: {
          title: "Keep the key in your environment",
          samples: [code("bash", "Shell", 'export AIDWAR_API_KEY="adw_live_…"')],
        },
      },
      {
        id: "step-2",
        title: "2. Get an invoice template approved",
        blocks: [
          {
            kind: "steps",
            steps: [
              {
                title: "Templates → Create a template → Start from: Invoice or receipt with a PDF",
                text: "The starter fills in a utility template with a document header and three values: the customer's name, the invoice number and the amount. Edit the words if you like, upload a sample PDF (WhatsApp reviews it with the template) and submit.",
                success:
                  "The template's status turns **Approved** — usually within minutes, sometimes a few hours.",
              },
            ],
          },
        ],
        code: {
          title: "The starter's text",
          samples: [
            code(
              "text",
              "Template",
              "Hi {{1}}, your invoice {{2}} for {{3}} is attached. Thank you.",
            ),
          ],
        },
      },
      {
        id: "step-3",
        title: "3. Send the first message",
        blocks: [
          {
            kind: "steps",
            steps: [
              {
                title: "Call Send a template with your own number",
                text: `Use the template's name, your own WhatsApp number and a PDF link (or the PDF itself as base64, up to ${MAX_DOCUMENT_MB} MB). The idempotency key makes a retry safe: the same key is never sent twice.`,
                success:
                  "The answer is **202 Accepted** with a `message_id`, and the invoice arrives on your phone a few seconds later.",
              },
            ],
          },
          {
            kind: "callout",
            tone: "info",
            title: "Try it without writing code",
            text: "Settings → API & webhooks → **Try it** sends a real message through the same API from your browser, shows the cost first and follows the delivery.",
          },
        ],
        code: {
          title: "Send the invoice",
          samples: requestSamples(send, invoiceBody as Record<string, unknown>),
        },
      },
      {
        id: "step-3-answer",
        title: "What comes back",
        blocks: [
          {
            kind: "p",
            text: "Keep the `message_id`: it is how you look the message up, and every webhook event about it carries it.",
          },
        ],
        code: {
          title: "202 Accepted",
          status: 202,
          samples: [code("json", "Response", json(send.response.body))],
        },
      },
      {
        id: "step-4",
        title: "4. Receive delivery updates on a webhook",
        blocks: [
          {
            kind: "steps",
            steps: [
              {
                title: "Settings → API & webhooks → Webhooks: add your https address",
                text: `Pick the events (or every event), copy the signing secret and press **Send test event**. Your server should answer any 2xx within ${WEBHOOK_TIMEOUT_SECONDS} seconds and check the signature — see [Verify webhook signatures](${guidePath("verify-webhook-signatures")}).`,
                success:
                  "The test shows *Delivered (HTTP 200)*, and from now on you get `message.sent`, `message.delivered` and `message.read` for every message.",
              },
            ],
          },
          {
            kind: "p",
            text: `You can also add and test webhooks from code: ${ref("webhook-create")} and ${ref("webhook-test")}.`,
          },
        ],
        code: {
          title: "A delivery update",
          samples: [
            code(
              "json",
              "message.delivered",
              json(WEBHOOK_EVENTS.find((x) => x.name === "message.delivered")!.example),
            ),
            ...requestSamples(test).map((s) => ({ ...s, label: `${s.label} · test` })),
          ],
        },
      },
      {
        id: "next",
        title: "Next",
        blocks: [
          {
            kind: "links",
            items: [
              {
                label: "Reply to customers inside 24 hours",
                href: guidePath("reply-inside-24-hours"),
              },
              {
                label: "Handle errors and retries safely",
                href: guidePath("handle-errors-and-retries"),
              },
              { label: "Every endpoint", href: `${DOCS_ROOT}/reference` },
            ],
          },
        ],
      },
    ],
  };
}

function guidePages(): Page[] {
  const send = endpoint("send-template");
  const session = endpoint("send-session");
  const bulk = endpoint("contacts-bulk");
  const upsert = endpoint("contact-upsert");
  const media = endpoint("media-link");
  const received = WEBHOOK_EVENTS.find((x) => x.name === "message.received")!;
  const integratorGuides = integrator();
  const guide = (
    slug: string,
    title: string,
    nav: string,
    description: string,
    sections: Section[],
  ): Page => ({
    id: `guide-${slug}`,
    path: guidePath(slug),
    kind: "guide",
    eyebrow: "Guide",
    title,
    nav,
    description,
    sections,
  });
  return [
    guide(
      "send-an-invoice-pdf",
      "Send an invoice PDF",
      "Send an invoice PDF",
      "Send an approved document template with the invoice attached, from a link or from the file itself, safely retried.",
      [
        {
          id: "how",
          title: "How it works",
          blocks: [
            {
              kind: "p",
              text: `Your system calls ${ref("send-template")} with the customer's number, an approved template that has a **document header**, the template's values and the PDF. AiDwar fetches or decodes the file, checks it really is a PDF (up to ${MAX_DOCUMENT_MB} MB), sends it through WhatsApp and keeps a copy in your inbox.`,
            },
            { kind: "preview", endpointId: "send-template" },
          ],
          code: { title: "Send with a link", samples: requestSamples(send, send.more?.[0]?.body) },
        },
        {
          id: "from-the-file",
          title: "Send the file itself",
          blocks: [
            {
              kind: "p",
              text: "When the PDF isn't on a public https address, send its bytes as base64 in `document.base64` instead of `document.url`. Exactly one of the two.",
            },
          ],
          code: {
            title: "Base64 from Node.js",
            samples: [
              code(
                "node",
                "Node.js",
                `import { readFileSync } from "node:fs";

const res = await fetch("${BASE_URL}/messages/template", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.AIDWAR_API_KEY}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    to: "+919812345678",
    template_name: "invoice_document",
    document: { base64: readFileSync("INV-1001.pdf").toString("base64"), filename: "INV-1001.pdf" },
    body_params: ["Asha", "INV-1001", "2,500.00"],
    idempotency_key: "inv-1001",
  }),
});`,
              ),
            ],
          },
        },
        {
          id: "safely",
          title: "Send it exactly once",
          blocks: [
            {
              kind: "p",
              text:
                "Use the invoice number as `idempotency_key`. If your request times out or your server restarts, send it again with the same key: you get the first answer back and the customer gets one message. See [Handle errors and retries safely](" +
                guidePath("handle-errors-and-retries") +
                ").",
            },
          ],
        },
      ],
    ),
    integratorGuides.recipe,
    guide(
      "reply-inside-24-hours",
      "Reply to customers inside 24 hours",
      "Reply inside 24 hours",
      "Send text, files, reply buttons and lists in your own words while the customer's 24-hour window is open.",
      [
        {
          id: "window",
          title: "The window",
          blocks: [
            {
              kind: "p",
              text: "When a customer writes to you, WhatsApp opens a **24-hour window**. Inside it you may reply in your own words; outside it only an approved template can start the conversation again.",
            },
            { kind: "window" },
          ],
        },
        {
          id: "send",
          title: "Reply",
          blocks: [
            {
              kind: "p",
              text: `Call ${ref("send-session")}. It leaves from the number the customer last wrote to. If the window has closed you get **409 window_closed** and nothing is sent — send a template instead.`,
            },
            { kind: "preview", endpointId: "send-session" },
          ],
          code: { title: "A text reply", samples: requestSamples(session) },
        },
        {
          id: "buttons",
          title: "Buttons and lists",
          blocks: [
            {
              kind: "p",
              text: "Up to three reply buttons, or a list of choices. The customer's tap comes back as `message.received` with `reply.id`.",
            },
          ],
          code: {
            title: "Reply buttons",
            samples: requestSamples(session, session.more?.[0]?.body),
          },
        },
      ],
    ),
    guide(
      "receive-customer-replies",
      "Receive customer replies",
      "Receive customer replies",
      "Hear every message a customer sends — text, photos, documents, button taps — on your webhook, and download their files.",
      [
        {
          id: "event",
          title: "message.received",
          blocks: [
            {
              kind: "p",
              text:
                "Add a webhook that hears `message.received` (Settings → API & webhooks, or " +
                ref("webhook-create") +
                "). Every customer message arrives as one event: the words, a file, the button or list row they tapped, or a map pin.",
            },
            { kind: "payload", event: "message.received" },
          ],
          code: {
            title: "message.received",
            samples: [code("json", "Event", json(received.example))],
          },
        },
        {
          id: "files",
          title: "Download what they sent",
          blocks: [
            {
              kind: "p",
              text: `A photo or document comes as \`media.url\`. Ask ${ref("media-link")} for a download link (it works for 5 minutes, with the same API key) and save the file to your own storage.`,
            },
          ],
          code: { title: "Get the download link", samples: requestSamples(media) },
        },
      ],
    ),
    guide(
      "import-contacts-with-consent",
      "Import contacts with consent",
      "Import contacts with consent",
      "Bring customers in from your own system with their opt-in, tags and attributes — up to 1,000 at a time.",
      [
        {
          id: "one",
          title: "One contact",
          blocks: [
            {
              kind: "p",
              text: `${ref("contact-upsert")} creates or updates a contact by phone. Send \`opted_in: true\` only when the customer agreed to hear from you: it records their consent. It never undoes an opt-out — only the customer can, by writing START.`,
            },
          ],
          code: { title: "Create or update", samples: requestSamples(upsert) },
        },
        {
          id: "many",
          title: "Many at once",
          blocks: [
            {
              kind: "p",
              text: `${ref("contacts-bulk")} takes up to 1,000 contacts in one call and answers with a result per row: one bad row never stops the rest.`,
            },
          ],
          code: { title: "Bulk", samples: requestSamples(bulk) },
        },
        {
          id: "sync",
          title: "Stay in sync",
          blocks: [
            {
              kind: "p",
              text: `${ref("contacts-list")} returns contacts oldest change first: keep the last cursor and ask again later for what changed. \`contact.opted_out\` and \`contact.opted_in\` events tell you the moment a customer changes their mind.`,
            },
          ],
        },
      ],
    ),
    guide(
      "verify-webhook-signatures",
      "Verify webhook signatures",
      "Verify webhook signatures",
      "Check that every webhook delivery really comes from AiDwar and isn't a replay, in Node.js, Python, PHP or Go.",
      [
        {
          id: "how",
          title: "How deliveries are signed",
          blocks: [
            {
              kind: "list",
              items: [
                "`X-AiDwar-Timestamp`: when it was sent, in Unix seconds.",
                '`X-AiDwar-Signature`: `sha256=` and the hex HMAC-SHA256 of `timestamp + "." + body`, keyed with that webhook\'s signing secret. In short: `X-AiDwar-Signature: sha256=HMAC-SHA256(secret, timestamp + "." + body)`.',
                `Refuse a delivery whose timestamp is more than ${SIGNATURE_TOLERANCE_SECONDS / 60} minutes away from now: it is a replay.`,
                "Compare in constant time, and use the body exactly as received — before any JSON parsing.",
              ],
            },
            {
              kind: "callout",
              tone: "warn",
              title: "Each webhook has its own secret",
              text: "With several webhooks, check each with its own secret. Rotating a secret stops the old one at once.",
            },
          ],
          code: { title: "Check a delivery", samples: VERIFY_SAMPLES },
        },
      ],
    ),
    guide(
      "handle-errors-and-retries",
      "Handle errors and retries safely",
      "Errors and retries",
      "Know which errors to fix and which to retry, and use idempotency keys so a retry can never send a message twice.",
      [
        {
          id: "which",
          title: "Fix it, or try again",
          blocks: [
            {
              kind: "list",
              items: [
                "**4xx** — the request can't be done as it is. Read `error` (for people) and `code` (for programs), fix it, send again. Nothing was sent. Never retry a 4xx unchanged — it fails the same way — except 429 and `409 idempotency_in_progress` (below).",
                "**429** — too many requests this minute. Wait the seconds in `Retry-After`, then retry with the same idempotency key.",
                "**5xx, a timeout or no answer at all** — try again with the same idempotency key. It is never sent twice.",
              ],
            },
            {
              kind: "p",
              text: `Every code, with what to do, is in [Errors](${DOCS_ROOT}/errors). WhatsApp's own numbered errors (131026 and the rest) are in [Common WhatsApp errors](${guidePath("whatsapp-errors")}).`,
            },
          ],
          code: {
            title: "An error",
            status: 409,
            samples: [
              code(
                "json",
                "Response",
                json({
                  error:
                    "This customer's 24-hour window is closed: send an approved template instead.",
                  code: "window_closed",
                }),
              ),
            ],
          },
        },
        {
          id: "idempotency",
          title: "Retry without sending twice",
          blocks: [
            {
              kind: "p",
              text: `Give every send an \`idempotency_key\` (or the \`Idempotency-Key\` header) — your invoice or order number works well. Within ${IDEMPOTENCY_WINDOW_HOURS} hours the same key gets the first answer back with \`Idempotent-Replayed: true\`, and the customer gets one message. [More on idempotency](${DOCS_ROOT}/idempotency).`,
            },
            {
              kind: "table",
              head: ["Answer", "Retry?", "How"],
              rows: [
                [
                  "No answer, a timeout, a dropped connection",
                  "Yes",
                  `Same body, same key. Wait ${RETRY_WAITS_SECONDS.map((s) => `${s} s`).join(", then ")} between tries; then queue it and try again later (within ${IDEMPOTENCY_WINDOW_HOURS} hours, still the same key).`,
                ],
                [
                  "**429** `rate_limited`",
                  "Yes",
                  "Wait the seconds in `Retry-After`, then the same body and key.",
                ],
                [
                  "**409** `idempotency_in_progress`",
                  "Yes",
                  "The first try is still being sent: wait the `Retry-After` seconds and ask again with the same key. You get its answer.",
                ],
                [
                  "**500**, **503**, **502** `whatsapp_upload_failed`",
                  "Yes",
                  `Same body and key, waiting ${RETRY_WAITS_SECONDS.map((s) => `${s} s`).join(", ")}.`,
                ],
                [
                  "**502** `whatsapp_rejected`",
                  "No",
                  `WhatsApp refused this message (\`message_id\` has its reason). The same key gives this answer back, it doesn't send again. Fix the cause ([Common WhatsApp errors](${guidePath("whatsapp-errors")})), then [resend with a new key](${DOCS_ROOT}/idempotency#resend).`,
                ],
                [
                  "Any other **4xx**",
                  "No",
                  "Fix what `error` says. When the error says nothing was sent, the key is free again: send the corrected request with it.",
                ],
              ],
            },
          ],
          code: {
            title: "Retry with backoff",
            samples: [code("node", "Node.js", RETRY_SAMPLE)],
          },
        },
        {
          id: "resend",
          title: "Resend on purpose",
          blocks: [
            {
              kind: "p",
              text: `A retry with the same key never sends again. To send the same message again on purpose — the customer lost the invoice, or you fixed their number — use a **new** key, such as \`${INVOICE_KEY}-r1\`, then \`${INVOICE_KEY}-r2\`. [How resending works](${DOCS_ROOT}/idempotency#resend).`,
            },
          ],
        },
      ],
    ),
    ...integratorGuides.rest,
  ];
}

// ------------------------------------------------------------ integrator guides (resend, delivery, errors, rules, the invoice recipe)

/** The waits between tries the docs recommend (seconds). */
export const RETRY_WAITS_SECONDS = [1, 5, 30] as const;

/** The invoice the integrator examples send (a made-up number). */
export const INVOICE_NUMBER = "ZADM2611A002";
export const INVOICE_KEY = `inv-${INVOICE_NUMBER}`;
const RESEND_KEY = `${INVOICE_KEY}-r1`;
const STAFF_NUMBER = "+918000000001";

/** The recipe's request: an invoice PDF by link, its number as the key. */
export const INVOICE_RECIPE_BODY: Record<string, unknown> = {
  to: "+919812345678",
  template_name: "invoice_document",
  document: {
    url: `https://billing.example.com/invoices/${INVOICE_NUMBER}.pdf`,
    filename: `${INVOICE_NUMBER}.pdf`,
  },
  body_params: ["Asha", INVOICE_NUMBER, "₹2,500.00"],
  idempotency_key: INVOICE_KEY,
};

/** The same invoice sent again on purpose: a new key. */
export const INVOICE_RESEND_BODY: Record<string, unknown> = {
  ...INVOICE_RECIPE_BODY,
  idempotency_key: RESEND_KEY,
};

/** Meta's page listing every WhatsApp error code. */
export const META_ERROR_CODES_URL =
  "https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes";

/**
 * WhatsApp's own errors integrators meet most, as Meta's error-code page
 * names them. Every code here is one our code knows (batch64-docs.test.ts
 * checks each against wa-reachability's reasons and the dispatcher's
 * throughput codes); `ours` are the API's own codes that catch the same
 * problem before anything is sent.
 */
export const WHATSAPP_ERRORS: Array<{
  code: string;
  title: string;
  means: Inline;
  todo: Inline;
  ours: string[];
}> = [
  {
    code: "131026",
    title: "Message undeliverable",
    means:
      "The number isn't on WhatsApp, its WhatsApp is too old, or its owner hasn't accepted WhatsApp's latest terms.",
    todo: 'Check the number with the customer (country code, no leading 0). The next send still goes, but for 30 days its `202` carries `warning: "number_not_on_whatsapp_recently"` — until a message to that number is delivered.',
    ours: [],
  },
  {
    code: "131049",
    title: "Not delivered to maintain healthy ecosystem engagement",
    means:
      "WhatsApp held back a **marketing** template for this customer, to limit how many marketing messages one person gets. The number is fine.",
    todo: "Don't retry at once: try again another day. Send invoices and order updates as **utility** templates.",
    ours: [],
  },
  {
    code: "131047",
    title: "Re-engagement message",
    means:
      "More than 24 hours since the customer last wrote, so a free-form message can't go. The session endpoint checks this first and answers `409 window_closed`.",
    todo: `Send an approved template instead ([the 24-hour window](${DOCS_ROOT}/24-hour-window)).`,
    ours: ["window_closed"],
  },
  {
    code: "132000",
    title: "Number of parameters does not match the expected number of params",
    means:
      "The values don't fit the template's `{{1}}`, `{{2}}`…. AiDwar checks the count first (`400 param_count_mismatch`); 132000 means the template changed on WhatsApp's side since.",
    todo: "Open the template in Templates and send exactly as many `body_params` as it has placeholders.",
    ours: ["param_count_mismatch"],
  },
  {
    code: "132001",
    title: "Template does not exist",
    means:
      "No approved template with this name in this language. AiDwar checks first (`400 template_not_found`, `template_not_approved`, `language_required`).",
    todo: "Check the template's exact name and `language` in Templates, and that it is approved.",
    ours: ["template_not_found", "template_not_approved", "language_required"],
  },
  {
    code: "131053",
    title: "Media upload error",
    means:
      "WhatsApp couldn't take the file. AiDwar downloads your link and hands the file to WhatsApp itself, so a link that isn't public or a file that's too big is refused before sending (`400 document_unreachable`, `413 document_too_large`, `502 whatsapp_upload_failed`).",
    todo: `Check the PDF opens normally, is under ${MAX_DOCUMENT_MB} MB and its link works without a login ([file rules](${guidePath("numbers-values-and-files")}#files)).`,
    ours: ["document_unreachable", "document_too_large", "whatsapp_upload_failed"],
  },
  {
    code: "131056",
    title: "(Business Account, Consumer Account) pair rate limit hit",
    means: "Too many messages from your number to this one customer in a short time.",
    todo: "Wait a minute or more before the next message to this customer, then resend with a new key.",
    ours: [],
  },
  {
    code: "130429",
    title: "Rate limit hit",
    means: `Your WhatsApp number reached WhatsApp's own messages-per-second limit. (AiDwar's own limit, ${RATE_PER_KEY_PER_MIN} requests a minute per key, is \`429 rate_limited\`.)`,
    todo: "Slow down, then resend with a new key. Sending to many customers at once? Use a campaign: it is sent at WhatsApp's pace.",
    ours: [],
  },
];

/** The failed delivery the docs show (the shape webhookBody writes). */
export const FAILED_DELIVERY_EXAMPLE = {
  event: "message.failed",
  message_id: "6f1c2b0e-3c4d-4f7a-9a51-2f0d8c1e7b42",
  idempotency_key: INVOICE_KEY,
  to: "+919812345678",
  status: "failed",
  error: { code: "131026", message: "Message undeliverable." },
  timestamp: "2026-11-04T10:00:04.000Z",
};

/** The same failure from GET /api/v1/messages/{message_id}. */
export const FAILED_STATUS_EXAMPLE = {
  message_id: FAILED_DELIVERY_EXAMPLE.message_id,
  status: "failed",
  to: "+919812345678",
  template_name: "invoice_document",
  idempotency_key: INVOICE_KEY,
  wamid: "wamid.HBgM…",
  error: FAILED_DELIVERY_EXAMPLE.error,
  created_at: "2026-11-04T10:00:00.000Z",
  sent_at: "2026-11-04T10:00:02.000Z",
  delivered_at: null,
  read_at: null,
  failed_at: "2026-11-04T10:00:04.000Z",
  updated_at: "2026-11-04T10:00:04.000Z",
};

/** What `to` does with the numbers integrators send (batch64-docs.test.ts runs each through the check). */
export const PHONE_EXAMPLES: Array<{ input: string; sentTo: string | null; note: Inline }> = [
  { input: "+919812345678", sentTo: "+919812345678", note: "Right: `+`, country code, number." },
  { input: "919812345678", sentTo: "+919812345678", note: "Also right: the `+` is optional." },
  {
    input: "+91 98123-45678",
    sentTo: "+919812345678",
    note: "Accepted: spaces, dashes, dots and brackets are removed.",
  },
  {
    input: "9812345678",
    sentTo: "+9812345678",
    note: "**Not refused, but wrong.** Without its country code the number is read as if it started with one (here +98), so it goes to someone else or fails. Add `91`.",
  },
  {
    input: "09812345678",
    sentTo: "+09812345678",
    note: "**Not refused, but it can't be delivered** (no country code starts with 0): you get `502 whatsapp_rejected` or `message.failed`. Drop the 0 and add `91`.",
  },
  { input: "+91 98123", sentTo: null, note: "Refused, `400 invalid_to`: fewer than 8 digits." },
  {
    input: "+91981234567812345",
    sentTo: null,
    note: "Refused, `400 invalid_to`: more than 15 digits.",
  },
];

/** What the customer sees as the PDF's name (cleanFilename). */
export const FILENAME_EXAMPLES: Array<{ input: string; shown: string }> = [
  { input: `${INVOICE_NUMBER}.pdf`, shown: `${INVOICE_NUMBER}.pdf` },
  { input: INVOICE_NUMBER, shown: `${INVOICE_NUMBER}.pdf` },
  { input: `C:\\bills\\2026\\${INVOICE_NUMBER}.pdf`, shown: `${INVOICE_NUMBER}.pdf` },
  { input: "", shown: "document.pdf" },
];

const RETRY_SAMPLE = `const WAITS = [${RETRY_WAITS_SECONDS.join(", ")}]; // seconds between tries

// Send once, safely: the same body (and so the same idempotency_key) on every try.
async function sendOnce(body) {
  for (let attempt = 0; ; attempt += 1) {
    let res = null;
    let answer = {};
    try {
      res = await fetch("${BASE_URL}/messages/template", {
        method: "POST",
        headers: {
          Authorization: \`Bearer \${process.env.AIDWAR_API_KEY}\`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      answer = await res.json().catch(() => ({}));
    } catch {
      // A timeout or a dropped connection: it may have gone, so retry with the same key.
    }
    if (res && res.ok) return answer; // 202 { message_id, status: "queued", … }
    const retry =
      !res ||
      res.status === 429 ||
      answer.code === "idempotency_in_progress" ||
      (res.status >= 500 && answer.code !== "whatsapp_rejected");
    if (!retry || attempt >= WAITS.length) {
      const error = new Error(res ? \`\${res.status} \${answer.code}: \${answer.error}\` : "No answer");
      error.answer = answer;
      throw error; // a 4xx: fix it. Still 5xx: queue it, retry later with the same key.
    }
    const wait = Number(res?.headers.get("retry-after")) || WAITS[attempt];
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}`;

/** The recipe's full Node.js example (batch64-docs.test.ts runs it against a stand-in server). */
export const INVOICE_RECIPE_NODE = `${RETRY_SAMPLE}

// Call this from your server once an invoice is final and its PDF exists.
// resend = 0 for the first send; 1, 2… when someone presses "Send again".
async function sendInvoice(invoice, resend = 0) {
  const key = resend ? \`inv-\${invoice.number}-r\${resend}\` : \`inv-\${invoice.number}\`;
  const sent = await sendOnce({
    to: invoice.customerPhone, // "+91…": always with the country code
    template_name: "invoice_document",
    document: { url: invoice.pdfUrl, filename: \`\${invoice.number}.pdf\` },
    body_params: [invoice.customerName, invoice.number, invoice.total],
    idempotency_key: key,
    // cc: ["${STAFF_NUMBER}"], // or leave it out to use Settings' default copy numbers
  });
  // Keep sent.message_id with the invoice: delivery updates name it.
  if (sent.warning === "number_not_on_whatsapp_recently")
    console.warn(\`\${invoice.number}: WhatsApp recently said this number can't receive messages. Check it with the customer.\`);
  for (const copy of sent.copies ?? [])
    if (copy.status !== "queued") console.warn(\`Copy to \${copy.to}: \${copy.code ?? copy.status}\`);
  return sent;
}

// Test with your own WhatsApp number first, never with a number from these docs.
const sent = await sendInvoice({
  number: "${INVOICE_NUMBER}",
  customerPhone: process.env.TEST_WHATSAPP_NUMBER,
  customerName: "Asha",
  total: "₹2,500.00",
  pdfUrl: "https://billing.example.com/invoices/${INVOICE_NUMBER}.pdf",
});
console.log(sent.message_id, sent.status); // "…", "queued" — accepted, not yet delivered`;

/** The recipe's webhook side: delivery and failure, by message_id. */
const INVOICE_WEBHOOK_NODE = `import express from "express";
import { isFromAiDwar } from "./verify.js"; // the signature check from "Verify webhook signatures"

const app = express();
app.post("/aidwar/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const raw = req.body.toString("utf8");
  if (!isFromAiDwar(raw, req.headers, process.env.AIDWAR_WEBHOOK_SECRET)) return res.sendStatus(401);
  res.sendStatus(200); // answer at once; do the work after
  const e = JSON.parse(raw);
  if (e.cc_of) return; // a staff copy, not the customer's message
  // Find the invoice by the message_id you kept from the 202.
  if (e.event === "message.delivered" || e.event === "message.read")
    await markInvoice(e.message_id, "delivered");
  if (e.event === "message.failed")
    await markInvoice(e.message_id, "failed", \`\${e.error?.code}: \${e.error?.message}\`);
});
app.listen(3000);`;

function integratorGuide(
  slug: string,
  title: string,
  nav: string,
  description: string,
  sections: Section[],
): Page {
  return {
    id: `guide-${slug}`,
    path: guidePath(slug),
    kind: "guide",
    eyebrow: "Guide",
    title,
    nav,
    description,
    sections,
  };
}

function integrator(): { recipe: Page; rest: Page[] } {
  const send = endpoint("send-template");
  const status = endpoint("message-status");
  const failedJson = code("json", "message.failed", json(FAILED_DELIVERY_EXAMPLE));
  const statusesTable: Block = {
    kind: "table",
    head: ["Status", "What it means", "Webhook event"],
    rows: [
      ["`queued`", "WhatsApp accepted it; no report yet. This is what the `202` says.", "—"],
      [
        "`sent`",
        "It reached WhatsApp's servers.",
        `[\`message.sent\`](${eventPath("message.sent")})`,
      ],
      [
        "`delivered`",
        "It reached the customer's phone.",
        `[\`message.delivered\`](${eventPath("message.delivered")})`,
      ],
      [
        "`read`",
        "The customer opened it (only when they share read receipts).",
        `[\`message.read\`](${eventPath("message.read")})`,
      ],
      [
        "`failed`",
        "WhatsApp couldn't deliver it; `error.code` and `error.message` say why. Final for this message.",
        `[\`message.failed\`](${eventPath("message.failed")})`,
      ],
    ],
  };

  const recipe = integratorGuide(
    "send-every-invoice-automatically",
    "Recipe: send every invoice automatically",
    "Send every invoice automatically",
    "Wire your billing software to send each invoice PDF on WhatsApp once, with copies to staff, and know whether it arrived.",
    [
      {
        id: "where",
        title: "Where to call it",
        blocks: [
          {
            kind: "list",
            ordered: true,
            items: [
              "**Once, when the invoice is final** and its PDF exists — in the step that saves or finalises the invoice, or in the background job it starts. Not when someone opens, prints or edits it.",
              "**From your server**, never from the browser or the billing screen: the API key must stay secret.",
              "**Don't let it block billing.** If the call fails, put it in a queue and retry; the invoice is saved either way.",
            ],
          },
          {
            kind: "callout",
            tone: "warn",
            title: "Test with your own number first",
            text: `Send the first invoices to your own WhatsApp number. The numbers in these docs (\`+919812345678\`, \`${STAFF_NUMBER}\`…) are examples, not your customers — a real person may own them.`,
          },
        ],
      },
      {
        id: "request",
        title: "The request",
        blocks: [
          {
            kind: "list",
            items: [
              "An approved template with a **document header** (for example `invoice_document`) and its values in `body_params`, in order.",
              `The PDF as a public https \`document.url\`, or the file itself as \`document.base64\` ([file rules](${guidePath("numbers-values-and-files")}#files)).`,
              `**The invoice number as the key:** \`idempotency_key: "${INVOICE_KEY}"\`. A retry can then never send it twice.`,
              `**Copies to staff:** add \`cc\` (up to ${MAX_CC} numbers) to this request, or leave it out and set default copy numbers once in Settings → API & webhooks → "Also send every API template message to". \`"cc": []\` sends no copies.`,
            ],
          },
        ],
        code: { title: "Send the invoice", samples: requestSamples(send, INVOICE_RECIPE_BODY) },
      },
      {
        id: "answer",
        title: "Read the answer",
        blocks: [
          {
            kind: "table",
            head: ["Answer", "What to do"],
            rows: [
              [
                "**202** `queued`",
                "Keep `message_id` with the invoice. WhatsApp has accepted it — delivery comes next.",
              ],
              [
                '**202** with `warning: "number_not_on_whatsapp_recently"`',
                "It was still sent. WhatsApp said in the last 30 days that this number can't receive messages: ask the customer to check their number.",
              ],
              [
                "**202** with `copies`",
                "One entry per staff copy: `queued`, `failed` or `not_sent`, with `code`. A copy never changes the customer's answer.",
              ],
              [
                "**429**, **500**, **503**, a timeout",
                `Retry with the same body and key (${RETRY_WAITS_SECONDS.map((s) => `${s} s`).join(", ")}). [Errors and retries](${guidePath("handle-errors-and-retries")}).`,
              ],
              [
                "**502** `whatsapp_rejected`",
                `WhatsApp refused it. Show the reason to your staff; fix it and resend with a new key ([Common WhatsApp errors](${guidePath("whatsapp-errors")})).`,
              ],
              [
                "Any other **4xx**",
                "Nothing was sent. Show `error` to your staff and fix the invoice (number, template, PDF).",
              ],
            ],
          },
        ],
        code: {
          title: "Accepted, with a warning",
          status: 202,
          samples: [
            code(
              "json",
              "Response",
              json({
                message_id: FAILED_DELIVERY_EXAMPLE.message_id,
                status: "queued",
                wamid: "wamid.HBgM…",
                idempotency_key: INVOICE_KEY,
                warning: "number_not_on_whatsapp_recently",
              }),
            ),
          ],
        },
      },
      {
        id: "delivery",
        title: "Check it arrived",
        blocks: [
          {
            kind: "p",
            text: `\`202\` means accepted, not delivered. Listen for \`message.delivered\` and \`message.failed\` on your webhook and update the invoice by \`message_id\`; or ask ${ref("message-status")}. [Know it was delivered](${guidePath("know-it-was-delivered")}).`,
          },
        ],
        code: {
          title: "Your webhook",
          samples: [code("node", "Node.js (Express)", INVOICE_WEBHOOK_NODE), failedJson],
        },
      },
      {
        id: "resend",
        title: "Resend",
        blocks: [
          {
            kind: "p",
            text: `For a "Send again" button, add \`-r1\`, \`-r2\`… to the key: \`${RESEND_KEY}\`. The same key would only give the first answer back. A resend sends the copies again too (each copy's key follows the main key, \`${RESEND_KEY}:cc:${STAFF_NUMBER}\`); add \`"cc": []\` to resend to the customer only.`,
          },
        ],
        code: { title: "Send it again", samples: requestSamples(send, INVOICE_RESEND_BODY) },
      },
      {
        id: "full",
        title: "The whole thing in Node.js",
        blocks: [
          {
            kind: "p",
            text: "Node.js 18 or later (fetch built in). Set `AIDWAR_API_KEY`, and `TEST_WHATSAPP_NUMBER` to your own number for the first run.",
          },
          {
            kind: "code",
            group: {
              title: "send-invoice.mjs",
              samples: [code("node", "Node.js", INVOICE_RECIPE_NODE)],
            },
          },
        ],
      },
    ],
  );

  const delivered = integratorGuide(
    "know-it-was-delivered",
    "Know a message was delivered",
    "Know it was delivered",
    "A 202 only means WhatsApp accepted the message. Delivery or failure comes seconds later: on your webhook, or from the status endpoint.",
    [
      {
        id: "accepted",
        title: "Accepted is not delivered",
        blocks: [
          {
            kind: "p",
            text: 'A `202` with `"status": "queued"` means WhatsApp **accepted** the message for sending. It doesn\'t mean it reached the customer. A few seconds later WhatsApp reports what happened — a failure (a number not on WhatsApp, say) arrives then, never in the `202`.',
          },
          statusesTable,
          {
            kind: "p",
            text: "`delivered` can take longer when the customer's phone is off; it isn't a failure until `message.failed` comes.",
          },
        ],
      },
      {
        id: "webhook",
        title: "On your webhook",
        blocks: [
          {
            kind: "list",
            items: [
              `Add a webhook that hears \`message.sent\`, \`message.delivered\`, \`message.read\` and \`message.failed\` (Settings → API & webhooks, or ${ref("webhook-create")}).`,
              "Match each event to your record by `message_id` (from the `202`); `idempotency_key` is there too.",
              "An event can arrive twice or out of order: skip an `X-AiDwar-Delivery` you already handled, and never move a message back from `read` or `failed`.",
              "A staff copy's events carry `cc_of`, the customer's `message_id`.",
            ],
          },
          { kind: "payload", event: "message.failed" },
        ],
        code: { title: "A failed delivery", samples: [failedJson] },
      },
      {
        id: "status",
        title: "Or ask",
        blocks: [
          {
            kind: "p",
            text: `${ref("message-status")} gives the status, when each step happened and, for a failure, \`error\`. Ask a little later rather than in a tight loop — for example after 10 seconds, 1 minute and 10 minutes: status reads count against the [rate limits](${DOCS_ROOT}/rate-limits) too.`,
          },
        ],
        code: { title: "Ask for the status", samples: requestSamples(status) },
        aside: {
          title: "A failed message",
          status: 200,
          samples: [code("json", "Response", json(FAILED_STATUS_EXAMPLE))],
        },
      },
      {
        id: "refused",
        title: "Refused at once",
        blocks: [
          {
            kind: "p",
            text:
              'When WhatsApp refuses the message on the spot, the send answers `502 whatsapp_rejected` with `message_id` and `"status": "failed"`, and your webhook hears `message.failed` as well. Read `error.code` and see [Common WhatsApp errors](' +
              guidePath("whatsapp-errors") +
              ").",
          },
        ],
      },
    ],
  );

  const errors = integratorGuide(
    "whatsapp-errors",
    "Common WhatsApp errors",
    "Common WhatsApp errors",
    "The numbered errors WhatsApp reports in message.failed — 131026, 131049, 132000 and more — what each means and what to do.",
    [
      {
        id: "where",
        title: "Where you see them",
        blocks: [
          {
            kind: "p",
            text: `AiDwar's own errors are words (\`invalid_to\`) and come back on the call — see [Errors](${DOCS_ROOT}/errors). WhatsApp's errors are numbers and come in \`error.code\` of [\`message.failed\`](${eventPath("message.failed")}) and of ${ref("message-status")}, and in a \`502 whatsapp_rejected\`. The full list is on [Meta's error codes page](${META_ERROR_CODES_URL}).`,
          },
        ],
        code: { title: "message.failed", samples: [failedJson] },
      },
      {
        id: "table",
        title: "The common ones",
        blocks: [
          {
            kind: "table",
            head: ["Code", "WhatsApp calls it", "What it means", "What to do"],
            rows: WHATSAPP_ERRORS.map((e) => [`\`${e.code}\``, e.title, e.means, e.todo]),
          },
          {
            kind: "p",
            text: `Resending after any of these needs a new idempotency key — [Resend on purpose](${DOCS_ROOT}/idempotency#resend).`,
          },
        ],
      },
    ],
  );

  const rules = integratorGuide(
    "numbers-values-and-files",
    "Numbers, template values and files",
    "Numbers, values and files",
    "What the API accepts in `to`, in template values and as a PDF — and what it refuses — so a send doesn't fail.",
    [
      {
        id: "numbers",
        title: "Phone numbers",
        blocks: [
          {
            kind: "p",
            text: "Always send the full number **with its country code**: `+919812345678`. AiDwar removes everything that isn't a digit and refuses only numbers with fewer than 8 or more than 15 digits — it can't tell a 10-digit Indian number from a foreign one, so add the country code in your own system.",
          },
          {
            kind: "table",
            head: ["You send", "Sent to", "What happens"],
            rows: PHONE_EXAMPLES.map((p) => [
              `\`${p.input}\``,
              p.sentTo ? `\`${p.sentTo}\`` : "Nothing sent",
              p.note,
            ]),
          },
          {
            kind: "callout",
            tone: "warn",
            title: "Never test with the numbers in these docs",
            text: "`+919812345678` is not a real customer of yours, and neither are the other sample numbers — a real person may own them. Test with your own WhatsApp number first.",
          },
        ],
        code: {
          title: "Fix numbers before you send (India)",
          samples: [
            code(
              "node",
              "Node.js",
              `// "098123 45678", "98123-45678", "+91 98123 45678" → "+919812345678"
function toWhatsAppNumber(raw) {
  let digits = String(raw).replace(/\\D/g, "");
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1); // drop a leading 0
  if (digits.length === 10) digits = "91" + digits; // add India's country code
  return "+" + digits;
}`,
            ),
          ],
        },
      },
      {
        id: "values",
        title: "Template values",
        blocks: [
          {
            kind: "list",
            items: [
              "**Exactly one value per placeholder**, in order: a template with `{{1}}` `{{2}}` `{{3}}` takes three `body_params`. Another count is `400 param_count_mismatch`.",
              "**No empty values.** An empty one (or only spaces) is `400 invalid_body_params`; spaces at the start and end are removed.",
              "**No new lines, no tabs, no more than 4 spaces in a row** — WhatsApp refuses them: `400 invalid_body_params` (in a text header's values, `invalid_header`). Put line breaks in the template's own text, and an address on one line: `12 MG Road, Pune 411001`.",
              "**Up to 1,024 characters** per value. Button values: a link's `url_param` up to 2,000, a quick reply's `payload` up to 256, a coupon `code` up to 15 — no new lines or tabs (`400 invalid_buttons`).",
              "**Currency symbols, emoji and any language are fine:** `₹2,500.00`, `Rs. 2,500`, `€45`, `नमस्ते`. Numbers are sent as text.",
            ],
          },
        ],
        code: {
          title: "Refused before sending",
          status: 400,
          samples: [
            code(
              "json",
              "Response",
              json({
                error:
                  "body_params[1] can't contain a new line, a tab or more than four spaces in a row.",
                code: "invalid_body_params",
              }),
            ),
          ],
        },
      },
      {
        id: "files",
        title: "PDFs and other files",
        blocks: [
          {
            kind: "list",
            items: [
              "**A public `https://` link** that opens without a login, a cookie or a VPN. Private and local addresses are refused, also after a redirect (up to 5 redirects are followed): `400 document_url_not_https` / `document_url_blocked`.",
              "**It must download within 15 seconds** (`400 document_unreachable`). AiDwar fetches it during your call and gives WhatsApp its own copy, so the link only has to work until the `202` — a signed link that expires later is fine.",
              `**A real PDF, up to ${MAX_DOCUMENT_MB} MB.** AiDwar reads the file's first bytes, not its \`Content-Type\` or name: a Word file or a login page saved as \`.pdf\` is \`400 document_not_pdf\`; over ${MAX_DOCUMENT_MB} MB is \`413 document_too_large\`; an empty file \`400 document_empty\`. Serving it as \`application/pdf\` is still good practice.`,
              "**`document.filename` is the name the customer sees** in WhatsApp. Folders are removed, `.pdf` is added when missing, at most 120 characters; without one the customer sees `document.pdf`.",
              "**No public link?** Send the file itself as `document.base64` instead of `document.url` (exactly one of the two; a `data:` URL is accepted). The whole request may be up to 23 MB (`413 request_too_large`).",
            ],
          },
          {
            kind: "table",
            head: ["`document.filename`", "The customer sees"],
            rows: FILENAME_EXAMPLES.map((x) => [
              x.input ? `\`${x.input}\`` : "(none)",
              `\`${x.shown}\``,
            ]),
          },
        ],
      },
    ],
  );

  return { recipe, rest: [delivered, errors, rules] };
}

const GROUP_ORDER: ApiEndpoint["group"][] = [
  "Messages",
  "Media",
  "Contacts",
  "Templates",
  "Campaigns",
  "Inbox",
  "Webhooks",
  "Account",
];

const RESPONSE_WORDS: Record<number, string> = {
  200: "OK: the answer is in the body.",
  201: "Created: the new item is in the body.",
  202: "Accepted: the message is on its way. Its delivery updates follow on your webhook.",
  204: "Done; the body is empty.",
};

function referencePages(): Page[] {
  return API_ENDPOINTS.map((e) => {
    const extra = e.responses ?? [];
    const success: CodeGroup = {
      title: "Response",
      status: e.response.status,
      samples: [code("json", `${e.response.status}`, json(e.response.body))],
    };
    return {
      id: `ref-${e.id}`,
      path: referencePath(e.id),
      kind: "reference" as const,
      eyebrow: e.group,
      title: e.title,
      // The sidebar's label: the title without its note in brackets.
      nav: e.title.replace(/\s*\([^)]*\)$/, ""),
      description: e.purpose ?? e.summary,
      endpoint: e,
      sections: [
        {
          id: "overview",
          blocks: [
            { kind: "p", text: e.summary },
            ...(previewFor(e) ? [{ kind: "preview", endpointId: e.id } as Block] : []),
          ],
          code: { title: "Request", samples: requestSamples(e) },
          aside: success,
        },
        {
          id: "parameters",
          title: "Parameters",
          blocks: [{ kind: "params", endpointId: e.id }],
          code: { title: "Request", samples: requestSamples(e) },
          aside: success,
        },
        ...(e.more ?? []).map((m, i) => ({
          id: `example-${i + 1}`,
          title: `Example: ${m.label}`,
          blocks: [
            { kind: "p" as const, text: "Same URL and key — only the request body changes." },
          ],
          code: { title: m.label, samples: requestSamples(e, m.body) },
        })),
        {
          id: "response",
          title: "Responses",
          blocks: [
            {
              kind: "list",
              items: [
                `**${e.response.status}** — ${typeof e.response.body === "string" ? e.response.body : (RESPONSE_WORDS[e.response.status] ?? "Success.")}`,
                ...extra.map((r) => `**${r.status}** — ${r.label}.`),
              ],
            },
          ],
          code: {
            title: "Response",
            samples: [
              code("json", `${e.response.status}`, json(e.response.body)),
              ...extra.map((r) => code("json", `${r.status}`, json(r.body))),
            ],
          },
        },
        {
          id: "errors",
          title: "Errors",
          blocks: [{ kind: "errors", endpointId: e.id }],
        },
      ],
    };
  });
}

function referenceIndexPage(): Page {
  return {
    id: "reference",
    path: `${DOCS_ROOT}/reference`,
    kind: "index",
    eyebrow: "API reference",
    title: "API reference",
    nav: "All endpoints",
    description:
      "Every endpoint of the AiDwar API, by resource: messages, media, contacts, templates, campaigns, inbox, webhooks and your account.",
    sections: [
      {
        id: "basics",
        title: "Basics",
        blocks: [
          {
            kind: "list",
            items: [
              `**Base URL:** \`${BASE_URL}\``,
              "**Authentication:** `Authorization: Bearer adw_live_…` — a key from Settings → API & webhooks.",
              "**Format:** JSON in, JSON out. Times are ISO 8601 in UTC; phone numbers carry their country code.",
              `**Limits:** ${RATE_PER_KEY_PER_MIN} requests a minute per key, ${RATE_PER_WORKSPACE_PER_MIN} per workspace — see [Rate limits](${DOCS_ROOT}/rate-limits).`,
            ],
          },
        ],
        code: {
          title: "Authentication",
          samples: [
            code(
              "bash",
              "cURL",
              `curl ${BASE_URL}/account/balance \\\n  -H "Authorization: Bearer $AIDWAR_API_KEY"`,
            ),
          ],
        },
      },
      ...GROUP_ORDER.map((group) => ({
        id: group.toLowerCase(),
        title: group,
        blocks: [
          {
            kind: "links" as const,
            items: API_ENDPOINTS.filter((e) => e.group === group).map((e) => ({
              label: e.title,
              href: referencePath(e.id),
              method: e.method,
            })),
          },
        ],
      })),
    ],
  };
}

/** Event descriptions that need their subject on a page of their own. */
const EVENT_LEADS: Record<string, string> = {
  "message.delivered": "A message the API sent reached the customer's phone.",
  "message.read": "The customer read a message the API sent (when they share read receipts).",
  "message.failed": "WhatsApp couldn't deliver a message the API sent; error says why.",
};

function eventPages(): Page[] {
  return WEBHOOK_EVENTS.map((ev) => ({
    id: `event-${ev.name}`,
    path: eventPath(ev.name),
    kind: "event" as const,
    eyebrow: "Webhook event",
    title: ev.name,
    nav: ev.name,
    description: EVENT_LEADS[ev.name] ?? ev.when,
    event: ev,
    sections: [
      {
        id: "delivery",
        title: "How it arrives",
        blocks: [
          {
            kind: "list",
            items: [
              `A \`POST\` of JSON to every active webhook that listens for \`${ev.name}\`, with the headers \`X-AiDwar-Event: ${ev.name}\`, \`X-AiDwar-Delivery\` (an id, the same on every retry), \`X-AiDwar-Timestamp\` and \`X-AiDwar-Signature\`.`,
              `Answer with any 2xx within ${WEBHOOK_TIMEOUT_SECONDS} seconds. Anything else is retried with growing pauses for ${WEBHOOK_RETRY_HOURS} hours — so the same delivery can come twice: skip a \`X-AiDwar-Delivery\` you already handled.`,
              `Available on ${planWords(eventFor(ev.name))}; since ${eventFor(ev.name)?.since ?? "v1.0"}.`,
            ],
          },
        ],
        code: { title: ev.name, samples: [code("json", "Payload", json(ev.example))] },
      },
      {
        id: "payload",
        title: "Payload",
        blocks: [{ kind: "payload", event: ev.name }],
        code: { title: ev.name, samples: [code("json", "Payload", json(ev.example))] },
      },
      {
        id: "verify",
        title: "Verify the signature",
        blocks: [
          {
            kind: "p",
            text: `Every delivery is signed with your webhook's secret. Check it before you trust the body — [how signatures work](${guidePath("verify-webhook-signatures")}).`,
          },
        ],
        code: { title: "Check a delivery", samples: VERIFY_SAMPLES },
      },
    ],
  }));
}

function webhooksIndexPage(): Page {
  const groups = Array.from(
    new Set(PLAN_AVAILABILITY.filter((r) => r.kind === "event").map((r) => r.group)),
  );
  return {
    id: "webhooks",
    path: `${DOCS_ROOT}/webhooks`,
    kind: "index",
    eyebrow: "Webhooks",
    title: "Webhooks",
    nav: "Overview",
    description:
      "Get delivery updates, customer messages, campaign results and account changes the moment they happen, on up to 5 https addresses.",
    sections: [
      {
        id: "how",
        title: "How webhooks work",
        blocks: [
          {
            kind: "list",
            items: [
              "Add up to **5 webhooks**, each with its own https address, signing secret and events (Settings → API & webhooks, or the Webhooks endpoints).",
              `We POST each event as JSON. Answer any **2xx** within ${WEBHOOK_TIMEOUT_SECONDS} seconds; redirects aren't followed.`,
              `A failed delivery is retried with backoff (1, 2, 5, 10, 30 minutes, then hourly and longer) for up to ${WEBHOOK_RETRY_HOURS} hours — each webhook on its own.`,
              "Every delivery carries `X-AiDwar-Event`, `X-AiDwar-Delivery`, `X-AiDwar-Timestamp` and `X-AiDwar-Signature`.",
              "An event can, rarely, arrive twice: use `X-AiDwar-Delivery` to skip one you've already handled.",
            ],
          },
        ],
        code: { title: "Check a delivery", samples: VERIFY_SAMPLES },
      },
      ...groups.map((group) => ({
        id: `events-${group.toLowerCase()}`,
        title: `${group} events`,
        blocks: [
          {
            kind: "links" as const,
            items: WEBHOOK_EVENTS.filter((ev) => eventFor(ev.name)?.group === group).map((ev) => ({
              label: ev.name,
              href: eventPath(ev.name),
            })),
          },
        ],
      })),
    ],
  };
}

const STATUS_NAMES: Record<string, string> = {
  "400": "The request can't be done as it is",
  "401": "The API key isn't valid",
  "402": "Payment needed",
  "403": "Not allowed",
  "404": "Not found",
  "409": "Conflict",
  "410": "Gone",
  "413": "Too large",
  "429": "Too many requests",
  "5xx": "WhatsApp or AiDwar couldn't finish",
};

function conceptPages(): Page[] {
  const concept = (
    id: string,
    path: string,
    title: string,
    nav: string,
    description: string,
    sections: Section[],
  ): Page => ({
    id,
    path: `${DOCS_ROOT}/${path}`,
    kind: "concept",
    eyebrow: "Concepts",
    title,
    nav,
    description,
    sections,
  });
  const rows: Inline[][] = PLAN_AVAILABILITY.map((r) => [
    r.kind === "endpoint"
      ? `\`${r.method}\` [${r.path}](${referencePath(API_ENDPOINTS.find((e) => e.method === r.method && e.path === r.path)?.id ?? "")})`
      : `[\`${r.name}\`](${eventPath(r.name)})`,
    r.since,
    ...API_PLANS.map((p) => (r.plans.includes(p) ? "✓" : "—")),
  ]);
  return [
    concept(
      "errors",
      "errors",
      "Errors",
      "Errors",
      "Every error the API answers with, by status, with what to do about it in plain words.",
      [
        {
          id: "shape",
          title: "The shape of an error",
          blocks: [
            {
              kind: "p",
              text: "Every error is JSON with `error` (a sentence for people) and `code` (stable, for programs). When an error says nothing was sent, nothing was.",
            },
            {
              kind: "p",
              text: `A message WhatsApp accepted can still fail a few seconds later: that comes in \`message.failed\` with WhatsApp's own numbered code — see [Know it was delivered](${guidePath("know-it-was-delivered")}) and [Common WhatsApp errors](${guidePath("whatsapp-errors")}).`,
            },
          ],
          code: {
            title: "An error",
            status: 402,
            samples: [
              code(
                "json",
                "Response",
                json({
                  error:
                    "There aren't enough credits in this workspace's AiDwar wallet to send this message. Top up and send again. Nothing was sent.",
                  code: "insufficient_credits",
                }),
              ),
            ],
          },
        },
        ...API_ERRORS.map((row) => ({
          id: `status-${row.status}`,
          title: `${row.status} — ${STATUS_NAMES[row.status] ?? "Error"}`,
          blocks: [
            { kind: "p" as const, text: row.meaning },
            { kind: "errors" as const, status: row.status },
          ],
        })),
      ],
    ),
    concept(
      "rate-limits",
      "rate-limits",
      "Rate limits",
      "Rate limits",
      `${RATE_PER_KEY_PER_MIN} requests a minute per key and ${RATE_PER_WORKSPACE_PER_MIN} a minute per workspace, counted across every endpoint.`,
      [
        {
          id: "limits",
          title: "The limits",
          blocks: [
            {
              kind: "table",
              head: ["Limit", "Per minute"],
              rows: [
                ["One API key", String(RATE_PER_KEY_PER_MIN)],
                ["One workspace (all its keys together)", String(RATE_PER_WORKSPACE_PER_MIN)],
              ],
            },
            {
              kind: "p",
              text: "Over a limit you get **429 rate_limited** with a `Retry-After` header: wait that many seconds and try again. Sending to many customers? Use a campaign — one call, sent at WhatsApp's own pace.",
            },
            {
              kind: "p",
              text: `A template send with copies (\`cc\`, or your workspace's default copy numbers) counts as **1 + the number of copies**: one call with 2 copies uses 3 of the minute's requests, and a call with ${MAX_CC} copies (the most) counts as ${MAX_CC + 1}. A retry that gets its first answer back counts as 1. If the copies would go over a limit, the whole call is refused with 429 and nothing is sent.`,
            },
          ],
          code: {
            title: "429",
            status: 429,
            samples: [
              code(
                "json",
                "Response",
                json({
                  error: `Too many requests: the limit is ${RATE_PER_KEY_PER_MIN} requests a minute per API key. Try again in 42 s.`,
                  code: "rate_limited",
                }),
              ),
            ],
          },
        },
      ],
    ),
    concept(
      "idempotency",
      "idempotency",
      "Idempotency",
      "Idempotency",
      `Retry any send safely: the same idempotency key within ${IDEMPOTENCY_WINDOW_HOURS} hours gets the first answer back and is never sent twice.`,
      [
        {
          id: "how",
          title: "How it works",
          blocks: [
            {
              kind: "list",
              items: [
                "Send `idempotency_key` in the body, or the `Idempotency-Key` header: 1–255 letters, digits or `_ - . :`.",
                `Within ${IDEMPOTENCY_WINDOW_HOURS} hours, the same key with the same request returns the first answer, with \`Idempotent-Replayed: true\`.`,
                "The same key with a *different* request is **409 idempotency_key_reused**; while the first is still being sent, **409 idempotency_in_progress** with `Retry-After`.",
                "A request refused before sending (say, not enough credits) frees its key: fix the cause and send again with it.",
                "Copies (`cc` on a template send) each get their own key, `<key>:cc:<number>` (for example `inv-1001:cc:+918000000001`), so a retry never sends a copy twice. Without a key, copies get none either.",
              ],
            },
          ],
          code: {
            title: "Replayed",
            samples: [code("bash", "Headers", "HTTP/1.1 202 Accepted\nIdempotent-Replayed: true")],
          },
        },
        {
          id: "resend",
          title: "Resend on purpose",
          blocks: [
            {
              kind: "list",
              items: [
                `**The same key within ${IDEMPOTENCY_WINDOW_HOURS} hours never sends again.** It returns the first answer — whatever it was, a \`202\` or a \`502 whatsapp_rejected\` — with \`Idempotent-Replayed: true\`.`,
                `**To send it again on purpose, use a new key.** Add \`-r1\`, \`-r2\`… to the first one: \`${INVOICE_KEY}\`, then \`${INVOICE_KEY}-r1\`, \`${INVOICE_KEY}-r2\`.`,
                `**After ${IDEMPOTENCY_WINDOW_HOURS} hours the same key sends again**, as a new message. Keep your own record of what you sent rather than relying on an old key.`,
                "**The same key with a changed body** — another number, amount or PDF link — is **409 idempotency_key_reused**, and nothing is sent.",
                "Keys belong to the workspace: every API key of one workspace shares them.",
                `**Copies follow the main key** (\`<key>:cc:<number>\`): a resend with \`${INVOICE_KEY}-r1\` sends the copies again too, as \`${INVOICE_KEY}-r1:cc:+918000000001\`. Send \`"cc": []\` to resend to the customer only.`,
              ],
            },
          ],
          code: {
            title: "Send it again",
            samples: requestSamples(endpoint("send-template"), INVOICE_RESEND_BODY),
          },
        },
      ],
    ),
    concept(
      "window",
      "24-hour-window",
      "The 24-hour window",
      "The 24-hour window",
      "When you may send free-form messages and when only an approved template can reach a customer.",
      [
        {
          id: "window",
          title: "Open or closed",
          blocks: [
            { kind: "window" },
            {
              kind: "list",
              items: [
                "**Open** — for 24 hours after the customer's last message. Send anything: text, files, buttons, lists, with " +
                  ref("send-session") +
                  ".",
                "**Closed** — only an approved template, with " +
                  ref("send-template") +
                  ". A session send answers **409 window_closed** and nothing is sent.",
                "Each new customer message opens a fresh 24 hours.",
              ],
            },
            {
              kind: "p",
              text: "Templates can be sent at any time — inside the window or outside it. A reply inside the window is priced as a service message; a template by its category (utility, marketing or authentication). See the message credit rates on the pricing page, [aidwar.in/pricing](/pricing).",
            },
          ],
        },
      ],
    ),
    concept(
      "plans",
      "plans",
      "Availability by plan",
      "Availability by plan",
      "Which plans include each endpoint and webhook event.",
      [
        {
          id: "table",
          title: "Endpoints and events",
          blocks: [
            {
              kind: "p",
              text: "An endpoint outside your plan answers **403 endpoint_not_in_plan**, and `plan_needed` names the plan that has it.",
            },
            {
              kind: "table",
              head: ["Endpoint or event", "Since", ...API_PLANS.map((p) => PLAN_LABELS[p])],
              rows,
            },
          ],
        },
      ],
    ),
    concept(
      "changelog",
      "changelog",
      "Changelog",
      "Changelog",
      "What changed in each version of the AiDwar API.",
      [
        {
          id: "v1-2",
          title: "v1.2 — October 2026",
          blocks: [
            {
              kind: "list",
              items: [
                "**Campaigns:** create, estimate, list, follow and cancel campaigns; `campaign.completed`.",
                "**Inbox:** list conversations, assign, close, reopen and tag.",
                "**Webhooks:** up to 5 webhooks, each with its own secret and events, managed from the API; a test event per webhook; the event catalogue.",
                "**Account events:** `phone_number.quality_changed`, `messaging_limit.changed`, `account.status_changed`.",
                "Availability by plan; the Try it console in Settings; these docs, the OpenAPI description and llms.txt.",
              ],
            },
          ],
        },
        {
          id: "v1-1",
          title: "v1.1 — October 2026",
          blocks: [
            {
              kind: "list",
              items: [
                "Any approved template: text, image, video, document and location headers, buttons and offers.",
                "Free-form messages inside the 24-hour window: text, files, reply buttons and lists.",
                "Contacts (with consent), templates, wallet balance and prices; files customers send.",
                "Events: `message.received`, `contact.created`, `contact.opted_out`, `contact.opted_in`, `template.status_changed`, `template.category_changed`.",
              ],
            },
          ],
        },
        {
          id: "v1-0",
          title: "v1.0 — October 2026",
          blocks: [
            {
              kind: "list",
              items: [
                "API keys, rate limits and idempotency.",
                "Send an approved document template — an invoice PDF — and look its status up.",
                "Delivery updates on a signed webhook: `message.sent`, `message.delivered`, `message.read`, `message.failed`.",
              ],
            },
          ],
        },
      ],
    ),
  ];
}

/** What each error code means, in plain words (the group rows in API_ERRORS say the rest). */
export const ERROR_MEANINGS: Record<string, string> = {
  invalid_json: "The body isn't valid JSON.",
  invalid_to: "`to` isn't a WhatsApp number with its country code.",
  invalid_template_name: "`template_name` is missing or not a template name.",
  invalid_document: "`document` needs a `url` or `base64`, and a `filename`.",
  invalid_body_params: "`body_params` must be a list of strings.",
  invalid_idempotency_key:
    "The idempotency key is too long or uses characters other than letters, digits, `_ - . :`.",
  template_not_found: "No template with this name (and language) on your number.",
  template_not_approved: "The template exists but WhatsApp hasn't approved it yet.",
  template_not_document: "The `document` shortcut needs a template with a document header.",
  template_unsupported: "This template has a part the API can't fill (for example a carousel).",
  language_required: "The template is approved in more than one language.",
  param_count_mismatch:
    "The number of values doesn't match the template's `{{1}}`, `{{2}}`… placeholders.",
  document_url_not_https: "The document's link must start with `https://`.",
  document_url_blocked: "The document's link points at a private or local address.",
  document_unreachable: "The document's link didn't answer, or answered with an error.",
  document_not_pdf: "The document isn't a PDF.",
  document_empty: "The document is empty.",
  document_type_unsupported: "WhatsApp doesn't accept this kind of document.",
  no_whatsapp_number: "The workspace has no connected WhatsApp number.",
  invalid_header: "`header` isn't one of the shapes this endpoint accepts.",
  header_required: "The template has a header, and the request doesn't fill it.",
  header_mismatch:
    "The header in the request isn't the kind the template has (for example an image for a video header).",
  invalid_buttons: "A button's `index`, `type` or value doesn't match the template's buttons.",
  invalid_offer:
    "`offer_expires_at` is missing, in the past, or the template has no offer countdown.",
  invalid_cc: `\`cc\` must be a list of at most ${MAX_CC} WhatsApp numbers with their country code (duplicates and the \`to\` number are removed).`,
  invalid_media: "The file needs a `url` or `base64`.",
  media_url_not_https: "The file's link must start with `https://`.",
  media_url_blocked: "The file's link points at a private or local address.",
  media_unreachable: "The file's link didn't answer, or answered with an error.",
  media_empty: "The file is empty.",
  media_type_unsupported: "WhatsApp doesn't accept this kind of file.",
  invalid_message: "The message needs `text`, or one file.",
  invalid_contact: "The contact needs a valid `phone`; `name`, `email` and `tags` are optional.",
  invalid_contacts: "`contacts` must be a list of contacts.",
  too_many_contacts: "More contacts than one request takes.",
  duplicate_phone: "The same phone appears twice in one request.",
  invalid_tags: "`tags` must be a list of short strings.",
  invalid_filter: "A filter value isn't one this list accepts.",
  invalid_limit: "`limit` is out of range.",
  invalid_cursor: "The `cursor` isn't one this list gave you.",
  invalid_name: "`name` is missing or too long.",
  invalid_audience: "`audience` needs exactly one of `segment_id`, `tag`, `phones` or `all`.",
  invalid_variables: "Per-customer `variables` must be lists of strings.",
  missing_variables: "Some template values are missing — for everyone or for one customer.",
  invalid_schedule_at: "`schedule_at` isn't a future ISO 8601 time.",
  header_media_required: "The template's header needs a picture, a video or a document.",
  coupon_code_required: "The template has a copy-code button and no `coupon_code`.",
  invalid_status: "`status` isn't one this list accepts.",
  invalid_assignee: "`assignee` must be a member's email, or null to unassign.",
  assignee_not_member: "Nobody in your workspace has this email.",
  invalid_updated_since: "`updated_since` isn't an ISO 8601 time.",
  invalid_url: "The webhook address must be an `https://` URL.",
  invalid_events: "One of the `events` isn't an event name (see the list of events).",
  unauthorized: "No API key, a mistyped one, or a revoked one.",
  insufficient_credits: "The wallet can't cover this message. Nothing was sent.",
  workspace_locked: "The workspace has no active plan. Nothing was sent.",
  public_api_disabled: "The API isn't switched on for this workspace.",
  invalid_media_link: "This file link wasn't made for this API key.",
  endpoint_not_in_plan:
    "This endpoint isn't part of your plan; `plan_needed` names the plan that has it.",
  not_found: "Nothing with this id or phone in your workspace.",
  segment_not_found: "No segment with this id in your workspace.",
  tag_not_found: "No contact has this tag.",
  contact_opted_out: "The customer opted out of marketing, so a marketing template isn't sent.",
  window_closed: "The customer hasn't written in the last 24 hours, so only templates can be sent.",
  idempotency_key_reused: "This key was already used for a different request.",
  idempotency_in_progress: "The first request with this key is still being sent.",
  campaign_finished: "The campaign already finished sending.",
  webhook_limit_reached: "The workspace already has 5 webhooks.",
  media_link_expired: "The file's download link is older than 5 minutes.",
  document_too_large: "The document is over its size limit.",
  media_too_large: "The file is over its size limit.",
  request_too_large: "The request body is too large.",
  rate_limited: "Too many requests this minute.",
  whatsapp_upload_failed: "WhatsApp didn't take the file.",
  whatsapp_rejected: "WhatsApp refused the message; it shows in your inbox, marked failed.",
  media_unavailable: "The file couldn't be fetched just now.",
  unavailable: "AiDwar couldn't finish the request just now.",
  internal_error: "Something went wrong on our side.",
};

/** The codes an errors block lists: an endpoint's own (plus the two any call can get), or one status's. */
export function errorCodes(b: { endpointId?: string; status?: string }): string[] {
  if (b.endpointId) {
    const e = API_ENDPOINTS.find((x) => x.id === b.endpointId)!;
    return Array.from(new Set([...e.errors, "unauthorized", "rate_limited"]));
  }
  return API_ERRORS.find((r) => r.status === b.status)?.codes ?? [];
}

/** What one error code means. */
export function errorMeaning(codeName: string): string {
  return ERROR_MEANINGS[codeName] ?? errorRow(codeName)?.meaning ?? "";
}

/** What to do about one error code, in plain words. */
export function whatToDo(status: string, codeName: string): string {
  const specific: Record<string, string> = {
    unauthorized:
      "Check the key: sent as `Authorization: Bearer adw_live_…`, copied whole, not revoked.",
    public_api_disabled:
      "Ask AiDwar to switch the API on — it is part of the Scale and Enterprise plans.",
    endpoint_not_in_plan: "Move to the plan named in `plan_needed`.",
    insufficient_credits: "Top up your AiDwar wallet in Billing, then send again.",
    workspace_locked: "Choose a plan in AiDwar; nothing is sent while the workspace is locked.",
    rate_limited: "Wait the seconds in `Retry-After`, then try again.",
    window_closed: "Send an approved template instead of a free-form message.",
    contact_opted_out:
      "Don't send marketing to this customer. Utility templates (order updates, codes) still reach them.",
    idempotency_key_reused:
      "Use a new key for a new request. To resend the same message on purpose, add `-r1`, `-r2`… to the key.",
    whatsapp_rejected:
      "Don't retry with the same key: it gives this answer back. Read the reason (Common WhatsApp errors), fix it, then send with a new key.",
    idempotency_in_progress: "Wait a few seconds and ask again with the same key.",
    campaign_finished: "Nothing to cancel: it already finished.",
    webhook_limit_reached: "Remove a webhook you no longer use, then add the new one.",
    template_not_approved:
      "Wait for WhatsApp to approve the template (Templates in AiDwar shows its status).",
    template_not_found: "Check the template's name and language in Templates.",
    language_required: "Say which language with `language`.",
    no_whatsapp_number: "Connect a WhatsApp number in AiDwar first.",
    media_link_expired: "Ask for a new download link.",
    not_found: "Check the id or phone — another workspace's items are never visible.",
    segment_not_found: "Check the segment id in AiDwar.",
    tag_not_found: "Check the tag's name (any case).",
    assignee_not_member: "Invite the person to your workspace first, or use a member's email.",
    missing_variables: "Give every template value, for everyone or per customer.",
  };
  if (specific[codeName]) return specific[codeName]!;
  if (status === "400") return "Fix the request and send it again — nothing was sent or changed.";
  if (status === "413") return "Send a smaller file (see the limits in the message).";
  if (status === "5xx") return "Try again — with the same idempotency key, it is never sent twice.";
  return errorRow(codeName)?.meaning ?? "See the message.";
}

// ------------------------------------------------------------ the whole site

let cached: Page[] | null = null;

export function allPages(): Page[] {
  if (cached) return cached;
  cached = [
    overviewPage(),
    quickstartPage(),
    ...guidePages(),
    referenceIndexPage(),
    ...referencePages(),
    webhooksIndexPage(),
    ...eventPages(),
    ...conceptPages(),
  ];
  return cached;
}

export function pageByPath(path: string): Page | null {
  const clean = path.replace(/\/+$/, "") || DOCS_ROOT;
  return allPages().find((p) => p.path === clean) ?? null;
}

export function pageById(id: string): Page {
  const p = allPages().find((x) => x.id === id);
  if (!p) throw new Error(`no docs page ${id}`);
  return p;
}

// ------------------------------------------------------------ the sidebar

export type NavItem = { label: string; href: string; method?: string };
export type NavGroup = {
  title: string;
  items: NavItem[];
  groups?: Array<{ title: string; items: NavItem[] }>;
};

export function navigation(): NavGroup[] {
  const pages = allPages();
  const byKind = (kind: PageKind) => pages.filter((p) => p.kind === kind);
  return [
    {
      title: "Get started",
      items: [
        { label: "Overview", href: DOCS_ROOT },
        { label: "Quickstart", href: `${DOCS_ROOT}/quickstart` },
      ],
    },
    {
      title: "Guides",
      items: byKind("guide")
        .filter((p) => p.id !== "quickstart")
        .map((p) => ({ label: p.nav, href: p.path })),
    },
    {
      title: "API reference",
      items: [{ label: "All endpoints", href: `${DOCS_ROOT}/reference` }],
      groups: GROUP_ORDER.map((group) => ({
        title: group,
        items: API_ENDPOINTS.filter((e) => e.group === group).map((e) => ({
          label: e.title.replace(/\s*\([^)]*\)$/, ""),
          href: referencePath(e.id),
          method: e.method,
        })),
      })),
    },
    {
      title: "Webhooks",
      items: [
        { label: "Overview", href: `${DOCS_ROOT}/webhooks` },
        ...WEBHOOK_EVENTS.map((ev) => ({ label: ev.name, href: eventPath(ev.name) })),
      ],
    },
    {
      title: "Concepts",
      items: [
        { label: "Errors", href: `${DOCS_ROOT}/errors` },
        { label: "Rate limits", href: `${DOCS_ROOT}/rate-limits` },
        { label: "Idempotency", href: `${DOCS_ROOT}/idempotency` },
        { label: "The 24-hour window", href: `${DOCS_ROOT}/24-hour-window` },
        { label: "Availability by plan", href: `${DOCS_ROOT}/plans` },
        { label: "Changelog", href: `${DOCS_ROOT}/changelog` },
      ],
    },
    {
      title: "Downloads",
      items: [
        { label: "Postman collection", href: POSTMAN_PATH },
        { label: "OpenAPI 3.1 (JSON)", href: OPENAPI_PATH },
        { label: "llms.txt (for AI tools)", href: LLMS_PATH },
      ],
    },
  ];
}

// ------------------------------------------------------------ search

export type SearchEntry = {
  title: string;
  href: string;
  kind: string;
  text: string;
  method?: string;
  path?: string;
};

export function searchIndex(): SearchEntry[] {
  return allPages().map((p) => ({
    title: p.title,
    href: p.path,
    kind:
      p.kind === "reference"
        ? "Endpoint"
        : p.kind === "event"
          ? "Event"
          : p.kind === "guide"
            ? "Guide"
            : "Page",
    text: `${p.description} ${p.endpoint ? `${p.endpoint.method} ${p.endpoint.path} ${p.endpoint.id}` : ""}`.trim(),
    ...(p.endpoint ? { method: p.endpoint.method, path: p.endpoint.path } : {}),
  }));
}

/** Entries matching every word of the query, best first (title, then path, then text). */
export function search(entries: SearchEntry[], query: string, limit = 8): SearchEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored = entries
    .map((e, order) => {
      const title = e.title.toLowerCase();
      const hay = `${title} ${(e.path ?? "").toLowerCase()} ${(e.method ?? "").toLowerCase()} ${e.text.toLowerCase()}`;
      if (!words.every((w) => hay.includes(w))) return null;
      let score = 0;
      for (const w of words) {
        if (title.startsWith(w)) score += 6;
        else if (title.includes(w)) score += 4;
        if ((e.path ?? "").toLowerCase().includes(w)) score += 2;
        score += 1;
      }
      if (e.kind === "Endpoint") score += 0.5;
      return { e, score, order };
    })
    .filter((x): x is { e: SearchEntry; score: number; order: number } => x !== null)
    // Ties keep the docs' own order (create before list before cancel).
    .sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, limit).map((x) => x.e);
}

// ------------------------------------------------------------ Markdown (Copy page, llms.txt)

const abs = (href: string) => (href.startsWith("/") ? `${ORIGIN}${href}` : href);
/** Inline text with relative links made absolute (for pasting elsewhere). */
const md = (text: Inline) => text.replace(/\]\((\/[^)]*)\)/g, (_, h: string) => `](${abs(h)})`);

function fence(s: Sample): string {
  const lang = s.lang === "node" ? "js" : s.lang === "curl" ? "bash" : s.lang;
  return `\`\`\`${lang}\n${s.code}\n\`\`\``;
}

function table(head: string[], rows: string[][]): string {
  const esc = (c: string) => c.replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `| ${head.map(esc).join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`),
  ].join("\n");
}

/** One payload's fields: name, type, example. */
export function payloadRows(value: unknown, prefix = ""): Array<[string, string, string]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => {
    const name = `${prefix}${k}`;
    const type = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
    const sample = v === null || typeof v !== "object" ? JSON.stringify(v) : "";
    const row: [string, string, string] = [
      name,
      type,
      sample.length > 48 ? `${sample.slice(0, 45)}…"` : sample,
    ];
    const nested = Array.isArray(v) ? payloadRows(v[0], `${name}[].`) : payloadRows(v, `${name}.`);
    return [row, ...nested];
  });
}

function blockMarkdown(b: Block): string {
  switch (b.kind) {
    case "p":
      return md(b.text);
    case "h3":
      return `### ${b.text}`;
    case "list":
      return b.items.map((x, i) => `${b.ordered ? `${i + 1}.` : "-"} ${md(x)}`).join("\n");
    case "table":
      return table(
        b.head,
        b.rows.map((r) => r.map(md)),
      );
    case "callout":
      return `> **${b.title}** — ${md(b.text)}`;
    case "code":
      return b.group.samples.map(fence).join("\n\n");
    case "cards":
      return b.cards.map((c) => `- **[${c.title}](${abs(c.href)})** — ${md(c.text)}`).join("\n");
    case "steps":
      return b.steps
        .map((s) => `**${s.title}**\n\n${md(s.text)}\n\n✓ ${md(s.success)}`)
        .join("\n\n");
    case "window":
      return "```text\ncustomer writes ──► window OPEN (24 h): session messages and templates\n24 h of silence ──► window CLOSED: approved templates only\n```";
    case "params": {
      const e = API_ENDPOINTS.find((x) => x.id === b.endpointId)!;
      const fields = e.fields ?? [];
      if (!fields.length) return "No parameters.";
      return table(
        ["Name", "In", "Type", "Required", "Description"],
        fields.map((f) => [
          `\`${f.name}\``,
          f.in,
          f.type,
          f.required ? "yes" : "no",
          f.description + (f.example ? ` Example: \`${f.example}\`.` : ""),
        ]),
      );
    }
    case "errors":
      return table(
        ["Status", "Code", "What it means", "What to do"],
        errorCodes(b).map((c) => [
          errorRow(c)?.status ?? "",
          `\`${c}\``,
          errorMeaning(c),
          whatToDo(errorRow(c)?.status ?? "", c),
        ]),
      );
    case "payload": {
      const ev = WEBHOOK_EVENTS.find((x) => x.name === b.event)!;
      return table(
        ["Field", "Type", "Example"],
        payloadRows(ev.example).map(([n, t, x]) => [`\`${n}\``, t, x ? `\`${x}\`` : ""]),
      );
    }
    case "preview":
      return "";
    case "links":
      return b.items
        .map((l) => `- [${l.method ? `${l.method} ` : ""}${l.label}](${abs(l.href)})`)
        .join("\n");
  }
}

/** The page as Markdown: its prose, its tables and every code sample, links made absolute. */
export function pageMarkdown(page: Page): string {
  const parts: string[] = [`# ${page.title}`, page.description];
  if (page.endpoint) {
    const e = page.endpoint;
    parts.push(
      `\`${e.method} ${ORIGIN}${e.path}\` — Authorization: Bearer <your API key>. Available on ${endpointPlans(e)}. Since ${e.since ?? "v1.0"}.`,
    );
  }
  for (const s of page.sections) {
    if (s.title) parts.push(`## ${s.title}`);
    for (const b of s.blocks) {
      const out = blockMarkdown(b);
      if (out) parts.push(out);
    }
    if (s.code) parts.push(s.code.samples.map(fence).join("\n\n"));
  }
  return `${parts.filter(Boolean).join("\n\n").trim()}\n`;
}

/** /llms.txt: what the docs hold, with a link to each page (llmstxt.org). */
export function llmsTxt(): string {
  const pages = allPages();
  const section = (title: string, list: Page[]) =>
    [`## ${title}`, ...list.map((p) => `- [${p.title}](${abs(p.path)}): ${p.description}`)].join(
      "\n",
    );
  return (
    [
      "# AiDwar API",
      "> Send WhatsApp messages (templates, invoices, replies), run campaigns, manage contacts and the inbox, and receive webhooks from your own software. REST + JSON over HTTPS with a bearer API key.",
      `Base URL: ${BASE_URL}. Full text of every page: ${abs(LLMS_FULL_PATH)}. OpenAPI: ${abs(OPENAPI_PATH)}.`,
      section(
        "Get started",
        pages.filter((p) => p.kind === "overview" || p.id === "quickstart"),
      ),
      section(
        "Guides",
        pages.filter((p) => p.kind === "guide" && p.id !== "quickstart"),
      ),
      section(
        "API reference",
        pages.filter((p) => p.kind === "reference"),
      ),
      section(
        "Webhook events",
        pages.filter((p) => p.kind === "event" || p.id === "webhooks"),
      ),
      section(
        "Concepts",
        pages.filter((p) => p.kind === "concept"),
      ),
    ].join("\n\n") + "\n"
  );
}

/** /llms-full.txt: every page's Markdown, one after another. */
export function llmsFullTxt(): string {
  return allPages().map(pageMarkdown).join("\n---\n\n");
}

/** Old /developers/api#anchors -> their new pages. */
export const LEGACY_ANCHORS: Record<string, string> = Object.fromEntries([
  ["authentication", `${DOCS_ROOT}/reference`],
  ["send", referencePath("send-template")],
  ["status", referencePath("message-status")],
  ["errors", `${DOCS_ROOT}/errors`],
  ["idempotency", `${DOCS_ROOT}/idempotency`],
  ["webhooks", `${DOCS_ROOT}/webhooks`],
  ["webhook", `${DOCS_ROOT}/webhooks`],
  ["signature", guidePath("verify-webhook-signatures")],
  ["rate-limits", `${DOCS_ROOT}/rate-limits`],
  ["limits", `${DOCS_ROOT}/rate-limits`],
  ["postman", POSTMAN_PATH],
  ["events", `${DOCS_ROOT}/webhooks`],
  ["reference", `${DOCS_ROOT}/reference`],
  ["window", `${DOCS_ROOT}/24-hour-window`],
  ...API_ENDPOINTS.map((e) => [e.id, referencePath(e.id)]),
  ...WEBHOOK_EVENTS.map((ev) => [`event-${ev.name}`, eventPath(ev.name)]),
]);
