import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import { MEDIA_LIMITS, type MediaKind } from "@/lib/public-api";
import type { ApiAnswer } from "@/lib/public-api-send.server";

/**
 * Batch 37: a file the Public API sends — a template's picture, video or
 * document header, or a session image / video / audio / document — read from
 * the request (`url` or `base64`) the way Batch 34 read the invoice PDF:
 * https only, a public host on every hop (fetchPublicFile, safe-fetch.server),
 * one timeout, never more than the kind's size limit read or decoded, and the
 * type taken from the file's own first bytes. One reader for every kind; the
 * `document` field of a Batch 34 request gets exactly the codes and words it
 * always got.
 *
 * Never logs a file or a link.
 */

export const MEDIA_FETCH_TIMEOUT_MS = 15_000;

const fail = (status: number, code: string, error: string): ApiAnswer => ({
  status,
  body: { error, code },
});

/** The media part of a request, checked for shape only (nothing read yet). */
export type MediaInput = {
  kind: MediaKind;
  url: string | null;
  base64: string | null;
  filename: string | null;
  caption: string | null;
  /** Where it sat in the request, for the words of an error: "document", "header", "image"… */
  field: string;
};

export type MediaFile = { bytes: Uint8Array; mime: string; filename: string };

/** The error code family: a document keeps Batch 34's document_* codes. */
function codeFor(kind: MediaKind, what: string): string {
  return `${kind === "document" ? "document" : "media"}_${what}`;
}

function noun(kind: MediaKind): string {
  return kind === "audio" ? "audio file" : kind;
}

function tooLarge(kind: MediaKind): ApiAnswer {
  return fail(
    413,
    codeFor(kind, "too_large"),
    `The ${noun(kind)} is larger than ${MEDIA_LIMITS[kind].mb} MB, the most WhatsApp accepts.`,
  );
}

export function maxBytesFor(kind: MediaKind): number {
  return MEDIA_LIMITS[kind].mb * 1024 * 1024;
}

/**
 * `{ url }` or `{ base64 }` (exactly one), plus filename / caption. `invalid`
 * is the code a malformed part answers with (Batch 34: invalid_document).
 */
export function parseMediaInput(
  raw: unknown,
  input: { kind: MediaKind; field: string; invalid: string; required: string },
): MediaInput | ApiAnswer {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fail(400, input.invalid, input.required);
  }
  const d = raw as Record<string, unknown>;
  const url = typeof d["url"] === "string" && d["url"].trim() ? d["url"].trim() : null;
  const base64 = typeof d["base64"] === "string" && d["base64"].trim() ? d["base64"].trim() : null;
  if ((url ? 1 : 0) + (base64 ? 1 : 0) !== 1) {
    return fail(
      400,
      input.invalid,
      `Send the ${noun(input.kind)} as exactly one of \`${input.field}.url\` (https) or \`${input.field}.base64\`.`,
    );
  }
  if (url && !/^https:\/\//i.test(url))
    return fail(
      400,
      codeFor(input.kind, "url_not_https"),
      `\`${input.field}.url\` must be an https:// address.`,
    );
  const filename = typeof d["filename"] === "string" ? d["filename"] : null;
  const caption =
    typeof d["caption"] === "string" && d["caption"].trim() ? d["caption"].trim() : null;
  if (caption && caption.length > 1024)
    return fail(400, input.invalid, `\`${input.field}.caption\` is longer than 1,024 characters.`);
  return { kind: input.kind, url, base64, filename, caption, field: input.field };
}

/** base64 (optionally a data: URL) -> bytes, refusing anything over the limit before decoding it. */
export function decodeBase64Media(
  raw: string,
  kind: MediaKind,
  field: string,
): Uint8Array | ApiAnswer {
  const max = maxBytesFor(kind);
  const text = raw.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (!text || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(text))
    return fail(
      400,
      kind === "document" ? "invalid_document" : "invalid_media",
      `\`${field}.base64\` isn't valid base64.`,
    );
  if (Math.floor((text.length * 3) / 4) > max + 2) return tooLarge(kind);
  const bytes = new Uint8Array(
    Buffer.from(text, text.includes("-") || text.includes("_") ? "base64url" : "base64"),
  );
  if (bytes.byteLength > max) return tooLarge(kind);
  return bytes;
}

const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.subarray(from, to));

/** What the file is, from its first bytes; null when it isn't one WhatsApp takes for this kind. */
export function sniffMime(
  bytes: Uint8Array,
  kind: MediaKind,
  filename?: string | null,
): string | null {
  const b = bytes;
  if (kind === "image") {
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
    if (b.length >= 8 && ascii(b, 1, 4) === "PNG" && b[0] === 0x89) return "image/png";
    return null;
  }
  const ftyp = b.length >= 12 && ascii(b, 4, 8) === "ftyp" ? ascii(b, 8, 12) : null;
  if (kind === "video") {
    if (!ftyp) return null;
    return ftyp.startsWith("3g") ? "video/3gpp" : "video/mp4";
  }
  if (kind === "audio") {
    if (b.length >= 4 && ascii(b, 0, 4) === "OggS") return "audio/ogg";
    if (b.length >= 5 && ascii(b, 0, 5) === "#!AMR") return "audio/amr";
    if (b.length >= 3 && ascii(b, 0, 3) === "ID3") return "audio/mpeg";
    if (ftyp) return "audio/mp4";
    if (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xf6) === 0xf0) return "audio/aac";
    if (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) return "audio/mpeg";
    return null;
  }
  // document
  if (b.length >= 5 && ascii(b, 0, 5) === "%PDF-") return "application/pdf";
  const ext = (filename ?? "").match(/\.([A-Za-z0-9]{1,5})$/)?.[1]?.toLowerCase() ?? "";
  const ole = b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;
  const zip = b.length >= 4 && ascii(b, 0, 4) === "PK\u0003\u0004";
  if (ole) {
    if (ext === "doc") return "application/msword";
    if (ext === "xls") return "application/vnd.ms-excel";
    if (ext === "ppt") return "application/vnd.ms-powerpoint";
    return null;
  }
  if (zip) {
    if (ext === "docx")
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (ext === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    if (ext === "pptx")
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    return null;
  }
  if (ext === "txt" && !b.includes(0)) return "text/plain";
  return null;
}

const EXT_OF: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "audio/ogg": "ogg",
  "audio/amr": "amr",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "application/msword": "doc",
  "application/vnd.ms-excel": "xls",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

// Control characters are exactly what a file name must lose.
// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME_CHARS = /[\u0000-\u001f\u007f"<>|*?]/g;

/** A file name the customer sees: no path, no control characters, ending in the file's own extension. */
export function mediaFilename(raw: string | null, mime: string): string {
  const ext = EXT_OF[mime] ?? "bin";
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const clean = base.replace(UNSAFE_FILENAME_CHARS, "").trim().slice(0, 120);
  if (!clean) return mime === "application/pdf" ? "document.pdf" : `file.${ext}`;
  return clean.toLowerCase().endsWith(`.${ext}`) ? clean : `${clean}.${ext}`;
}

/** sha256 of what was sent for the file (the link, or the base64 text): for idempotency fingerprints. */
export function mediaFingerprint(input: MediaInput | null): Record<string, unknown> | null {
  if (!input) return null;
  return {
    kind: input.kind,
    url: input.url,
    sha256: input.base64 ? createHash("sha256").update(input.base64).digest("hex") : null,
    filename: input.filename,
    caption: input.caption,
  };
}

/**
 * The file itself: downloaded (SSRF-safe) or decoded, under the kind's limit,
 * not empty, of a type WhatsApp takes for the kind. `only` narrows the types
 * (a template's document header is a PDF).
 */
export async function readMediaFile(
  input: MediaInput,
  options: { only?: string[] } = {},
): Promise<MediaFile | ApiAnswer> {
  const { kind, field } = input;
  let bytes: Uint8Array;
  if (input.url) {
    const { fetchPublicFile } = await import("@/lib/safe-fetch.server");
    const file = await fetchPublicFile(input.url, {
      maxBytes: maxBytesFor(kind),
      timeoutMs: MEDIA_FETCH_TIMEOUT_MS,
    });
    if (!file.ok) {
      if (file.code === "too_large") return tooLarge(kind);
      if (file.code === "blocked")
        return fail(
          400,
          codeFor(kind, "url_blocked"),
          `\`${field}.url\` must be a public https address (no private or internal hosts, also after redirects).`,
        );
      if (file.code === "timeout")
        return fail(
          400,
          codeFor(kind, "unreachable"),
          `We couldn't download \`${field}.url\` in 15 seconds.`,
        );
      return fail(
        400,
        codeFor(kind, "unreachable"),
        `We couldn't download \`${field}.url\` (${file.detail}).`,
      );
    }
    bytes = file.bytes;
  } else {
    const decoded = decodeBase64Media(input.base64!, kind, field);
    if (!(decoded instanceof Uint8Array)) return decoded;
    bytes = decoded;
  }
  if (!bytes.byteLength) return fail(400, codeFor(kind, "empty"), `The ${noun(kind)} is empty.`);
  const mime = sniffMime(bytes, kind, input.filename);
  const allowed = options.only ?? (MEDIA_LIMITS[kind].types as readonly string[]);
  if (!mime || !allowed.includes(mime)) {
    if (kind === "document" && options.only?.length === 1 && options.only[0] === "application/pdf")
      return fail(400, "document_not_pdf", "The document must be a PDF.");
    return fail(
      400,
      kind === "document" ? "document_type_unsupported" : "media_type_unsupported",
      `The ${noun(kind)} must be ${kind === "document" ? "a" : "an"} ${MEDIA_LIMITS[kind].label} file.`,
    );
  }
  return { bytes, mime, filename: mediaFilename(input.filename, mime) };
}

/**
 * Our copy of a file the API sent, in the private chat-media bucket (Batch
 * 32), at {org}/{conversation}/{message}.{ext}, so the inbox shows what the
 * customer got (served only through /api/whatsapp/chat-media/$messageId).
 * Never fails the send: the message has already gone. Gives back Meta's id
 * for the message (the wamid) from the same read.
 */
export async function keepMediaCopy(
  supabase: SupabaseClient,
  input: { organizationId: string; messageId: string; bytes: Uint8Array; mime: string },
): Promise<{ wamid: string | null }> {
  let wamid: string | null = null;
  try {
    const { CHAT_MEDIA_BUCKET, STORAGE_PREFIX, chatMediaObjectPath } =
      await import("@/lib/chat-media.server");
    const { data: row } = await supabase
      .from("messages")
      .select("conversation_id, meta_message_id")
      .eq("id", input.messageId)
      .maybeSingle();
    const read = row as { conversation_id?: string | null; meta_message_id?: string | null } | null;
    wamid = read?.meta_message_id ?? null;
    const conversationId = read?.conversation_id;
    if (!conversationId) return { wamid };
    const path = chatMediaObjectPath({
      organizationId: input.organizationId,
      conversationId,
      messageId: input.messageId,
      mime: input.mime,
    });
    const { error } = await supabase.storage
      .from(CHAT_MEDIA_BUCKET)
      .upload(path, input.bytes, { contentType: input.mime, upsert: true });
    if (error) throw new Error(error.message);
    const { error: rowError } = await supabase
      .from("messages")
      .update({ media_url: `${STORAGE_PREFIX}${path}`, media_mime: input.mime })
      .eq("id", input.messageId)
      .eq("organization_id", input.organizationId);
    if (rowError) throw new Error(rowError.message);
  } catch (error) {
    console.warn(
      JSON.stringify({
        scope: "public_api",
        step: "media_copy",
        message_id: input.messageId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  return { wamid };
}
