import type { SupabaseClient } from "@supabase/supabase-js";
import { createHmac, timingSafeEqual } from "crypto";
import type { ApiCaller, ApiReply } from "@/lib/public-api.server";
import { API_ORIGIN, MEDIA_LINK_SECONDS } from "@/lib/public-api";

/**
 * Batch 37 item 3: a message's file through the API — the file a customer
 * sent (message.received gives `media.url`) or one the API sent.
 *
 * GET /api/v1/media/{message_id} (API key) answers a download link that
 * works for MEDIA_LINK_SECONDS and only with the same API key: its signature
 * is HMAC-SHA256 keyed with that key's sha256, over workspace, message and
 * expiry. GET …/download (API key + that link) streams the bytes from our
 * private copy (chat-media, Batch 32), or from Meta while the copy isn't
 * made yet — never a public or storage-signed link, as for the inbox. Only
 * the key's own workspace: another workspace's message id is the same 404 as
 * one that doesn't exist. Never logs a key or a file.
 */

const notFound = (): ApiReply => ({
  status: 404,
  body: { error: "There is no file for this message in this workspace.", code: "not_found" },
});

type MediaRow = {
  id: string;
  media_url: string | null;
  media_mime: string | null;
  conversation_id: string | null;
  metadata: Record<string, unknown> | null;
};

async function readRow(
  supabase: SupabaseClient,
  caller: ApiCaller,
  messageId: string,
): Promise<MediaRow | null> {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(messageId)) return null;
  const { data, error } = await supabase
    .from("messages")
    .select("id, media_url, media_mime, conversation_id, metadata")
    .eq("id", messageId)
    .eq("organization_id", caller.organizationId)
    .maybeSingle();
  const row = (error ? null : data) as MediaRow | null;
  const ref = row?.media_url ?? "";
  return row && (ref.startsWith("meta:") || ref.startsWith("storage:")) ? row : null;
}

export function mediaSignature(
  keyHash: string,
  input: { organizationId: string; messageId: string; expires: number },
): string {
  return createHmac("sha256", keyHash)
    .update(`${input.organizationId}.${input.messageId}.${input.expires}`, "utf8")
    .digest("hex");
}

function filenameFor(row: MediaRow): string {
  const own = row.metadata?.["document_filename"];
  if (typeof own === "string" && own) return own;
  const ref = row.media_url ?? "";
  const ext = ref.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? "bin";
  return `${row.id}.${ext}`;
}

/** GET /api/v1/media/{message_id}: what the file is and a short-lived link to it. */
export async function mediaLink(
  supabase: SupabaseClient,
  caller: ApiCaller,
  keyHash: string,
  messageId: string,
  now = Date.now(),
): Promise<ApiReply> {
  const row = await readRow(supabase, caller, messageId);
  if (!row || !keyHash) return notFound();
  const expires = Math.floor(now / 1000) + MEDIA_LINK_SECONDS;
  const signature = mediaSignature(keyHash, {
    organizationId: caller.organizationId,
    messageId: row.id,
    expires,
  });
  return {
    status: 200,
    body: {
      message_id: row.id,
      mime_type: row.media_mime,
      filename: filenameFor(row),
      url: `${API_ORIGIN}/api/v1/media/${row.id}/download?expires=${expires}&signature=${signature}`,
      expires_at: new Date(expires * 1000).toISOString(),
    },
    headers: { "cache-control": "no-store" },
  };
}

/** GET /api/v1/media/{message_id}/download?expires=…&signature=…: the bytes. */
export async function mediaDownload(
  supabase: SupabaseClient,
  caller: ApiCaller,
  keyHash: string,
  messageId: string,
  query: URLSearchParams,
  now = Date.now(),
): Promise<ApiReply | Response> {
  const expires = Number(query.get("expires") ?? NaN);
  const given = String(query.get("signature") ?? "");
  if (!Number.isInteger(expires) || !/^[0-9a-f]{64}$/.test(given) || !keyHash) {
    return {
      status: 403,
      body: {
        error: "This download link isn't valid. Ask GET /api/v1/media/{message_id} for a new one.",
        code: "invalid_media_link",
      },
    };
  }
  const expected = mediaSignature(keyHash, {
    organizationId: caller.organizationId,
    messageId,
    expires,
  });
  if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(given, "hex"))) {
    return {
      status: 403,
      body: {
        error:
          "This download link isn't valid for this API key. Ask GET /api/v1/media/{message_id} for a new one.",
        code: "invalid_media_link",
      },
    };
  }
  if (now / 1000 > expires) {
    return {
      status: 410,
      body: {
        error: "This download link has expired. Ask GET /api/v1/media/{message_id} for a new one.",
        code: "media_link_expired",
      },
    };
  }
  const row = await readRow(supabase, caller, messageId);
  if (!row) return notFound();

  const { CHAT_MEDIA_MAX_BYTES, metaMediaId, readStoredMedia } =
    await import("@/lib/chat-media.server");
  let file: { bytes: Uint8Array; mime: string | null } | null = null;
  const metaId = metaMediaId(row.media_url);
  if (metaId) {
    // Not copied yet (or too large to keep): from Meta, with this thread's number.
    const { data: conv } = await supabase
      .from("conversations")
      .select("whatsapp_account_id")
      .eq("id", row.conversation_id ?? "")
      .eq("organization_id", caller.organizationId)
      .maybeSingle();
    const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
    const { connection } = await getWhatsAppConnection(
      supabase,
      caller.organizationId,
      (conv as { whatsapp_account_id?: string | null } | null)?.whatsapp_account_id ?? null,
    );
    if (connection) {
      const { fetchMetaMediaFile } = await import("@/lib/ai-media.server");
      const got = await fetchMetaMediaFile(metaId, connection.accessToken, CHAT_MEDIA_MAX_BYTES);
      if (got.status === "too_large")
        return {
          status: 413,
          body: {
            error: "This file is larger than 25 MB, more than the API passes on.",
            code: "media_too_large",
          },
        };
      if (got.status === "ok") file = { bytes: got.bytes, mime: got.mime };
    }
  } else {
    file = await readStoredMedia(supabase, row.media_url);
  }
  if (!file) {
    return {
      status: 502,
      body: {
        error: "We couldn't load this file just now. Please try again.",
        code: "media_unavailable",
      },
    };
  }
  const mime = row.media_mime && row.media_mime.includes("/") ? row.media_mime : (file.mime ?? "");
  const { mediaResponseHeaders } = await import("@/lib/media-serve");
  const safeName = filenameFor(row).replace(/[^A-Za-z0-9._-]/g, "_");
  return new Response(file.bytes as BodyInit, {
    status: 200,
    headers: {
      ...mediaResponseHeaders(mime || "application/octet-stream"),
      "content-disposition": `attachment; filename="${safeName}"`,
      "cache-control": "private, no-store",
    },
  });
}
