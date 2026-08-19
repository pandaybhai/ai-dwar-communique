import { createFileRoute } from "@tanstack/react-router";

/**
 * Streams one inbound WhatsApp media file back to the workspace that received
 * it. Meta only gives us an opaque media id, which no browser can fetch, so the
 * inbox asks us for the bytes. Authenticated and organization-scoped on
 * purpose: a customer's photo is private to the workspace they wrote to.
 */
export const Route = createFileRoute("/api/whatsapp/media/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { requireOrgMember, isResponse, jsonError, GRAPH_VERSION } = await import(
          "@/lib/whatsapp-api.server"
        );

        const mediaId = String(params.id ?? "").trim();
        if (!mediaId) return jsonError("Media id is required.");

        const url = new URL(request.url);
        const auth = await requireOrgMember(request, url.searchParams.get("organization_id"));
        if (isResponse(auth)) return auth;
        const { supabase, organizationId } = auth;

        // The caller may only read media that arrived in their own workspace.
        const { data: message } = await supabase
          .from("messages")
          .select("id, media_mime, conversation_id")
          .eq("organization_id", organizationId)
          .eq("media_url", `meta:${mediaId}`)
          .limit(1)
          .maybeSingle();
        if (!message) return jsonError("This file isn't available in your workspace.", 404);

        let accountId: string | null = null;
        if (message.conversation_id) {
          const { data: conv } = await supabase
            .from("conversations")
            .select("whatsapp_account_id")
            .eq("id", message.conversation_id as string)
            .eq("organization_id", organizationId)
            .maybeSingle();
          accountId = (conv?.whatsapp_account_id as string | undefined) ?? null;
        }

        const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
        const { connection, error } = await getWhatsAppConnection(
          supabase,
          organizationId,
          accountId,
        );
        if (!connection) {
          return jsonError(error ?? "This number isn't connected, so we can't fetch the file.", 400);
        }

        // Step one: ask Meta where the file lives (the link is short-lived).
        const lookup = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
          headers: { Authorization: `Bearer ${connection.accessToken}` },
        });
        const lookupBody = (await lookup.json().catch(() => ({}))) as Record<string, unknown>;
        const fileUrl = lookupBody["url"] as string | undefined;
        if (!lookup.ok || !fileUrl) {
          return jsonError("We couldn't find this file — it may have expired.", 404);
        }

        // Step two: fetch the bytes. Meta requires the same token here too.
        const fileRes = await fetch(fileUrl, {
          headers: { Authorization: `Bearer ${connection.accessToken}` },
        });
        if (!fileRes.ok || !fileRes.body) {
          return jsonError("We couldn't download this file. Please try again.", 502);
        }

        const mime =
          (lookupBody["mime_type"] as string | undefined) ??
          (message.media_mime as string | null) ??
          fileRes.headers.get("content-type") ??
          "application/octet-stream";

        return new Response(fileRes.body, {
          status: 200,
          headers: {
            "content-type": mime,
            // Private per user session — never shared caches.
            "cache-control": "private, max-age=300",
          },
        });
      },
    },
  },
});
