/**
 * Batch 34: what the Public API promises, in one place for the server, the
 * public docs (/developers/api) and Settings → API & webhooks — so the limits
 * the docs state are the limits the server enforces, and the curl in
 * Settings is the curl in the docs. Pure: no server code.
 */
import { templateVariableSpec, type TemplateComponent } from "@/lib/templates";

export const API_KEY_PREFIX = "adw_live_";
/** Calls a minute: one key, and one workspace across all its keys (sends and status reads alike). */
export const RATE_PER_KEY_PER_MIN = 60;
export const RATE_PER_WORKSPACE_PER_MIN = 300;
export const MAX_DOCUMENT_MB = 16;
export const IDEMPOTENCY_WINDOW_HOURS = 24;
export const WEBHOOK_RETRY_HOURS = 24;
export const WEBHOOK_TIMEOUT_SECONDS = 10;
export const SIGNATURE_TOLERANCE_SECONDS = 300;
export const DOCS_PATH = "/developers/api";

export const SEND_PATH = "/api/v1/messages/template";
export const STATUS_PATH = "/api/v1/messages/{message_id}";
export const SESSION_PATH = "/api/v1/messages/session";

/** Batch 37: where the API is served (media links in webhook events, the Postman collection). */
export const API_ORIGIN = "https://aidwar.in";

/**
 * Batch 37: the files the API sends, per kind — the types WhatsApp takes and
 * its size limits (image 5 MB; video and audio 16 MB). A document is held to
 * MAX_DOCUMENT_MB (16 MB, as in Batch 34; WhatsApp itself takes up to 100 MB):
 * the file passes through our server whole. The type is read from the file's
 * own first bytes, never from a header or a file name alone.
 */
export const MEDIA_LIMITS = {
  image: { mb: 5, types: ["image/jpeg", "image/png"], label: "JPEG or PNG" },
  video: { mb: 16, types: ["video/mp4", "video/3gpp"], label: "MP4 or 3GPP" },
  audio: {
    mb: 16,
    types: ["audio/aac", "audio/amr", "audio/mpeg", "audio/mp4", "audio/ogg"],
    label: "AAC, AMR, MP3, M4A or OGG (Opus)",
  },
  document: {
    mb: MAX_DOCUMENT_MB,
    types: [
      "application/pdf",
      "text/plain",
      "application/msword",
      "application/vnd.ms-excel",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    label: "PDF, TXT, DOC(X), XLS(X) or PPT(X)",
  },
} as const;
export type MediaKind = keyof typeof MEDIA_LIMITS;

export const WEBHOOK_EVENT_NAMES = [
  "message.sent",
  "message.delivered",
  "message.read",
  "message.failed",
] as const;

/**
 * Batch 37: the events a webhook hears beyond its own messages' statuses —
 * queued for a workspace whose webhook is set and active.
 */
export const INBOUND_EVENT_NAMES = [
  "message.received",
  "contact.created",
  "contact.opted_out",
  "contact.opted_in",
  "template.status_changed",
  "template.category_changed",
] as const;
export type InboundEventName = (typeof INBOUND_EVENT_NAMES)[number];

/** Every event a webhook can receive, in the order Settings and the docs list them. */
export const ALL_WEBHOOK_EVENTS = [...WEBHOOK_EVENT_NAMES, ...INBOUND_EVENT_NAMES] as const;

export const MEDIA_PATH = "/api/v1/media/{message_id}";
/** Contacts one POST /api/v1/contacts/bulk takes. */
export const MAX_BULK_CONTACTS = 1000;
/** How long a download link from GET /api/v1/media/{message_id} works. */
export const MEDIA_LINK_SECONDS = 300;

/** Every error the API answers with: status, codes, when. */
export const API_ERRORS: Array<{ status: string; codes: string[]; meaning: string }> = [
  {
    status: "400",
    codes: [
      "invalid_json",
      "invalid_to",
      "invalid_template_name",
      "invalid_document",
      "invalid_body_params",
      "invalid_idempotency_key",
      "template_not_found",
      "template_not_approved",
      "template_not_document",
      "template_unsupported",
      "language_required",
      "param_count_mismatch",
      "document_url_not_https",
      "document_url_blocked",
      "document_unreachable",
      "document_not_pdf",
      "document_empty",
      "document_type_unsupported",
      "no_whatsapp_number",
      "invalid_header",
      "header_required",
      "header_mismatch",
      "invalid_buttons",
      "invalid_offer",
      "invalid_media",
      "media_url_not_https",
      "media_url_blocked",
      "media_unreachable",
      "media_empty",
      "media_type_unsupported",
    ],
    meaning:
      "The request can't be sent as it is: fix what the message says and send again. Nothing was sent.",
  },
  {
    status: "401",
    codes: ["unauthorized"],
    meaning: "No API key, a mistyped one, or a revoked one.",
  },
  {
    status: "402",
    codes: ["insufficient_credits", "workspace_locked"],
    meaning:
      "The workspace's AiDwar wallet can't cover this message, or the workspace has no active plan. Nothing was sent.",
  },
  {
    status: "403",
    codes: ["public_api_disabled"],
    meaning: "The Public API isn't switched on for this workspace (it is part of the Scale plan).",
  },
  {
    status: "404",
    codes: ["not_found"],
    meaning: "No message with this id was sent by the API in your workspace.",
  },
  {
    status: "409",
    codes: ["contact_opted_out", "idempotency_key_reused", "idempotency_in_progress"],
    meaning:
      "The customer opted out of your messages; or this idempotency_key was used for a different request, or that request is still being sent. Nothing new was sent.",
  },
  {
    status: "413",
    codes: ["document_too_large", "media_too_large", "request_too_large"],
    meaning: `The file is over its limit: a document ${MAX_DOCUMENT_MB} MB, a picture ${MEDIA_LIMITS.image.mb} MB, a video or audio file ${MEDIA_LIMITS.video.mb} MB.`,
  },
  {
    status: "429",
    codes: ["rate_limited"],
    meaning: "Too many requests this minute. Wait the seconds in the Retry-After header.",
  },
  {
    status: "5xx",
    codes: ["whatsapp_upload_failed", "whatsapp_rejected", "unavailable", "internal_error"],
    meaning:
      "502: WhatsApp refused the file or the message (a refused message is in your inbox, marked failed). 503 / 500: try again — with the same idempotency_key it is never sent twice.",
  },
];

export type CurlInput = {
  origin: string;
  templateName: string;
  language?: string | null;
  paramCount: number;
};

/** Example values for a template's numbered body values. */
export function exampleParams(count: number): string[] {
  const samples = ["Asha", "INV-1001", "2,500.00"];
  return Array.from({ length: count }, (_, i) => samples[i] ?? `value ${i + 1}`);
}

function sendBody(input: CurlInput, document: Record<string, string>): Record<string, unknown> {
  return {
    to: "+919812345678",
    template_name: input.templateName,
    ...(input.language ? { language: input.language } : {}),
    document,
    body_params: exampleParams(input.paramCount),
    idempotency_key: "inv-1001",
  };
}

/** The send call as curl, with the key from an environment variable (never pasted into a page). */
export function curlExample(input: CurlInput): string {
  const body = JSON.stringify(
    sendBody(input, {
      url: "https://your-billing.example.com/invoices/INV-1001.pdf",
      filename: "INV-1001.pdf",
    }),
    null,
    2,
  );
  return [
    `curl -X POST ${input.origin}${SEND_PATH} \\`,
    `  -H "Authorization: Bearer $AIDWAR_API_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${body.replace(/'/g, "'\\''")}'`,
  ].join("\n");
}

/** The same call from Node 18+ (fetch built in), sending the PDF itself as base64. */
export function javascriptExample(input: CurlInput): string {
  const body = JSON.stringify(
    sendBody(input, { base64: "__PDF__", filename: "INV-1001.pdf" }),
    null,
    2,
  )
    .replace('"__PDF__"', 'readFileSync("INV-1001.pdf").toString("base64")')
    .split("\n")
    .map((line, i) => (i === 0 ? line : `  ${line}`))
    .join("\n");
  return [
    `import { readFileSync } from "node:fs";`,
    ``,
    `const res = await fetch("${input.origin}${SEND_PATH}", {`,
    `  method: "POST",`,
    `  headers: {`,
    `    Authorization: \`Bearer \${process.env.AIDWAR_API_KEY}\`,`,
    `    "Content-Type": "application/json",`,
    `  },`,
    `  body: JSON.stringify(${body}),`,
    `});`,
    `const answer = await res.json();`,
    `if (res.status !== 202) throw new Error(\`\${res.status} \${answer.code}: \${answer.error}\`);`,
    `console.log(answer.message_id, answer.status); // "…", "queued"`,
  ].join("\n");
}

export function statusCurlExample(origin: string): string {
  return [
    `curl ${origin}/api/v1/messages/MESSAGE_ID \\`,
    `  -H "Authorization: Bearer $AIDWAR_API_KEY"`,
  ].join("\n");
}

/** How a merchant's server checks X-AiDwar-Signature (Node, Express-style raw body). */
export const VERIFY_SIGNATURE_EXAMPLE = `import { createHmac, timingSafeEqual } from "node:crypto";

// rawBody: the request body exactly as received (a string or Buffer), before any JSON parsing.
export function isFromAiDwar(rawBody, headers, secret) {
  const timestamp = headers["x-aidwar-timestamp"];
  const signature = headers["x-aidwar-signature"] ?? "";
  // Refuse old or future deliveries (replays).
  if (!timestamp || Math.abs(Date.now() / 1000 - Number(timestamp)) > ${SIGNATURE_TOLERANCE_SECONDS}) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(\`\${timestamp}.\${rawBody}\`).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}`;

export const WEBHOOK_BODY_EXAMPLE = JSON.stringify(
  {
    event: "message.delivered",
    message_id: "6f1c2b0e-3c4d-4f7a-9a51-2f0d8c1e7b42",
    idempotency_key: "inv-1001",
    to: "+919812345678",
    status: "delivered",
    error: null,
    timestamp: "2026-10-27T10:00:09.000Z",
  },
  null,
  2,
);

/**
 * The workspace's templates the API can send: approved, with a document
 * header and nothing but numbered body values to fill (the same rule the
 * server applies, resolveApiTemplate).
 */
export function apiReadyTemplates(
  rows: Array<{ name: string; language: string; status: string; components: unknown }>,
): Array<{ name: string; language: string; paramCount: number }> {
  const out: Array<{ name: string; language: string; paramCount: number }> = [];
  for (const row of rows) {
    if (row.status !== "APPROVED") continue;
    const spec = templateVariableSpec((row.components ?? []) as TemplateComponent[]);
    if (spec.headerMedia?.format !== "DOCUMENT") continue;
    if (
      spec.urlButtons.length ||
      spec.copyCodeButtons.length ||
      spec.cards.length ||
      spec.offerExpiration
    )
      continue;
    out.push({ name: row.name, language: row.language, paramCount: spec.body.length });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
