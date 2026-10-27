import { createFileRoute } from "@tanstack/react-router";

/**
 * Streams one customer file we keep in the private chat-media bucket (Batch
 * 32: "storage:chat-media/<path>" on messages.media_url) to someone allowed
 * to read that workspace: a member, or a platform super admin. The bytes go
 * through us with mediaResponseHeaders — there is never a public or signed
 * link to a customer's file. Files still on "meta:<id>" use
 * /api/whatsapp/media/$id, as before.
 */
export const Route = createFileRoute("/api/whatsapp/chat-media/$messageId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { requireSignedIn, orgReadAccess, isResponse, jsonError } = await import("@/lib/whatsapp-api.server");
        const { CHAT_MEDIA_BUCKET, chatMediaPath } = await import("@/lib/chat-media.server");

        const messageId = String(params.messageId ?? "").trim();
        if (!messageId) return jsonError("Message id is required.");
        const caller = await requireSignedIn(request);
        if (isResponse(caller)) return caller;

        // The message says which workspace the file belongs to; the caller is
        // then checked against that workspace, never one they name.
        const { data: message } = await caller.supabase
          .from("messages")
          .select("id, organization_id, media_url, media_mime")
          .eq("id", messageId)
          .maybeSingle();
        const row = message as { organization_id?: string; media_url?: string | null; media_mime?: string | null } | null;
        const path = chatMediaPath(row?.media_url);
        // Not found and not yours read the same: no probing for message ids.
        const notHere = () => jsonError("This file isn't available in your workspace.", 404);
        if (!row?.organization_id || !path) return notHere();
        const auth = await orgReadAccess(caller.supabase, caller.userId, row.organization_id);
        if (!auth) return notHere();

        const { data: file, error } = await auth.supabase.storage.from(CHAT_MEDIA_BUCKET).download(path);
        if (error || !file) return jsonError("We couldn't load this file. Please try again.", 502);

        const mime = row.media_mime ?? (file.type || "application/octet-stream");
        const { mediaResponseHeaders } = await import("@/lib/media-serve");
        return new Response(file, { status: 200, headers: mediaResponseHeaders(mime) });
      },
    },
  },
});
