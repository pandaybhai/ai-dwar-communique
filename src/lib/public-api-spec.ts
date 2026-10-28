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
  API_ERRORS,
  API_ORIGIN,
  MAX_BULK_CONTACTS,
  MEDIA_LINK_SECONDS,
  MEDIA_LIMITS,
  WEBHOOK_BODY_EXAMPLE,
} from "@/lib/public-api";

export type ApiEndpoint = {
  /** Anchor on the docs page and the Postman item's id. */
  id: string;
  group: "Messages" | "Media" | "Contacts" | "Templates" | "Account";
  method: "GET" | "POST" | "DELETE";
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
      "Any approved template, at any time: its header (none, text values, an image, a video, a document or a map pin), its body values and its buttons' values, all checked against the template before anything is sent. The Batch 34 document request ({ document, body_params }) works unchanged.",
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
        label: "an invoice PDF (the Batch 34 request)",
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
    lines.push(`  -d '${shellQuote(JSON.stringify(body, null, 2))}'`);
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
    ...(body ? [`  body: JSON.stringify(${indent(JSON.stringify(body, null, 2))}),`] : []),
    `});`,
    e.id === "media-download"
      ? `if (!res.ok) throw new Error(\`\${res.status}\`);\nconst file = Buffer.from(await res.arrayBuffer());`
      : `const answer = await res.json();\nif (!res.ok) throw new Error(\`\${res.status} \${answer.code}: \${answer.error}\`);`,
  ].join("\n");
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
      _postman_id: "aidwar-public-api-v1-1",
      description: `The AiDwar Public API (v1.1). Set apiKey to your key (Settings → API & webhooks). Docs: ${origin}/developers/api`,
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
