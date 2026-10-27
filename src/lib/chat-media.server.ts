import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Batch 32: customer media is kept.
 *
 * Meta's webhook gives an inbound photo, voice note, video, document or
 * sticker only as a media id ("meta:<id>" on messages.media_url), and that id
 * stops working after about 7 days — so every customer photo used to vanish
 * from the inbox a week later. Now the bytes are copied, once, into the
 * PRIVATE bucket chat-media at {organization_id}/{conversation_id}/{message_id}.{ext}
 * and the row says "storage:chat-media/<path>" (the Meta id stays on
 * metadata.meta_media_id).
 *
 * Saved by the webhook's own pass after the reply (afterReply in
 * processWebhookPayload, awaited before the event is closed), and by the
 * maintenance sweep (runChatMediaSweep, in the billing sweep) for what that
 * pass couldn't save. Only the service role reads or writes the bucket: the
 * inbox gets the bytes through /api/whatsapp/chat-media/$messageId after a
 * membership (or super admin) check, never a public link.
 */

export const CHAT_MEDIA_BUCKET = "chat-media";
export const STORAGE_PREFIX = `storage:${CHAT_MEDIA_BUCKET}/`;
/** Above this the Meta ref is kept and metadata.media_too_large is set. */
export const CHAT_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
/** Meta: media ids in webhooks stop working after 7 days. */
export const META_MEDIA_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type MediaMetadata = Record<string, unknown>;

/** "meta:<id>" -> "<id>", else null. */
export function metaMediaId(ref: string | null | undefined): string | null {
  return ref?.startsWith("meta:") && ref.length > 5 ? ref.slice(5) : null;
}

/** "storage:chat-media/<path>" -> "<path>", else null. */
export function chatMediaPath(ref: string | null | undefined): string | null {
  return ref?.startsWith(STORAGE_PREFIX) && ref.length > STORAGE_PREFIX.length
    ? ref.slice(STORAGE_PREFIX.length)
    : null;
}

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

/** The file's extension from its mime type, else its own filename's, else "bin". */
export function mediaExtension(mime: string | null | undefined, filename?: string | null): string {
  const base = (mime ?? "").split(";")[0]!.trim().toLowerCase();
  const known = EXT_BY_MIME[base];
  if (known) return known;
  const own = (filename ?? "").match(/\.([A-Za-z0-9]{1,8})$/)?.[1]?.toLowerCase();
  return own ?? "bin";
}

export function chatMediaObjectPath(args: {
  organizationId: string;
  conversationId: string;
  messageId: string;
  mime: string | null | undefined;
  filename?: string | null;
}): string {
  return `${args.organizationId}/${args.conversationId}/${args.messageId}.${mediaExtension(args.mime, args.filename)}`;
}

export type SaveOutcome = "saved" | "download_failed" | "too_large" | "upload_failed" | "skipped";

/**
 * Copies one inbound message's file from Meta into chat-media and points the
 * row at it. Never throws. A failed download or upload leaves the row on
 * "meta:<id>" (the sweep tries again); a file over 25 MB keeps the Meta ref
 * and gets metadata.media_too_large. The row is moved only while it still
 * holds the same Meta ref (one conditional update), so two passes saving the
 * same message write it once; the upload itself overwrites the same path.
 */
export async function saveInboundMedia(
  supabase: SupabaseClient,
  args: {
    messageId: string;
    organizationId: string;
    conversationId: string;
    mediaRef: string | null;
    mime: string | null;
    filename?: string | null;
    accessToken: string;
    /** The row's metadata when the caller already has it (the sweep). */
    metadata?: MediaMetadata | null;
  },
): Promise<SaveOutcome> {
  const mediaId = metaMediaId(args.mediaRef);
  if (!mediaId || !args.accessToken) return "skipped";
  try {
    const { fetchMetaMediaFile } = await import("@/lib/ai-media.server");
    const file = await fetchMetaMediaFile(mediaId, args.accessToken, CHAT_MEDIA_MAX_BYTES);
    if (file.status === "failed") return "download_failed";
    const metadata = args.metadata ?? (await readMetadata(supabase, args.messageId));
    if (file.status === "too_large") {
      await supabase
        .from("messages")
        .update({ metadata: { ...metadata, meta_media_id: mediaId, media_too_large: true } })
        .eq("id", args.messageId)
        .eq("media_url", args.mediaRef!);
      return "too_large";
    }
    const mime = file.mime ?? args.mime;
    const path = chatMediaObjectPath({
      organizationId: args.organizationId,
      conversationId: args.conversationId,
      messageId: args.messageId,
      mime: args.mime ?? mime,
      filename: args.filename ?? null,
    });
    const { error: uploadError } = await supabase.storage
      .from(CHAT_MEDIA_BUCKET)
      .upload(path, file.bytes, { contentType: mime ?? "application/octet-stream", upsert: true });
    if (uploadError) {
      console.warn(JSON.stringify({ scope: "chat_media", step: "upload", message_id: args.messageId, error: uploadError.message }));
      return "upload_failed";
    }
    const { error: rowError } = await supabase
      .from("messages")
      .update({
        media_url: `${STORAGE_PREFIX}${path}`,
        ...(args.mime ? {} : { media_mime: mime }),
        metadata: withoutRetryMarks({ ...metadata, meta_media_id: mediaId }),
      })
      .eq("id", args.messageId)
      .eq("media_url", args.mediaRef!);
    if (rowError) {
      console.warn(JSON.stringify({ scope: "chat_media", step: "row", message_id: args.messageId, error: rowError.message }));
      return "upload_failed";
    }
    return "saved";
  } catch (error) {
    console.warn(
      JSON.stringify({
        scope: "chat_media",
        step: "download",
        message_id: args.messageId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return "download_failed";
  }
}

async function readMetadata(supabase: SupabaseClient, messageId: string): Promise<MediaMetadata> {
  const { data } = await supabase.from("messages").select("metadata").eq("id", messageId).maybeSingle();
  const value = (data as { metadata?: unknown } | null)?.metadata;
  return value && typeof value === "object" ? { ...(value as MediaMetadata) } : {};
}

function withoutRetryMarks(metadata: MediaMetadata): MediaMetadata {
  const { media_save_attempts: _a, media_save_gave_up: _g, ...rest } = metadata;
  return rest;
}

/**
 * The bytes of an inbound file from our stored copy. Null when the row isn't
 * on chat-media or the object can't be read.
 */
export async function readStoredMedia(
  supabase: SupabaseClient,
  ref: string | null | undefined,
  maxBytes = CHAT_MEDIA_MAX_BYTES,
): Promise<{ bytes: Uint8Array; mime: string | null } | null> {
  const path = chatMediaPath(ref);
  if (!path) return null;
  try {
    const { data, error } = await supabase.storage.from(CHAT_MEDIA_BUCKET).download(path);
    if (error || !data) return null;
    const buffer = await data.arrayBuffer();
    if (buffer.byteLength > maxBytes) return null;
    return { bytes: new Uint8Array(buffer), mime: data.type || null };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ the sweep

/** Rows the rescue tries per run, and how long it may keep starting downloads. */
export const RESCUE_BATCH = 10;
export const RESCUE_BUDGET_MS = 20_000;
/** Left to the webhook's own pass this long. */
export const RESCUE_AFTER_MS = 5 * 60_000;
/** Meta refusals (or no connected number) before a row stops being retried. */
export const MAX_SAVE_ATTEMPTS = 10;
export const EXPIRE_BATCH = 100;

export type MediaSweepCounts = {
  media_saved: number;
  media_save_failed: number;
  media_too_large: number;
  media_expired: number;
};

type PendingRow = {
  id: string;
  organization_id: string;
  conversation_id: string | null;
  media_url: string;
  media_mime: string | null;
  metadata: MediaMetadata | null;
};

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The maintenance part of Batch 32, run by the billing sweep (every 30 min):
 * inbound files still on "meta:<id>" younger than 7 days are saved as on
 * arrival (newest first — they are the ones Meta still has), and older ones
 * are marked metadata.media_expired so the inbox says the file expired
 * instead of showing a grey box. Bounded per run; never throws.
 */
export async function runChatMediaSweep(
  supabase: SupabaseClient,
  options: { now?: number; budgetMs?: number } = {},
): Promise<MediaSweepCounts> {
  const now = options.now ?? Date.now();
  const counts: MediaSweepCounts = { media_saved: 0, media_save_failed: 0, media_too_large: 0, media_expired: 0 };
  try {
    await rescuePending(supabase, now, options.budgetMs ?? RESCUE_BUDGET_MS, counts);
  } catch (error) {
    console.warn(JSON.stringify({ scope: "chat_media_sweep", step: "rescue", error: error instanceof Error ? error.message : String(error) }));
  }
  try {
    counts.media_expired = await markExpired(supabase, now);
  } catch (error) {
    console.warn(JSON.stringify({ scope: "chat_media_sweep", step: "expire", error: error instanceof Error ? error.message : String(error) }));
  }
  return counts;
}

async function rescuePending(supabase: SupabaseClient, now: number, budgetMs: number, counts: MediaSweepCounts): Promise<void> {
  const { data, error } = await supabase
    .from("messages")
    .select("id, organization_id, conversation_id, media_url, media_mime, metadata")
    .eq("direction", "inbound")
    .like("media_url", "meta:%")
    .gte("created_at", iso(now - META_MEDIA_TTL_MS))
    .lt("created_at", iso(now - RESCUE_AFTER_MS))
    .is("metadata->>media_too_large", null)
    .is("metadata->>media_save_gave_up", null)
    .is("metadata->>media_expired", null)
    .order("created_at", { ascending: false })
    .limit(RESCUE_BATCH);
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as PendingRow[]).filter((r) => r.conversation_id);
  if (!rows.length) return;

  // Which number each conversation came in on, for its token.
  const { data: convs } = await supabase
    .from("conversations")
    .select("id, whatsapp_account_id")
    .in("id", [...new Set(rows.map((r) => r.conversation_id!))]);
  const accountOf = new Map(
    ((convs ?? []) as Array<{ id: string; whatsapp_account_id: string | null }>).map((c) => [c.id, c.whatsapp_account_id]),
  );
  const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
  const tokens = new Map<string, Promise<string>>();
  const tokenFor = (orgId: string, accountId: string | null) => {
    const key = `${orgId}:${accountId ?? ""}`;
    if (!tokens.has(key)) {
      tokens.set(
        key,
        getWhatsAppConnection(supabase, orgId, accountId).then(
          (r) => r.connection?.accessToken ?? "",
          () => "",
        ),
      );
    }
    return tokens.get(key)!;
  };

  const started = Date.now();
  for (const row of rows) {
    if (Date.now() - started > budgetMs) break;
    const metadata = { ...(row.metadata ?? {}) };
    const accessToken = await tokenFor(row.organization_id, accountOf.get(row.conversation_id!) ?? null);
    const outcome = accessToken
      ? await saveInboundMedia(supabase, {
          messageId: row.id,
          organizationId: row.organization_id,
          conversationId: row.conversation_id!,
          mediaRef: row.media_url,
          mime: row.media_mime,
          accessToken,
          metadata,
        })
      : "download_failed";
    if (outcome === "saved") counts.media_saved += 1;
    else if (outcome === "too_large") counts.media_too_large += 1;
    else {
      counts.media_save_failed += 1;
      // Only Meta refusing (or no connected number) counts towards giving
      // up; our own storage failing (e.g. the bucket not created yet) never does.
      if (outcome === "download_failed") {
        const attempts = Number(metadata["media_save_attempts"] ?? 0) + 1;
        await supabase
          .from("messages")
          .update({
            metadata: { ...metadata, media_save_attempts: attempts, ...(attempts >= MAX_SAVE_ATTEMPTS ? { media_save_gave_up: true } : {}) },
          })
          .eq("id", row.id)
          .eq("media_url", row.media_url);
      }
    }
  }
}

async function markExpired(supabase: SupabaseClient, now: number): Promise<number> {
  const { data, error } = await supabase
    .from("messages")
    .select("id, media_url, metadata")
    .eq("direction", "inbound")
    .like("media_url", "meta:%")
    .lt("created_at", iso(now - META_MEDIA_TTL_MS))
    .is("metadata->>media_expired", null)
    .order("created_at", { ascending: false })
    .limit(EXPIRE_BATCH);
  if (error) throw new Error(error.message);
  let marked = 0;
  for (const row of (data ?? []) as Array<{ id: string; media_url: string; metadata: MediaMetadata | null }>) {
    const { error: writeError } = await supabase
      .from("messages")
      .update({ metadata: { ...(row.metadata ?? {}), media_expired: true } })
      .eq("id", row.id)
      .eq("media_url", row.media_url);
    if (!writeError) marked += 1;
  }
  return marked;
}
