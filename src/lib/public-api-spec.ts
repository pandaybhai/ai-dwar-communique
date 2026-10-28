/**
 * Batch 37 item 7: the Public API's one description — every endpoint (its
 * request, an example, its answer, its error codes) and every webhook event
 * (when it comes, an example body). /developers/api renders it and
 * /developers/api.postman.json is generated from it, so the docs and the
 * Postman collection can't drift; batch37-docs.test.tsx checks every example
 * against the server's own request checks and payload builders. Pure: no
 * server code.
 */
import {
  ALL_WEBHOOK_EVENTS,
  API_ERRORS,
  API_ORIGIN,
  MAX_BULK_CONTACTS,
  MEDIA_LINK_SECONDS,
  MEDIA_LIMITS,
  WEBHOOK_BODY_EXAMPLE,
} from "@/lib/public-api";

export type ApiVersion = "v1.0" | "v1.1" | "v1.2";

/** One request field the docs' parameter table shows (Batch 38). */
export type FieldDoc = {
  name: string;
  in: "path" | "query" | "body";
  type: string;
  required: boolean;
  description: string;
  example?: string;
};

/** One more answer worth showing on the endpoint's page (an error, a variant). */
export type ResponseDoc = { status: number; label: string; body: unknown };

export type ApiEndpoint = {
  /** Anchor on the docs page and the Postman item's id. */
  id: string;
  group:
    | "Messages"
    | "Media"
    | "Contacts"
    | "Templates"
    | "Account"
    | "Campaigns"
    | "Inbox"
    | "Webhooks";
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** With {params}. */
  path: string;
  title: string;
  summary: string;
  /** Values for the path's {params} in the examples. */
  params?: Record<string, string>;
  query?: Array<{ name: string; description: string; example?: string }>;
  body?: Record<string, unknown>;
  /** More request bodies worth showing (and having in Postman), each with a label. */
  more?: Array<{ label: string; body: Record<string, unknown> }>;
  response: { status: number; body: unknown };
  errors: string[];
  /** Batch 38: the version it came in (filled below for every endpoint). */
  since?: ApiVersion;
  /** Batch 38: every path, query and body field, for the reference page's table. */
  fields?: FieldDoc[];
  /** Batch 38: more answers shown on the reference page. */
  responses?: ResponseDoc[];
  /** Batch 38: one sentence for business readers (the page's lead and its search entry). */
  purpose?: string;
};

const MESSAGE_ID = "6f1c2b0e-3c4d-4f7a-9a51-2f0d8c1e7b42";
const CUSTOMER = "+919812345678";

const CONTACT_EXAMPLE = {
  phone: CUSTOMER,
  wa_id: "919812345678",
  name: "Asha Rao",
  opt_in_status: "opted_in",
  attributes: { city: "Pune", customer_id: "C-1042" },
  tags: ["vip"],
  source: "api",
  created_at: "2026-10-28T09:00:00.000Z",
  updated_at: "2026-10-28T09:00:00.000Z",
};

const TEMPLATE_EXAMPLE = {
  name: "order_shipped",
  language: "en",
  category: "UTILITY",
  status: "APPROVED",
  rejection_reason: null,
  components: [
    { type: "HEADER", format: "IMAGE" },
    { type: "BODY", text: "Hi {{1}}, your order {{2}} is on its way." },
    {
      type: "BUTTONS",
      buttons: [{ type: "URL", text: "Track", url: "https://shop.example.com/track/{{1}}" }],
    },
  ],
  send: {
    header: { type: "image", required: true },
    body_params: 2,
    buttons: [{ index: 0, type: "url", text: "Track", takes: "url_param", required: true }],
    offer_expires_at: false,
    sendable: true,
  },
  updated_at: "2026-10-20T11:00:00.000Z",
};

const SENT = {
  message_id: MESSAGE_ID,
  status: "queued",
  wamid: "wamid.HBgM…",
  idempotency_key: "ord-1042-shipped",
};

export const API_ENDPOINTS: ApiEndpoint[] = [
  {
    id: "send-template",
    group: "Messages",
    method: "POST",
    path: "/api/v1/messages/template",
    title: "Send a template",
    summary:
      "Any approved template, at any time: its header (none, text values, an image, a video, a document or a map pin), its body values and its buttons' values, all checked against the template before anything is sent. The original invoice request ({ document, body_params }) still works exactly as it did.",
    body: {
      to: CUSTOMER,
      template_name: "order_shipped",
      language: "en",
      header: { type: "image", url: "https://cdn.example.com/parcel.jpg" },
      body_params: ["Asha", "#1042"],
      buttons: [{ index: 0, type: "url", url_param: "1042" }],
      idempotency_key: "ord-1042-shipped",
    },
    more: [
      {
        label: "an invoice PDF (the document request)",
        body: {
          to: CUSTOMER,
          template_name: "invoice_document",
          document: { url: "https://billing.example.com/INV-1001.pdf", filename: "INV-1001.pdf" },
          body_params: ["Asha", "INV-1001", "2,500.00"],
          idempotency_key: "inv-1001",
        },
      },
      {
        label: "a text header, a quick reply and a coupon",
        body: {
          to: CUSTOMER,
          template_name: "festive_offer",
          header: { type: "text", params: ["Diwali"] },
          body_params: ["Asha"],
          buttons: [
            { index: 0, type: "quick_reply", payload: "STOP_OFFERS" },
            { index: 1, type: "copy_code", code: "DIWALI20" },
          ],
        },
      },
    ],
    response: { status: 202, body: SENT },
    errors: [
      "invalid_to",
      "template_not_found",
      "template_not_approved",
      "language_required",
      "template_not_document",
      "template_unsupported",
      "invalid_header",
      "header_required",
      "header_mismatch",
      "param_count_mismatch",
      "invalid_buttons",
      "invalid_offer",
      "media_too_large",
      "contact_opted_out",
      "insufficient_credits",
      "workspace_locked",
      "idempotency_key_reused",
      "whatsapp_rejected",
    ],
  },
  {
    id: "send-session",
    group: "Messages",
    method: "POST",
    path: "/api/v1/messages/session",
    title: "Send a free-form message (24-hour window)",
    summary:
      "Inside the customer's 24-hour window: text (WhatsApp *bold* _italic_ ~strike~ ```mono``` as you write it), an image / video / audio file / document, up to 3 reply buttons, or a list. It leaves from the number the customer last wrote to and is charged like a reply from your inbox. Outside the window: 409 window_closed — send a template instead.",
    body: {
      to: CUSTOMER,
      type: "text",
      text: "Hi *Asha*, your order #1042 has shipped.",
      idempotency_key: "ship-1042",
    },
    more: [
      {
        label: "reply buttons",
        body: {
          to: CUSTOMER,
          type: "buttons",
          body: "When should we deliver?",
          buttons: [
            { id: "am", title: "Morning" },
            { id: "pm", title: "Evening" },
          ],
        },
      },
      {
        label: "a list",
        body: {
          to: CUSTOMER,
          type: "list",
          body: "Pick a size",
          button: "Sizes",
          sections: [
            { title: "Regular", rows: [{ id: "m", title: "M", description: "Chest 40" }] },
            {
              title: "Large",
              rows: [
                { id: "l", title: "L" },
                { id: "xl", title: "XL" },
              ],
            },
          ],
        },
      },
      {
        label: "a document",
        body: {
          to: CUSTOMER,
          type: "document",
          document: {
            url: "https://billing.example.com/receipt-1042.pdf",
            filename: "receipt-1042.pdf",
            caption: "Your receipt",
          },
        },
      },
    ],
    response: { status: 202, body: { ...SENT, idempotency_key: "ship-1042" } },
    errors: [
      "invalid_message",
      "invalid_to",
      "window_closed",
      "media_type_unsupported",
      "media_too_large",
      "workspace_locked",
      "idempotency_key_reused",
      "whatsapp_rejected",
    ],
  },
  {
    id: "message-status",
    group: "Messages",
    method: "GET",
    path: "/api/v1/messages/{message_id}",
    title: "A message's status",
    summary:
      "What happened to a message the API sent: queued, sent, delivered, read or failed (with the reason), and when.",
    params: { message_id: MESSAGE_ID },
    response: {
      status: 200,
      body: {
        message_id: MESSAGE_ID,
        status: "delivered",
        to: CUSTOMER,
        template_name: "order_shipped",
        idempotency_key: "ord-1042-shipped",
        wamid: "wamid.HBgM…",
        error: null,
        created_at: "2026-10-28T10:00:00.000Z",
        sent_at: "2026-10-28T10:00:02.000Z",
        delivered_at: "2026-10-28T10:00:05.000Z",
        read_at: null,
        failed_at: null,
        updated_at: "2026-10-28T10:00:05.000Z",
      },
    },
    errors: ["not_found"],
  },
  {
    id: "media-link",
    group: "Media",
    method: "GET",
    path: "/api/v1/media/{message_id}",
    title: "A message's file",
    summary: `The file a customer sent (message.received gives this address as media.url) or one you sent: what it is, and a download link that works for ${MEDIA_LINK_SECONDS / 60} minutes and only with the same API key.`,
    params: { message_id: MESSAGE_ID },
    response: {
      status: 200,
      body: {
        message_id: MESSAGE_ID,
        mime_type: "image/jpeg",
        filename: `${MESSAGE_ID}.jpg`,
        url: `${API_ORIGIN}/api/v1/media/${MESSAGE_ID}/download?expires=1793000300&signature=9c1f…`,
        expires_at: "2026-10-28T10:05:00.000Z",
      },
    },
    errors: ["not_found"],
  },
  {
    id: "media-download",
    group: "Media",
    method: "GET",
    path: "/api/v1/media/{message_id}/download",
    title: "Download a message's file",
    summary:
      "The bytes, for the link GET /api/v1/media/{message_id} gave, with the same API key in the Authorization header. Save them to your own storage: the link expires.",
    params: { message_id: MESSAGE_ID },
    query: [
      { name: "expires", description: "From the link.", example: "1793000300" },
      { name: "signature", description: "From the link.", example: "9c1f…" },
    ],
    response: { status: 200, body: "(the file's bytes, with its Content-Type)" },
    errors: ["invalid_media_link", "media_link_expired", "not_found", "media_unavailable"],
  },
  {
    id: "contact-upsert",
    group: "Contacts",
    method: "POST",
    path: "/api/v1/contacts",
    title: "Create or update a contact",
    summary:
      'By phone. attributes are merged into the contact\'s (null removes a key); tags are added. opted_in: true records the customer\'s consent with source "api" — it moves "unknown" to "opted_in" and never undoes an opt-out (only the customer can, by writing START). false or left out changes nothing. 201 when created, 200 when updated.',
    body: {
      phone: CUSTOMER,
      name: "Asha Rao",
      attributes: { city: "Pune", customer_id: "C-1042" },
      tags: ["vip"],
      opted_in: true,
    },
    response: { status: 201, body: { status: "created", contact: CONTACT_EXAMPLE } },
    errors: ["invalid_contact"],
  },
  {
    id: "contacts-bulk",
    group: "Contacts",
    method: "POST",
    path: "/api/v1/contacts/bulk",
    title: "Create or update contacts in bulk",
    summary: `Up to ${MAX_BULK_CONTACTS} contacts in one call, each as in POST /api/v1/contacts, with a result per row (a bad row never stops the rest). opt_out_kept: true means the customer had opted out and stays so.`,
    body: {
      contacts: [
        { phone: CUSTOMER, name: "Asha Rao", opted_in: true },
        { phone: "+919800000002", tags: ["wholesale"] },
      ],
    },
    response: {
      status: 200,
      body: {
        created: 1,
        updated: 1,
        unchanged: 0,
        errors: 0,
        results: [
          { index: 0, phone: CUSTOMER, status: "created", contact: CONTACT_EXAMPLE },
          {
            index: 1,
            phone: "+919800000002",
            status: "updated",
            contact: { ...CONTACT_EXAMPLE, phone: "+919800000002", tags: ["wholesale"] },
          },
        ],
      },
    },
    errors: ["invalid_contacts", "too_many_contacts"],
  },
  {
    id: "contacts-list",
    group: "Contacts",
    method: "GET",
    path: "/api/v1/contacts",
    title: "List contacts",
    summary:
      "Oldest change first, a page at a time: pass next_cursor back as cursor until it is null. Keep the last cursor to pick up later changes.",
    query: [
      { name: "limit", description: "1–100, default 50.", example: "50" },
      { name: "cursor", description: "next_cursor from the page before." },
      { name: "tag", description: "Only contacts with this tag (any case).", example: "vip" },
      { name: "opt_in", description: "opted_in, opted_out or unknown." },
      {
        name: "updated_since",
        description: "Only contacts changed at or after this time (ISO 8601).",
      },
    ],
    response: { status: 200, body: { data: [CONTACT_EXAMPLE], next_cursor: "eyJ1Ijoi…" } },
    errors: ["invalid_limit", "invalid_filter", "invalid_cursor"],
  },
  {
    id: "contact-get",
    group: "Contacts",
    method: "GET",
    path: "/api/v1/contacts/{phone}",
    title: "One contact",
    summary: 'By phone, with its country code (write the "+" as %2B, or leave it out).',
    params: { phone: "919812345678" },
    response: { status: 200, body: { contact: CONTACT_EXAMPLE } },
    errors: ["not_found"],
  },
  {
    id: "contact-tags-add",
    group: "Contacts",
    method: "POST",
    path: "/api/v1/contacts/{phone}/tags",
    title: "Add tags to a contact",
    summary: "A tag that doesn't exist yet is made in the workspace.",
    params: { phone: "919812345678" },
    body: { tags: ["vip", "returning"] },
    response: {
      status: 200,
      body: { contact: { ...CONTACT_EXAMPLE, tags: ["returning", "vip"] } },
    },
    errors: ["invalid_tags", "not_found"],
  },
  {
    id: "contact-tags-remove",
    group: "Contacts",
    method: "DELETE",
    path: "/api/v1/contacts/{phone}/tags/{tag}",
    title: "Remove a tag from a contact",
    summary: "The tag itself stays in the workspace.",
    params: { phone: "919812345678", tag: "returning" },
    response: { status: 200, body: { contact: CONTACT_EXAMPLE } },
    errors: ["invalid_tags", "not_found"],
  },
  {
    id: "templates-list",
    group: "Templates",
    method: "GET",
    path: "/api/v1/templates",
    title: "List templates",
    summary:
      "Your templates on the number the API sends from: name, language, category, status, components, Meta's rejection reason — and send: what POST /api/v1/messages/template needs to fill, and whether it will take it.",
    query: [
      { name: "status", description: "APPROVED, PENDING, REJECTED or PAUSED." },
      { name: "category", description: "MARKETING, UTILITY or AUTHENTICATION." },
      { name: "language", description: "A language code, e.g. en." },
    ],
    response: { status: 200, body: { data: [TEMPLATE_EXAMPLE] } },
    errors: ["invalid_filter", "no_whatsapp_number"],
  },
  {
    id: "template-get",
    group: "Templates",
    method: "GET",
    path: "/api/v1/templates/{name}",
    title: "One template",
    summary: "Every language it has (or ?language=).",
    params: { name: "order_shipped" },
    query: [{ name: "language", description: "Only this language." }],
    response: { status: 200, body: { name: "order_shipped", data: [TEMPLATE_EXAMPLE] } },
    errors: ["not_found", "no_whatsapp_number"],
  },
  {
    id: "account-balance",
    group: "Account",
    method: "GET",
    path: "/api/v1/account/balance",
    title: "Wallet balance and prices",
    summary:
      "Your AiDwar wallet (available = balance + overdraft − credits held for running campaigns) and what one message costs per category, for a country or a customer's number.",
    query: [
      { name: "country", description: "Two letters, e.g. IN (default).", example: "IN" },
      { name: "to", description: "Or a customer's number: their country's prices." },
    ],
    response: {
      status: 200,
      body: {
        balance: 598.91,
        held: 25,
        available: 573.91,
        currency: "INR",
        billing_enabled: true,
        country: "IN",
        prices: [
          { category: "marketing", price: 0.9412, currency: "INR" },
          { category: "utility", price: 0.15, currency: "INR" },
          { category: "authentication", price: 0.15, currency: "INR" },
          { category: "service", price: 0, currency: "INR" },
        ],
        as_of: "2026-10-28T10:00:00.000Z",
      },
    },
    errors: ["invalid_filter", "invalid_to"],
  },
];

// ------------------------------------------------------------ webhook events

export type WebhookEventSpec = { name: string; when: string; example: Record<string, unknown> };

const AT = "2026-10-28T10:00:09.000Z";
const statusExample = (event: string, status: string, error: unknown = null) => ({
  ...(JSON.parse(WEBHOOK_BODY_EXAMPLE) as Record<string, unknown>),
  event,
  status,
  error,
});

export const WEBHOOK_EVENTS: WebhookEventSpec[] = [
  {
    name: "message.sent",
    when: "A message the API sent reached WhatsApp's servers.",
    example: statusExample("message.sent", "sent"),
  },
  {
    name: "message.delivered",
    when: "It reached the customer's phone.",
    example: statusExample("message.delivered", "delivered"),
  },
  {
    name: "message.read",
    when: "The customer read it (when they share read receipts).",
    example: statusExample("message.read", "read"),
  },
  {
    name: "message.failed",
    when: "WhatsApp couldn't deliver it; error says why.",
    example: statusExample("message.failed", "failed", {
      code: "131026",
      message: "Message undeliverable",
    }),
  },
  {
    name: "message.received",
    when: "A customer wrote to you: words, a file (media.url: GET it with your key for a download link), a button / list / quick-reply tap (reply), or a map pin (location).",
    example: {
      event: "message.received",
      message_id: MESSAGE_ID,
      wamid: "wamid.HBgMOTE5ODEy…",
      from: CUSTOMER,
      contact: { phone: CUSTOMER, name: "Asha Rao" },
      type: "image",
      text: "Is this one in stock?",
      media: {
        url: `${API_ORIGIN}/api/v1/media/${MESSAGE_ID}`,
        mime_type: "image/jpeg",
        filename: null,
        caption: "Is this one in stock?",
      },
      reply: null,
      location: null,
      context: null,
      timestamp: AT,
    },
  },
  {
    name: "contact.created",
    when: "Someone wrote to you for the first time (a new number).",
    example: {
      event: "contact.created",
      contact: { phone: CUSTOMER, name: "Asha Rao", opt_in_status: null, source: "direct" },
      timestamp: AT,
    },
  },
  {
    name: "contact.opted_out",
    when: "The customer opted out (STOP or one of your opt-out words).",
    example: {
      event: "contact.opted_out",
      contact: { phone: CUSTOMER, name: "Asha Rao", opt_in_status: "opted_out", source: "direct" },
      timestamp: AT,
    },
  },
  {
    name: "contact.opted_in",
    when: "The customer opted back in (START), or you recorded their consent through the API.",
    example: {
      event: "contact.opted_in",
      contact: { phone: CUSTOMER, name: "Asha Rao", opt_in_status: "opted_in", source: "api" },
      timestamp: AT,
    },
  },
  {
    name: "template.status_changed",
    when: "Meta approved, rejected, paused or disabled one of your templates.",
    example: {
      event: "template.status_changed",
      template: {
        name: "order_shipped",
        language: "en",
        status: "REJECTED",
        category: "UTILITY",
        previous_status: "PENDING",
        rejection_reason: "INVALID_FORMAT",
      },
      timestamp: AT,
    },
  },
  {
    name: "template.category_changed",
    when: "Meta moved one of your templates to another category (it changes its price, and whether opted-out customers can get it).",
    example: {
      event: "template.category_changed",
      template: {
        name: "order_shipped",
        language: "en",
        status: "APPROVED",
        category: "MARKETING",
        previous_category: "UTILITY",
      },
      timestamp: AT,
    },
  },
  {
    name: "campaign.completed",
    when: "A campaign finished sending to everyone on its list (not when it is cancelled).",
    example: {
      event: "campaign.completed",
      campaign_id: "2c9d4e1a-7b3f-4c2d-9e8a-1f0b6d5c4a39",
      name: "Diwali offer",
      status: "completed",
      template_name: "festive_offer",
      counts: { recipients: 1200, sent: 1188, delivered: 1150, read: 802, failed: 12, replied: 64 },
      completed_at: AT,
      timestamp: AT,
    },
  },
  {
    name: "phone_number.quality_changed",
    when: "WhatsApp changed your number's quality rating (GREEN, YELLOW or RED). A falling rating means customers are blocking or reporting your messages.",
    example: {
      event: "phone_number.quality_changed",
      phone_number: "+91 90000 00000",
      quality: { previous: "GREEN", current: "YELLOW" },
      whatsapp_event: "FLAGGED",
      timestamp: AT,
    },
  },
  {
    name: "account.status_changed",
    when: "Your WhatsApp Business Account was reviewed, restricted, disabled or restored.",
    example: {
      event: "account.status_changed",
      status: "restricted",
      whatsapp_event: "ACCOUNT_VIOLATION",
      reason: "SCAM",
      restrictions: [{ type: "RESTRICTED_BIZ_INITIATED_MESSAGING", expires_at: "1767225600" }],
      timestamp: AT,
    },
  },
  {
    name: "messaging_limit.changed",
    when: "Your number's daily limit of new conversations changed (for example from 1,000 to 10,000 customers a day).",
    example: {
      event: "messaging_limit.changed",
      phone_number: "+91 90000 00000",
      limit: { previous: "TIER_1K", current: "TIER_10K" },
      whatsapp_event: "UPGRADE",
      timestamp: AT,
    },
  },
];

// ------------------------------------------------------------ examples

/** The endpoint's address with its example params (and example query). */
export function exampleUrl(e: ApiEndpoint, origin = API_ORIGIN): string {
  let path = e.path;
  for (const [k, v] of Object.entries(e.params ?? {}))
    path = path.replace(`{${k}}`, encodeURIComponent(v));
  const q = (e.query ?? []).filter((x) => x.example !== undefined);
  return `${origin}${path}${q.length ? `?${q.map((x) => `${x.name}=${encodeURIComponent(x.example!)}`).join("&")}` : ""}`;
}

const shellQuote = (s: string) => s.replace(/'/g, "'\\''");

export function curlFor(
  e: ApiEndpoint,
  body: Record<string, unknown> | undefined = e.body,
  origin = API_ORIGIN,
): string {
  const lines = [
    `curl${e.method === "GET" ? "" : ` -X ${e.method}`} "${exampleUrl(e, origin)}" \\`,
    `  -H "Authorization: Bearer $AIDWAR_API_KEY"${body ? " \\" : ""}`,
  ];
  if (body) {
    lines.push(`  -H "Content-Type: application/json" \\`);
    lines.push(`  -d '${shellQuote(prettyJson(body))}'`);
  }
  return lines.join("\n");
}

export function nodeFor(
  e: ApiEndpoint,
  body: Record<string, unknown> | undefined = e.body,
  origin = API_ORIGIN,
): string {
  const indent = (s: string) =>
    s
      .split("\n")
      .map((line, i) => (i === 0 ? line : `  ${line}`))
      .join("\n");
  return [
    `const res = await fetch("${exampleUrl(e, origin)}", {`,
    `  method: "${e.method}",`,
    `  headers: {`,
    `    Authorization: \`Bearer \${process.env.AIDWAR_API_KEY}\`,`,
    ...(body ? [`    "Content-Type": "application/json",`] : []),
    `  },`,
    ...(body ? [`  body: JSON.stringify(${indent(prettyJson(body))}),`] : []),
    `});`,
    e.id === "media-download"
      ? `if (!res.ok) throw new Error(\`\${res.status}\`);\nconst file = Buffer.from(await res.arrayBuffer());`
      : `const answer = await res.json();\nif (!res.ok) throw new Error(\`\${res.status} \${answer.code}: \${answer.error}\`);`,
  ].join("\n");
}

/**
 * Batch 38: JSON laid out for reading — short arrays and small objects of
 * plain values stay on one line, everything else is indented. Valid JSON.
 */
export function prettyJson(value: unknown, indent = 2, depth = 0): string {
  const pad = " ".repeat(indent * (depth + 1));
  const end = " ".repeat(indent * depth);
  const plain = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    const inline = `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
    if (value.every(plain) && inline.length <= 60) return inline;
    return `[\n${value.map((v) => pad + prettyJson(v, indent, depth + 1)).join(",\n")}\n${end}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return "{}";
    const inline = `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")} }`;
    if (
      depth > 0 &&
      entries.length <= 3 &&
      entries.every(([, v]) => plain(v)) &&
      inline.length <= 60
    )
      return inline;
    return `{\n${entries.map(([k, v]) => `${pad}${JSON.stringify(k)}: ${prettyJson(v, indent, depth + 1)}`).join(",\n")}\n${end}}`;
  }
  return JSON.stringify(value);
}

/**
 * Batch 38: JSON as a Python literal (True / False / None outside strings),
 * so the Python sample is ordinary requests code.
 */
export function pythonLiteral(value: unknown, indent = 4): string {
  const json = prettyJson(value, indent);
  let out = "";
  let inString = false;
  for (let i = 0; i < json.length; i += 1) {
    const ch = json[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += json[i + 1] ?? "";
        i += 1;
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    const rest = json.slice(i);
    const word = /^(true|false|null)\b/.exec(rest)?.[1];
    if (word) {
      out += word === "true" ? "True" : word === "false" ? "False" : "None";
      i += word.length - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

export function pythonFor(
  e: ApiEndpoint,
  body: Record<string, unknown> | undefined = e.body,
  origin = API_ORIGIN,
): string {
  const method = e.method.toLowerCase();
  const indented = (text: string) =>
    text
      .split("\n")
      .map((line, i) => (i === 0 ? line : `    ${line}`))
      .join("\n");
  return [
    "import os",
    "import requests",
    "",
    `response = requests.${method}(`,
    `    "${exampleUrl(e, origin)}",`,
    `    headers={"Authorization": f"Bearer {os.environ['AIDWAR_API_KEY']}"},`,
    ...(body ? [`    json=${indented(pythonLiteral(body))},`] : []),
    ")",
    "response.raise_for_status()",
    e.id === "media-download"
      ? 'open("download.bin", "wb").write(response.content)'
      : "print(response.json())",
  ].join("\n");
}

export function phpFor(
  e: ApiEndpoint,
  body: Record<string, unknown> | undefined = e.body,
  origin = API_ORIGIN,
): string {
  return [
    "<?php",
    `$ch = curl_init("${exampleUrl(e, origin)}");`,
    "curl_setopt_array($ch, [",
    `    CURLOPT_CUSTOMREQUEST => "${e.method}",`,
    "    CURLOPT_HTTPHEADER => [",
    '        "Authorization: Bearer " . getenv("AIDWAR_API_KEY"),',
    ...(body ? ['        "Content-Type: application/json",'] : []),
    "    ],",
    ...(body ? ["    CURLOPT_POSTFIELDS => <<<'JSON'", prettyJson(body, 4), "JSON,"] : []),
    "    CURLOPT_RETURNTRANSFER => true,",
    "]);",
    "$response = curl_exec($ch);",
    "$status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);",
    e.id === "media-download"
      ? 'file_put_contents("download.bin", $response);'
      : "$answer = json_decode($response, true);",
  ].join("\n");
}

/** Every language the docs show a request in, by tab. */
export const SAMPLE_LANGUAGES = ["curl", "node", "python", "php"] as const;
export type SampleLanguage = (typeof SAMPLE_LANGUAGES)[number];
export const SAMPLE_LABELS: Record<SampleLanguage, string> = {
  curl: "cURL",
  node: "Node.js",
  python: "Python",
  php: "PHP",
};

export function sampleFor(
  language: SampleLanguage,
  e: ApiEndpoint,
  body: Record<string, unknown> | undefined = e.body,
  origin = API_ORIGIN,
): string {
  if (language === "curl") return curlFor(e, body, origin);
  if (language === "node") return nodeFor(e, body, origin);
  if (language === "python") return pythonFor(e, body, origin);
  return phpFor(e, body, origin);
}

/** Every error code an endpoint lists is in the error table (the docs test checks it). */
export function errorRow(code: string): { status: string; meaning: string } | null {
  const row = API_ERRORS.find((r) => r.codes.includes(code));
  return row ? { status: row.status, meaning: row.meaning } : null;
}

// ------------------------------------------------------------ Postman

export const POSTMAN_PATH = "/developers/api.postman.json";

/**
 * A Postman (v2.1) collection of every endpoint and example above: the key is
 * a collection variable (apiKey, empty — never a real key), the address is
 * baseUrl.
 */
export function postmanCollection(origin = API_ORIGIN): Record<string, unknown> {
  const groups = Array.from(new Set(API_ENDPOINTS.map((e) => e.group)));
  const request = (e: ApiEndpoint, body?: Record<string, unknown>) => {
    let path = e.path;
    for (const [k, v] of Object.entries(e.params ?? {})) path = path.replace(`{${k}}`, v);
    const query = (e.query ?? []).map((q) => ({
      key: q.name,
      value: q.example ?? "",
      description: q.description,
      disabled: q.example === undefined,
    }));
    return {
      method: e.method,
      header: body ? [{ key: "Content-Type", value: "application/json" }] : [],
      url: {
        raw: `{{baseUrl}}${path}`,
        host: ["{{baseUrl}}"],
        path: path.split("/").filter(Boolean),
        ...(query.length ? { query } : {}),
      },
      ...(body
        ? {
            body: {
              mode: "raw",
              raw: JSON.stringify(body, null, 2),
              options: { raw: { language: "json" } },
            },
          }
        : {}),
      description: e.summary,
    };
  };
  return {
    info: {
      name: "AiDwar Public API",
      _postman_id: "aidwar-public-api-v1-2",
      description: `The AiDwar Public API (v1.2). Set apiKey to your key (Settings → API & webhooks). Docs: ${origin}/developers`,
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    auth: { type: "bearer", bearer: [{ key: "token", value: "{{apiKey}}", type: "string" }] },
    variable: [
      { key: "baseUrl", value: origin },
      { key: "apiKey", value: "" },
    ],
    item: groups.map((group) => ({
      name: group,
      item: API_ENDPOINTS.filter((e) => e.group === group).flatMap((e) => [
        {
          id: e.id,
          name: e.title,
          request: request(e, e.body),
          response: [
            {
              name: `${e.response.status}`,
              code: e.response.status,
              body:
                typeof e.response.body === "string"
                  ? e.response.body
                  : JSON.stringify(e.response.body, null, 2),
            },
          ],
        },
        ...(e.more ?? []).map((m, i) => ({
          id: `${e.id}-${i + 1}`,
          name: `${e.title} — ${m.label}`,
          request: request(e, m.body),
        })),
      ]),
    })),
  };
}

/** For Settings: the media types and limits a file may have. */
export const MEDIA_LIMIT_LINES = Object.entries(MEDIA_LIMITS).map(
  ([kind, l]) => `${kind}: ${l.label}, up to ${l.mb} MB`,
);

// ------------------------------------------------------------ Batch 38: v1.2 endpoints

const CAMPAIGN_ID = "2c9d4e1a-7b3f-4c2d-9e8a-1f0b6d5c4a39";
const WEBHOOK_ID = "8a41f0d2-5c6e-4b7a-a913-0e2d7c4b6f15";

const CAMPAIGN_EXAMPLE = {
  campaign_id: CAMPAIGN_ID,
  name: "Diwali offer",
  status: "sending",
  template_name: "festive_offer",
  language: "en",
  segment_id: null,
  scheduled_at: null,
  started_at: "2026-10-28T10:00:00.000Z",
  completed_at: null,
  created_at: "2026-10-28T10:00:00.000Z",
  counts: { recipients: 1200, sent: 640, delivered: 610, read: 402, failed: 3, replied: 21 },
  estimated_cost: 1129.44,
  charged_amount: 602.37,
  pause_reason: null,
};

const CONVERSATION_EXAMPLE = {
  conversation_id: "5b0c7f3e-91d2-4a6b-8c3e-2f1a0d9e7b64",
  phone: CUSTOMER,
  contact: { name: "Asha Rao", phone: CUSTOMER, opt_in_status: "opted_in" },
  status: "open",
  assignee: { user_id: "3e5f7a9b-1c2d-4e6f-8a0b-c1d2e3f4a5b6", email: "priya@shop.example.com" },
  needs_human: false,
  whatsapp_account_id: "d4c3b2a1-0f9e-4d8c-b7a6-543210fedcba",
  unread_count: 0,
  last_message_at: "2026-10-28T09:58:00.000Z",
  last_customer_message_at: "2026-10-28T09:58:00.000Z",
  created_at: "2026-10-20T11:00:00.000Z",
  updated_at: "2026-10-28T10:00:00.000Z",
  tags: ["vip"],
};

const WEBHOOK_EXAMPLE = {
  webhook_id: WEBHOOK_ID,
  url: "https://shop.example.com/aidwar/webhook",
  events: ["message.delivered", "message.read", "message.failed"],
  all_events: false,
  status: "active",
  created_at: "2026-10-28T10:00:00.000Z",
  updated_at: "2026-10-28T10:00:00.000Z",
};

const CAMPAIGN_BODY = {
  name: "Diwali offer",
  template_name: "festive_offer",
  audience: {
    phones: [
      { phone: CUSTOMER, variables: ["Asha", "20%"] },
      { phone: "+919800000002", variables: ["Ravi", "15%"] },
    ],
  },
  schedule_at: "2026-11-01T10:00:00+05:30",
  idempotency_key: "diwali-2026",
};

function V12_ENDPOINTS(): ApiEndpoint[] {
  return [
    {
      id: "campaign-create",
      group: "Campaigns",
      method: "POST",
      path: "/api/v1/campaigns",
      title: "Create and launch a campaign",
      summary:
        "One approved template to many customers: a segment, a tag or a list of phones (only customers who opted in; the rest come back in skipped). Values are the same for everyone or set per customer. Your wallet is checked before anything is created, and credits are reserved before the first message goes out.",
      body: CAMPAIGN_BODY,
      more: [
        {
          label: "everyone with a tag, values from the contact",
          body: {
            name: "VIP early access",
            template_name: "festive_offer",
            audience: { tag: "vip" },
            variables: { "1": { source: "name" }, "2": "25%" },
          },
        },
      ],
      response: {
        status: 201,
        body: {
          campaign: {
            ...CAMPAIGN_EXAMPLE,
            status: "scheduled",
            scheduled_at: "2026-11-01T04:30:00.000Z",
            started_at: null,
            counts: {
              ...CAMPAIGN_EXAMPLE.counts,
              recipients: 2,
              sent: 0,
              delivered: 0,
              read: 0,
              failed: 0,
              replied: 0,
            },
          },
          needs_approval: false,
          skipped: [{ phone: "+919811111111", reason: "not_opted_in" }],
          idempotency_key: "diwali-2026",
        },
      },
      errors: [
        "invalid_name",
        "invalid_audience",
        "invalid_variables",
        "missing_variables",
        "invalid_schedule_at",
        "template_not_found",
        "template_not_approved",
        "template_unsupported",
        "header_media_required",
        "segment_not_found",
        "tag_not_found",
        "insufficient_credits",
        "workspace_locked",
        "idempotency_key_reused",
      ],
    },
    {
      id: "campaign-estimate",
      group: "Campaigns",
      method: "POST",
      path: "/api/v1/campaigns/estimate",
      title: "Estimate a campaign",
      summary:
        "Who a campaign would reach and what it would cost — the same numbers the campaign screen in AiDwar shows. Nothing is created or sent.",
      body: {
        template_name: "festive_offer",
        audience: { tag: "vip" },
        variables: ["there", "20%"],
      },
      response: {
        status: 200,
        body: {
          recipients: 1200,
          skipped: [],
          template_name: "festive_offer",
          language: "en",
          category: "marketing",
          cost: {
            currency: "INR",
            rate: 0.9412,
            estimate: 1129.44,
            available: 4210.5,
            can_send: true,
            needs_approval: false,
          },
        },
      },
      errors: ["invalid_audience", "missing_variables", "template_not_found", "tag_not_found"],
    },
    {
      id: "campaigns-list",
      group: "Campaigns",
      method: "GET",
      path: "/api/v1/campaigns",
      title: "List campaigns",
      summary: "Newest first, a page at a time: pass next_cursor back as cursor until it is null.",
      query: [
        {
          name: "status",
          description:
            "draft, scheduled, awaiting_approval, sending, paused, completed, cancelled or failed.",
        },
        { name: "limit", description: "1–100, default 25.", example: "25" },
        { name: "cursor", description: "next_cursor from the page before." },
      ],
      response: { status: 200, body: { campaigns: [CAMPAIGN_EXAMPLE], next_cursor: null } },
      errors: ["invalid_status", "invalid_limit", "invalid_cursor"],
    },
    {
      id: "campaign-get",
      group: "Campaigns",
      method: "GET",
      path: "/api/v1/campaigns/{campaign_id}",
      title: "One campaign",
      summary: "Its status and its counts: recipients, sent, delivered, read, failed and replied.",
      params: { campaign_id: CAMPAIGN_ID },
      response: { status: 200, body: { campaign: CAMPAIGN_EXAMPLE } },
      errors: ["not_found"],
    },
    {
      id: "campaign-cancel",
      group: "Campaigns",
      method: "POST",
      path: "/api/v1/campaigns/{campaign_id}/cancel",
      title: "Cancel a campaign",
      summary:
        "Stops it before it finishes: nobody still waiting gets the message, and the unused credits go back to your wallet. A campaign that has already finished can't be cancelled.",
      params: { campaign_id: CAMPAIGN_ID },
      response: {
        status: 200,
        body: {
          campaign: {
            ...CAMPAIGN_EXAMPLE,
            status: "cancelled",
            completed_at: "2026-10-28T10:05:00.000Z",
          },
        },
      },
      errors: ["not_found", "campaign_finished"],
    },
    {
      id: "conversations-list",
      group: "Inbox",
      method: "GET",
      path: "/api/v1/conversations",
      title: "List conversations",
      summary:
        "Oldest change first, a page at a time — keep the last cursor (or use updated_since) to pick up what changed since your last call.",
      query: [
        { name: "status", description: "open, closed or pending." },
        {
          name: "assignee",
          description: "A team member's email or user id, or none for unassigned.",
        },
        {
          name: "updated_since",
          description: "Only conversations changed at or after this time (ISO 8601).",
        },
        { name: "limit", description: "1–100, default 25.", example: "25" },
        { name: "cursor", description: "next_cursor from the page before." },
      ],
      response: { status: 200, body: { conversations: [CONVERSATION_EXAMPLE], next_cursor: null } },
      errors: [
        "invalid_status",
        "assignee_not_member",
        "invalid_updated_since",
        "invalid_limit",
        "invalid_cursor",
      ],
    },
    {
      id: "conversation-assign",
      group: "Inbox",
      method: "POST",
      path: "/api/v1/conversations/{phone}/assign",
      title: "Assign a conversation",
      summary:
        "Hands the customer's latest conversation to a team member (by email or user id), or unassigns it with null — as the inbox's Assign menu does.",
      params: { phone: "919812345678" },
      body: { assignee: "priya@shop.example.com" },
      response: { status: 200, body: { conversation: CONVERSATION_EXAMPLE } },
      errors: ["invalid_assignee", "assignee_not_member", "not_found"],
    },
    {
      id: "conversation-close",
      group: "Inbox",
      method: "POST",
      path: "/api/v1/conversations/{phone}/close",
      title: "Close a conversation",
      summary: "As the inbox's Close button. Closing one that is already closed changes nothing.",
      params: { phone: "919812345678" },
      response: {
        status: 200,
        body: { conversation: { ...CONVERSATION_EXAMPLE, status: "closed" } },
      },
      errors: ["not_found"],
    },
    {
      id: "conversation-reopen",
      group: "Inbox",
      method: "POST",
      path: "/api/v1/conversations/{phone}/reopen",
      title: "Reopen a conversation",
      summary: "As the inbox's Reopen button.",
      params: { phone: "919812345678" },
      response: { status: 200, body: { conversation: CONVERSATION_EXAMPLE } },
      errors: ["not_found"],
    },
    {
      id: "conversation-tags",
      group: "Inbox",
      method: "POST",
      path: "/api/v1/conversations/{phone}/tags",
      title: "Tag the customer",
      summary:
        "Adds and removes the customer's tags (the inbox's labels) in one call. A new tag is created in your workspace.",
      params: { phone: "919812345678" },
      body: { add: ["vip"], remove: ["new-lead"] },
      response: { status: 200, body: { conversation: CONVERSATION_EXAMPLE } },
      errors: ["invalid_tags", "not_found"],
    },
    {
      id: "webhooks-list",
      group: "Webhooks",
      method: "GET",
      path: "/api/v1/webhooks",
      title: "List webhooks",
      summary:
        "Your webhooks (up to 5) and the events each hears. Signing secrets are never shown again.",
      response: { status: 200, body: { webhooks: [WEBHOOK_EXAMPLE], limit: 5 } },
      errors: [],
    },
    {
      id: "webhook-create",
      group: "Webhooks",
      method: "POST",
      path: "/api/v1/webhooks",
      title: "Add a webhook",
      summary:
        'An https address that hears every event ("*") or the ones you name. The answer holds its signing secret — the only time it is shown, so store it now.',
      body: {
        url: "https://shop.example.com/aidwar/webhook",
        events: ["message.delivered", "message.read", "message.failed"],
      },
      response: { status: 201, body: { webhook: WEBHOOK_EXAMPLE, secret: "whsec_9Fq2…" } },
      errors: ["invalid_url", "invalid_events", "webhook_limit_reached"],
    },
    {
      id: "webhook-events",
      group: "Webhooks",
      method: "GET",
      path: "/api/v1/webhooks/events",
      title: "List webhook events",
      summary:
        "Every event a webhook can hear: when it fires, an example body and the plans that have it.",
      response: {
        status: 200,
        body: {
          events: [
            {
              name: "message.delivered",
              description: "It reached the customer's phone.",
              since: "v1.0",
              plans: ["Scale", "Enterprise"],
              example: { event: "message.delivered", message_id: MESSAGE_ID, status: "delivered" },
            },
          ],
        },
      },
      errors: [],
    },
    {
      id: "webhook-get",
      group: "Webhooks",
      method: "GET",
      path: "/api/v1/webhooks/{webhook_id}",
      title: "One webhook",
      summary: "Its address, events and status.",
      params: { webhook_id: WEBHOOK_ID },
      response: { status: 200, body: { webhook: WEBHOOK_EXAMPLE } },
      errors: ["not_found"],
    },
    {
      id: "webhook-update",
      group: "Webhooks",
      method: "PATCH",
      path: "/api/v1/webhooks/{webhook_id}",
      title: "Change a webhook",
      summary:
        "A new address, other events, pause it (disabled) or turn it back on (active), or rotate_secret: the old secret stops working at once and the new one is in the answer, once.",
      params: { webhook_id: WEBHOOK_ID },
      body: { events: "*", rotate_secret: true },
      response: {
        status: 200,
        body: {
          webhook: { ...WEBHOOK_EXAMPLE, events: [...ALL_WEBHOOK_EVENTS], all_events: true },
          secret: "whsec_Lm7k…",
        },
      },
      errors: ["invalid_url", "invalid_events", "invalid_status", "not_found"],
    },
    {
      id: "webhook-delete",
      group: "Webhooks",
      method: "DELETE",
      path: "/api/v1/webhooks/{webhook_id}",
      title: "Remove a webhook",
      summary: "Events stop being sent to it at once.",
      params: { webhook_id: WEBHOOK_ID },
      response: { status: 200, body: { webhook_id: WEBHOOK_ID, deleted: true } },
      errors: ["not_found"],
    },
    {
      id: "webhook-test",
      group: "Webhooks",
      method: "POST",
      path: "/api/v1/webhooks/{webhook_id}/test",
      title: "Send a test event",
      summary:
        "Sends webhook.test to that webhook now, signed like every event, and tells you what your server answered.",
      params: { webhook_id: WEBHOOK_ID },
      response: {
        status: 200,
        body: { webhook_id: WEBHOOK_ID, delivered: true, response_status: 200, error: null },
      },
      errors: ["not_found"],
    },
  ];
}

const f = (
  name: string,
  where: FieldDoc["in"],
  type: string,
  required: boolean,
  description: string,
  example?: string,
): FieldDoc => ({
  name,
  in: where,
  type,
  required,
  description,
  ...(example !== undefined ? { example } : {}),
});

const IDEMPOTENCY = f(
  "idempotency_key",
  "body",
  "string",
  false,
  "Up to 255 letters, digits or _ - . :. The same key within 24 hours gets the first answer again and is never sent twice. Also accepted as the Idempotency-Key header.",
  "ord-1042-shipped",
);
const PHONE_PATH = f(
  "phone",
  "path",
  "string",
  true,
  'The customer\'s number with its country code ("+" as %2B, or left out).',
  "919812345678",
);
const LIST_FIELDS = (def: number) => [
  f("limit", "query", "integer", false, `1–100. Default ${def}.`, String(def)),
  f("cursor", "query", "string", false, "next_cursor from the page before."),
];

/** Fields, version, purpose and extra answers for every endpoint (Batch 38). */
const ENDPOINT_DETAILS: Record<string, Partial<ApiEndpoint>> = {
  "send-template": {
    since: "v1.0",
    purpose:
      "Send an approved WhatsApp template — an invoice, an order update, an offer — to one customer, at any time.",
    fields: [
      f(
        "to",
        "body",
        "string",
        true,
        "The customer's WhatsApp number with its country code.",
        CUSTOMER,
      ),
      f(
        "template_name",
        "body",
        "string",
        true,
        "An approved template on your number.",
        "order_shipped",
      ),
      f(
        "language",
        "body",
        "string",
        false,
        "The template's language, when it is approved in more than one.",
        "en",
      ),
      f(
        "header",
        "body",
        "object",
        false,
        'The template\'s header: { type: "text", params } · { type: "image" | "video" | "document", url | base64, filename } · { type: "location", latitude, longitude, name, address }.',
      ),
      f(
        "document",
        "body",
        "object",
        false,
        "The invoice shortcut: { url | base64, filename } for a document header (PDF up to 16 MB).",
      ),
      f(
        "body_params",
        "body",
        "string[]",
        false,
        "The body's {{1}}, {{2}}… values, in order.",
        '["Asha", "#1042"]',
      ),
      f(
        "buttons",
        "body",
        "object[]",
        false,
        '{ index, type: "url", url_param } · { index, type: "quick_reply", payload } · { index, type: "copy_code", code }.',
      ),
      f(
        "offer_expires_at",
        "body",
        "string",
        false,
        "When a limited-time offer ends (ISO 8601), for a template with an offer countdown.",
      ),
      IDEMPOTENCY,
    ],
    responses: [
      {
        status: 409,
        label: "The customer opted out (a marketing template)",
        body: {
          error:
            "This customer has opted out of marketing messages from this business. Nothing was sent.",
          code: "contact_opted_out",
        },
      },
      {
        status: 402,
        label: "Not enough credits",
        body: {
          error:
            "There aren't enough credits in this workspace's AiDwar wallet to send this message. Top up and send again. Nothing was sent.",
          code: "insufficient_credits",
        },
      },
    ],
  },
  "send-session": {
    since: "v1.1",
    purpose:
      "Reply to a customer in your own words — text, a file, reply buttons or a list — while their 24-hour window is open.",
    fields: [
      f("to", "body", "string", true, "The customer's WhatsApp number.", CUSTOMER),
      f(
        "type",
        "body",
        "string",
        true,
        "text, image, video, audio, document, buttons or list.",
        "text",
      ),
      f(
        "text",
        "body",
        "string",
        false,
        "For text: up to 4,096 characters, WhatsApp formatting as you write it.",
        "Hi *Asha*!",
      ),
      f("preview_url", "body", "boolean", false, "For text: show a preview of the first link."),
      f(
        "image · video · audio · document",
        "body",
        "object",
        false,
        "For a file: { url | base64, filename, caption }.",
      ),
      f("body", "body", "string", false, "For buttons and list: the message text."),
      f("buttons", "body", "object[]", false, "For buttons: up to 3 { id, title }."),
      f(
        "button · sections",
        "body",
        "string · object[]",
        false,
        "For list: the button's label, and sections of { title, rows: [{ id, title, description }] }.",
      ),
      IDEMPOTENCY,
    ],
    responses: [
      {
        status: 409,
        label: "The 24-hour window is closed",
        body: {
          error: "This customer's 24-hour window is closed: send an approved template instead.",
          code: "window_closed",
        },
      },
    ],
  },
  "message-status": {
    since: "v1.0",
    purpose: "Check what happened to a message you sent: queued, sent, delivered, read or failed.",
    fields: [
      f("message_id", "path", "string", true, "The message_id the send answered with.", MESSAGE_ID),
    ],
    responses: [
      {
        status: 404,
        label: "Not one of your API messages",
        body: { error: "There is no message with this id in this workspace.", code: "not_found" },
      },
    ],
  },
  "media-link": {
    since: "v1.1",
    purpose: "Get a short-lived download link for a photo, video or document a customer sent you.",
    fields: [
      f("message_id", "path", "string", true, "From message.received's media.url.", MESSAGE_ID),
    ],
  },
  "media-download": {
    since: "v1.1",
    purpose: "Download the file itself, with the link you were given.",
    fields: [
      f("message_id", "path", "string", true, "The message.", MESSAGE_ID),
      f("expires", "query", "string", true, "From the link."),
      f("signature", "query", "string", true, "From the link."),
    ],
  },
  "contact-upsert": {
    since: "v1.1",
    purpose: "Add a customer to your contacts — or update one — and record their consent.",
    fields: [
      f("phone", "body", "string", true, "With its country code.", CUSTOMER),
      f("name", "body", "string", false, "Up to 120 characters.", "Asha Rao"),
      f(
        "attributes",
        "body",
        "object",
        false,
        "Up to 50 keys, merged into the contact's; null removes a key.",
      ),
      f("tags", "body", "string[]", false, "Added (never removed here); up to 20 names."),
      f(
        "opted_in",
        "body",
        "boolean",
        false,
        "true records the customer's consent. Never undoes an opt-out.",
      ),
    ],
  },
  "contacts-bulk": {
    since: "v1.1",
    purpose: "Import up to 1,000 contacts in one call, with a result per row.",
    fields: [
      f(
        "contacts",
        "body",
        "object[]",
        true,
        `Up to ${MAX_BULK_CONTACTS}, each as in Create or update a contact.`,
      ),
    ],
  },
  "contacts-list": {
    since: "v1.1",
    purpose: "Read your contacts, or keep your system in sync with what changed.",
    fields: [
      ...LIST_FIELDS(50),
      f("tag", "query", "string", false, "Only contacts with this tag.", "vip"),
      f("opt_in", "query", "string", false, "opted_in, opted_out or unknown."),
      f("updated_since", "query", "string", false, "ISO 8601."),
    ],
  },
  "contact-get": { since: "v1.1", purpose: "Look one customer up by phone.", fields: [PHONE_PATH] },
  "contact-tags-add": {
    since: "v1.1",
    purpose: "Tag a customer, for segments and campaigns.",
    fields: [
      PHONE_PATH,
      f("tags", "body", "string[]", true, "Names; a new one is created.", '["vip"]'),
    ],
  },
  "contact-tags-remove": {
    since: "v1.1",
    purpose: "Untag a customer.",
    fields: [PHONE_PATH, f("tag", "path", "string", true, "The tag's name.", "returning")],
  },
  "templates-list": {
    since: "v1.1",
    purpose: "See your templates, their approval status and exactly what each needs to be sent.",
    fields: [
      f("status", "query", "string", false, "APPROVED, PENDING, REJECTED or PAUSED."),
      f("category", "query", "string", false, "MARKETING, UTILITY or AUTHENTICATION."),
      f("language", "query", "string", false, "e.g. en."),
    ],
  },
  "template-get": {
    since: "v1.1",
    purpose: "One template, in every language it has.",
    fields: [
      f("name", "path", "string", true, "The template's name.", "order_shipped"),
      f("language", "query", "string", false, "Only this language."),
    ],
  },
  "account-balance": {
    since: "v1.1",
    purpose: "Check your wallet before a big send, and what one message costs.",
    fields: [
      f("country", "query", "string", false, "Two letters. Default IN.", "IN"),
      f("to", "query", "string", false, "Or a customer's number: their country's prices."),
    ],
  },
  "campaign-create": {
    since: "v1.2",
    purpose:
      "Send one approved template to many customers — a segment, a tag or your own list — now or later.",
    fields: [
      f("name", "body", "string", true, "What the campaign is called in AiDwar.", "Diwali offer"),
      f("template_name", "body", "string", true, "An approved template.", "festive_offer"),
      f("language", "body", "string", false, "When it is approved in more than one."),
      f(
        "audience",
        "body",
        "object",
        true,
        "Exactly one of { segment_id } · { tag } · { phones: [ phone | { phone, variables } ] } · { all: true }. Only customers who opted in are sent to.",
      ),
      f(
        "variables",
        "body",
        "array | object",
        false,
        'Values for everyone, in order or by number: a text, or { source: "name" | "phone" | "attribute", key }.',
      ),
      f(
        "header_media_url",
        "body",
        "string",
        false,
        "An https link for a picture, video or document header.",
      ),
      f("coupon_code", "body", "string", false, "For a copy-code button (up to 15 characters)."),
      f("offer_expires_at", "body", "string", false, "When a limited-time offer ends (ISO 8601)."),
      f(
        "schedule_at",
        "body",
        "string",
        false,
        "Send later (ISO 8601, up to 90 days ahead). Left out: now.",
      ),
      f(
        "idempotency_key",
        "body",
        "string",
        false,
        "The same key within 24 hours gets the first answer again — never a second campaign. Also the Idempotency-Key header.",
        "diwali-2026",
      ),
    ],
    responses: [
      {
        status: 402,
        label: "Not enough credits",
        body: {
          error:
            "This campaign costs about 1129.44 and you have 300.00 in credits. Add credits and try again.",
          code: "insufficient_credits",
        },
      },
      {
        status: 400,
        label: "A value nobody gives",
        body: {
          error:
            "Nothing fills {{2}} for every recipient: give it in `variables` (for everyone) or in each phone's own `variables`.",
          code: "missing_variables",
        },
      },
    ],
  },
  "campaign-estimate": {
    since: "v1.2",
    purpose: "Know the reach and the cost before you launch.",
    fields: [
      f("template_name", "body", "string", true, "An approved template.", "festive_offer"),
      f("audience", "body", "object", true, "As for Create and launch a campaign."),
      f("variables", "body", "array | object", false, "As for Create and launch a campaign."),
    ],
  },
  "campaigns-list": {
    since: "v1.2",
    purpose: "See every campaign and how it is doing.",
    fields: [
      f("status", "query", "string", false, "Only campaigns in this state."),
      ...LIST_FIELDS(25),
    ],
  },
  "campaign-get": {
    since: "v1.2",
    purpose: "Follow one campaign: sent, delivered, read, failed and replied.",
    fields: [
      f("campaign_id", "path", "string", true, "From Create and launch a campaign.", CAMPAIGN_ID),
    ],
  },
  "campaign-cancel": {
    since: "v1.2",
    purpose: "Stop a campaign before it finishes; unused credits come back.",
    fields: [f("campaign_id", "path", "string", true, "The campaign.", CAMPAIGN_ID)],
    responses: [
      {
        status: 409,
        label: "It has already finished",
        body: {
          error: "This campaign has already finished sending, so it can't be cancelled.",
          code: "campaign_finished",
        },
      },
    ],
  },
  "conversations-list": {
    since: "v1.2",
    purpose:
      "Read your inbox from your own system — who is waiting, who is assigned, what changed.",
    fields: [
      f("status", "query", "string", false, "open, closed or pending."),
      f("assignee", "query", "string", false, "A team member's email or user id, or none."),
      f("updated_since", "query", "string", false, "ISO 8601."),
      ...LIST_FIELDS(25),
    ],
  },
  "conversation-assign": {
    since: "v1.2",
    purpose: "Route a conversation to the right person from your CRM or helpdesk.",
    fields: [
      PHONE_PATH,
      f(
        "assignee",
        "body",
        "string | null",
        true,
        "A team member's email or user id; null unassigns.",
        "priya@shop.example.com",
      ),
    ],
    responses: [
      {
        status: 400,
        label: "Not a member of your team",
        body: {
          error: "That person isn't a member of this workspace. Invite them in AiDwar first.",
          code: "assignee_not_member",
        },
      },
    ],
  },
  "conversation-close": {
    since: "v1.2",
    purpose: "Mark a conversation done.",
    fields: [PHONE_PATH],
  },
  "conversation-reopen": {
    since: "v1.2",
    purpose: "Bring a closed conversation back.",
    fields: [PHONE_PATH],
  },
  "conversation-tags": {
    since: "v1.2",
    purpose: "Label a customer from your own system.",
    fields: [
      PHONE_PATH,
      f("add", "body", "string[]", false, "Tags to add.", '["vip"]'),
      f("remove", "body", "string[]", false, "Tags to remove.", '["new-lead"]'),
    ],
  },
  "webhooks-list": { since: "v1.2", purpose: "See where your events go.", fields: [] },
  "webhook-create": {
    since: "v1.2",
    purpose:
      "Send events to another system — up to 5 webhooks, each with its own secret and events.",
    fields: [
      f(
        "url",
        "body",
        "string",
        true,
        "A public https address.",
        "https://shop.example.com/aidwar/webhook",
      ),
      f(
        "events",
        "body",
        'string[] | "*"',
        false,
        'The events it hears. "*" or left out: every event, including new ones.',
      ),
    ],
    responses: [
      {
        status: 409,
        label: "Already 5 webhooks",
        body: {
          error: "A workspace can have 5 webhooks. Remove one first.",
          code: "webhook_limit_reached",
        },
      },
    ],
  },
  "webhook-events": {
    since: "v1.2",
    purpose: "Every event, with an example, for your own tooling.",
    fields: [],
  },
  "webhook-get": {
    since: "v1.2",
    purpose: "One webhook.",
    fields: [f("webhook_id", "path", "string", true, "The webhook.", WEBHOOK_ID)],
  },
  "webhook-update": {
    since: "v1.2",
    purpose: "Point a webhook elsewhere, change its events, pause it or rotate its secret.",
    fields: [
      f("webhook_id", "path", "string", true, "The webhook.", WEBHOOK_ID),
      f("url", "body", "string", false, "A new https address."),
      f("events", "body", 'string[] | "*"', false, "The events it hears."),
      f("status", "body", "string", false, "active or disabled."),
      f(
        "rotate_secret",
        "body",
        "boolean",
        false,
        "true: a new signing secret (in the answer, once).",
      ),
    ],
  },
  "webhook-delete": {
    since: "v1.2",
    purpose: "Stop sending events to a webhook.",
    fields: [f("webhook_id", "path", "string", true, "The webhook.", WEBHOOK_ID)],
  },
  "webhook-test": {
    since: "v1.2",
    purpose: "Check your endpoint and your signature check, any time.",
    fields: [f("webhook_id", "path", "string", true, "The webhook.", WEBHOOK_ID)],
  },
};

// Batch 38: the v1.2 endpoints join the list, and every endpoint gets its
// fields, version and purpose — here, after everything above is defined.
API_ENDPOINTS.push(...V12_ENDPOINTS());
for (const e of API_ENDPOINTS) Object.assign(e, ENDPOINT_DETAILS[e.id] ?? {});
