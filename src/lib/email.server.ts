import { outsideFetch } from "@/lib/outside-call.server";

/**
 * Platform email, sent through Resend's HTTP API (no SDK).
 *
 * Email carries platform notices only — hand-off alerts, billing notices,
 * account notices, a flow's "email your team" step — never a reply to a
 * customer. Every message goes out in one shared layout: the plain text as
 * given, plus a minimal HTML copy where every character is escaped and only
 * https links are made clickable. No images, no tracking pixels.
 *
 * Settings: RESEND_API_KEY (secret), EMAIL_FROM (default
 * "AiDwar <notify@mail.aidwar.in>"), EMAIL_REPLY_TO (optional). Without a
 * key nothing is sent and the result is exactly what the stub returned —
 * email_not_configured — so callers behave as before the key exists.
 *
 * A send that times out is a failure (it may still arrive; callers that
 * retry pass an idempotencyKey so Resend drops the duplicate).
 */
export type EmailMessage = {
  to: string;
  subject: string;
  body: string;
  /**
   * A file to attach (invoice PDFs). Fetched here, server-side; when it
   * can't be fetched or is too large the email goes without it and the
   * body carries the link instead.
   */
  attachmentUrl?: string | null;
  /** The attachment's file name; default "attachment.pdf". */
  attachmentName?: string | null;
  /** Resend drops a second send with the same key (24 h). */
  idempotencyKey?: string | null;
};

export type EmailResult = {
  ok: boolean;
  /** Resend's email id when it was accepted. */
  id?: string;
  /** Resend's own error text when it refused, or why it never got there. */
  error?: string;
  /** What happened to attachmentUrl, when one was given. */
  attachment?: "attached" | "linked";
};

export const RESEND_API_URL = "https://api.resend.com/emails";
/**
 * The workspace's Resend connection is gateway-backed: its RESEND_API_KEY is a
 * connection key for the Lovable gateway, not a provider key, so production
 * sends go through the gateway (which holds the real provider key). When only
 * RESEND_API_KEY is set (tests, a direct provider key), the call goes straight
 * to Resend as before.
 */
export const RESEND_GATEWAY_URL = "https://connector-gateway.lovable.dev/resend/emails";
export const DEFAULT_EMAIL_FROM = "AiDwar <notify@mail.aidwar.in>";
/** Bigger files go as a link (Resend's own limit is 40 MB after encoding). */
export const EMAIL_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

export function isEmailAddress(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && EMAIL_RE.test(value.trim());
}

export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  const apiKey = process.env["RESEND_API_KEY"]?.trim();
  if (!apiKey) {
    console.info("[email:stub] would send", {
      to: message.to,
      subject: message.subject,
      attachment: message.attachmentUrl ?? null,
    });
    return { ok: false, error: "email_not_configured" };
  }

  const to = String(message.to ?? "").trim();
  if (!isEmailAddress(to)) return { ok: false, error: "invalid_recipient" };
  const subject = oneLine(message.subject).slice(0, 200) || "A notice from AiDwar";
  let body = String(message.body ?? "");

  let attachment: "attached" | "linked" | undefined;
  let attachments: Array<{ filename: string; content: string }> | undefined;
  if (message.attachmentUrl) {
    const file = await fetchAttachment(message.attachmentUrl);
    if (file.ok) {
      attachment = "attached";
      attachments = [{ filename: safeFileName(message.attachmentName), content: file.base64 }];
    } else {
      attachment = "linked";
      console.warn("[email] attachment not attached", JSON.stringify({ reason: file.error }));
      body = `${body.trimEnd()}\n\nDownload the file here: ${message.attachmentUrl}`;
    }
  }

  const replyTo = process.env["EMAIL_REPLY_TO"]?.trim();
  const payload: Record<string, unknown> = {
    from: process.env["EMAIL_FROM"]?.trim() || DEFAULT_EMAIL_FROM,
    to: [to],
    subject,
    text: emailText(body),
    html: emailHtml(subject, body),
  };
  if (replyTo) payload["reply_to"] = replyTo;
  if (attachments) payload["attachments"] = attachments;

  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
  if (message.idempotencyKey)
    headers["idempotency-key"] = String(message.idempotencyKey).slice(0, 256);

  let res: Response;
  let answer: Record<string, unknown> = {};
  try {
    res = await outsideFetch("email", RESEND_API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    answer = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    const timedOut = error instanceof Error && error.name === "OutsideCallTimeout";
    console.warn(
      "[email] send failed",
      JSON.stringify({ reason: timedOut ? "timeout" : "unreachable" }),
    );
    return {
      ok: false,
      error: `${timedOut ? "email_timeout" : "email_unreachable"}: ${text}`,
      ...(attachment ? { attachment } : {}),
    };
  }

  if (!res.ok) {
    const detail = String(answer["message"] ?? answer["error"] ?? res.statusText ?? "").trim();
    const name = String(answer["name"] ?? "").trim();
    const error =
      `Resend ${res.status}${name ? ` ${name}` : ""}: ${detail || "no error text"}`.slice(0, 500);
    console.warn("[email] refused", JSON.stringify({ status: res.status, name: name || null }));
    return { ok: false, error, ...(attachment ? { attachment } : {}) };
  }
  const id = typeof answer["id"] === "string" ? answer["id"] : undefined;
  console.info("[email] sent", JSON.stringify({ id: id ?? null, attachment: attachment ?? null }));
  return { ok: true, ...(id ? { id } : {}), ...(attachment ? { attachment } : {}) };
}

// ------------------------------------------------------------- attachment

async function fetchAttachment(
  url: string,
): Promise<{ ok: true; base64: string } | { ok: false; error: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "bad_url" };
  }
  // Only our own signed storage links are passed here; never plain http.
  if (parsed.protocol !== "https:") return { ok: false, error: "not_https" };
  try {
    const res = await outsideFetch("email", parsed);
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, error: `http_${res.status}` };
    }
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > EMAIL_ATTACHMENT_MAX_BYTES) {
      await res.body.cancel().catch(() => undefined);
      return { ok: false, error: "too_large" };
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > EMAIL_ATTACHMENT_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, error: "too_large" };
      }
      chunks.push(value);
    }
    if (size === 0) return { ok: false, error: "empty" };
    return { ok: true, base64: toBase64(chunks) };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error && error.name === "OutsideCallTimeout" ? "timeout" : "unreachable",
    };
  }
}

function toBase64(chunks: Uint8Array[]): string {
  let binary = "";
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 0x8000) {
      binary += String.fromCharCode(...chunk.subarray(i, i + 0x8000));
    }
  }
  return btoa(binary);
}

function safeFileName(name: string | null | undefined): string {
  const cleaned = String(name ?? "")
    .replace(/[^\w.\- ]+/g, "-")
    .replace(/^[.\s-]+/, "")
    .slice(0, 100)
    .trim();
  return cleaned || "attachment.pdf";
}

// ----------------------------------------------------------------- layout

const FOOTER = "This is an automatic notice from AiDwar.";

function oneLine(value: unknown): string {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** The plain-text part: the notice as written, then the shared footer. */
export function emailText(body: string): string {
  return `${String(body ?? "").trim()}\n\n—\n${FOOTER}\n`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const LINK_RE = /https:\/\/[^\s<>"'`]+/g;

/** Escaped text with https links made clickable (each piece escaped on its own). */
function linkify(line: string): string {
  let out = "";
  let last = 0;
  for (const match of line.matchAll(LINK_RE)) {
    let url = match[0];
    // Trailing punctuation belongs to the sentence, not the link.
    const trail = /[.,;:!?)\]]+$/.exec(url)?.[0] ?? "";
    if (trail) url = url.slice(0, -trail.length);
    const start = match.index ?? 0;
    out += escapeHtml(line.slice(last, start));
    const safe = escapeHtml(url);
    out += `<a href="${safe}" style="color:#1d4ed8;word-break:break-all">${safe}</a>`;
    last = start + url.length;
  }
  return out + escapeHtml(line.slice(last));
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** The one HTML layout every email uses. Everything given is escaped. */
export function emailHtml(subject: string, body: string): string {
  const paragraphs = String(body ?? "")
    .trim()
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p) => `<p style="margin:0 0 14px">${p.split("\n").map(linkify).join("<br>")}</p>`)
    .join("");
  return (
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(oneLine(subject))}</title></head>` +
    `<body style="margin:0;padding:0;background:#f4f5f7">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7"><tr><td align="center" style="padding:24px 12px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px">` +
    `<tr><td style="padding:20px 24px 8px;font:600 16px/1.4 ${FONT};color:#111827">AiDwar</td></tr>` +
    `<tr><td style="padding:8px 24px 10px;font:14px/1.6 ${FONT};color:#111827">${paragraphs}</td></tr>` +
    `<tr><td style="padding:14px 24px 18px;border-top:1px solid #e5e7eb;font:12px/1.5 ${FONT};color:#6b7280">${escapeHtml(FOOTER)}</td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}
