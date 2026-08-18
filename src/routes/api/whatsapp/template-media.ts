import { createFileRoute } from "@tanstack/react-router";

/**
 * Uploading a header picture, video or document for a template.
 *
 * Meta needs the same file twice, in two different forms:
 *
 *   1. a one-time upload "handle", to attach to the template it reviews, and
 *   2. a reachable URL (or media id) on every single send afterwards.
 *
 * The handle can't be reused for sending and the send-time link can't be used
 * for review, so we keep our own copy of the file in storage and remember both.
 */

const MAX_BYTES: Record<string, number> = {
  IMAGE: 5 * 1024 * 1024,
  VIDEO: 16 * 1024 * 1024,
  DOCUMENT: 16 * 1024 * 1024,
};

const ALLOWED: Record<string, string[]> = {
  IMAGE: ["image/jpeg", "image/png"],
  VIDEO: ["video/mp4", "video/3gpp"],
  DOCUMENT: ["application/pdf"],
};

function formatForMime(mime: string): "IMAGE" | "VIDEO" | "DOCUMENT" | null {
  for (const [format, list] of Object.entries(ALLOWED)) {
    if (list.includes(mime)) return format as "IMAGE" | "VIDEO" | "DOCUMENT";
  }
  return null;
}

function friendlySize(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

export const Route = createFileRoute("/api/whatsapp/template-media")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const {
          requireOrgMember,
          requirePermission,
          isResponse,
          jsonError,
          GRAPH_VERSION,
        } = await import("@/lib/whatsapp-api.server");

        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return jsonError("We couldn't read that upload. Try again.");
        }

        const organizationId = (form.get("organization_id") as string | null) ?? null;
        const auth = await requireOrgMember(request, organizationId);
        if (isResponse(auth)) return auth;
        const denied = await requirePermission(auth, "templates.manage", "manage message templates");
        if (denied) return denied;
        const { supabase, userId } = auth;

        const file = form.get("file");
        if (!(file instanceof File)) return jsonError("Choose a file to upload.");

        const slot = String(form.get("slot") ?? "header");
        if (!/^(header|card:[0-9])$/.test(slot)) return jsonError("Unknown upload slot.");

        const mime = file.type || "application/octet-stream";
        const format = formatForMime(mime);
        if (!format) {
          return jsonError(
            "That file type isn't supported. Use a JPG or PNG image, an MP4 video, or a PDF.",
          );
        }
        const limit = MAX_BYTES[format] as number;
        if (file.size > limit) {
          return jsonError(
            `That ${format.toLowerCase()} is ${friendlySize(file.size)}. The most Meta accepts is ${friendlySize(limit)}.`,
          );
        }
        if (file.size === 0) return jsonError("That file is empty.");

        const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
        const { connection, error: connectionError } = await getWhatsAppConnection(
          supabase,
          auth.organizationId,
          (form.get("whatsapp_account_id") as string | null) || null,
        );
        if (!connection) return jsonError(connectionError ?? "No connected number.", 400);

        const bytes = new Uint8Array(await file.arrayBuffer());

        // ---- 1. our own copy, which is what every send uses ----
        const extension = (file.name.split(".").pop() ?? "bin").toLowerCase().slice(0, 8);
        const path = `${auth.organizationId}/${crypto.randomUUID()}.${extension}`;
        const { error: uploadError } = await supabase.storage
          .from("template-media")
          .upload(path, bytes, { contentType: mime, upsert: false });
        if (uploadError) {
          return jsonError("We couldn't save that file. Try again in a moment.", 500);
        }
        const { data: publicUrl } = supabase.storage.from("template-media").getPublicUrl(path);
        const mediaUrl = publicUrl.publicUrl;

        // ---- 2. Meta's upload handle, for the template review ----
        const appId = process.env["META_APP_ID"];
        if (!appId) {
          return jsonError(
            "Media headers aren't configured on this workspace yet. Contact support and we'll switch them on.",
            500,
          );
        }

        const sessionRes = await fetch(
          `https://graph.facebook.com/${GRAPH_VERSION}/${appId}/uploads?` +
            new URLSearchParams({
              file_length: String(file.size),
              file_type: mime,
              file_name: file.name.slice(0, 120),
            }),
          { method: "POST", headers: { Authorization: `Bearer ${connection.accessToken}` } },
        );
        const sessionBody = (await sessionRes.json().catch(() => ({}))) as Record<string, unknown>;
        const sessionId = sessionBody["id"] as string | undefined;
        if (!sessionRes.ok || !sessionId) {
          const { graphErrorMessage } = await import("@/lib/whatsapp-api.server");
          await supabase.storage.from("template-media").remove([path]);
          return jsonError(`Meta wouldn't accept the file: ${graphErrorMessage(sessionBody)}`, 400);
        }

        const uploadRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${sessionId}`, {
          method: "POST",
          headers: {
            // Resumable uploads use Meta's own scheme, not a bearer token.
            Authorization: `OA ${connection.accessToken}`,
            file_offset: "0",
            "content-type": "application/octet-stream",
          },
          body: bytes,
        });
        const uploadBody = (await uploadRes.json().catch(() => ({}))) as Record<string, unknown>;
        const handle = uploadBody["h"] as string | undefined;
        if (!uploadRes.ok || !handle) {
          const { graphErrorMessage } = await import("@/lib/whatsapp-api.server");
          await supabase.storage.from("template-media").remove([path]);
          return jsonError(`Meta wouldn't accept the file: ${graphErrorMessage(uploadBody)}`, 400);
        }

        const { data: asset } = await supabase
          .from("template_media_assets")
          .insert({
            organization_id: auth.organizationId,
            slot,
            format,
            storage_path: path,
            media_url: mediaUrl,
            mime_type: mime,
            file_name: file.name.slice(0, 200),
            byte_size: file.size,
            meta_handle: handle,
            created_by: userId,
          })
          .select("id")
          .single();

        return Response.json({
          id: asset?.id ?? null,
          format,
          handle,
          media_url: mediaUrl,
          file_name: file.name,
          byte_size: file.size,
        });
      },
    },
  },
});
