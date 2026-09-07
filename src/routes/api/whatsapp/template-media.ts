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
        const { requireOrgMember, requirePermission, isResponse, jsonError, GRAPH_VERSION } =
          await import("@/lib/whatsapp-api.server");

        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return jsonError("We couldn't read that upload. Try again.");
        }

        const organizationId = (form.get("organization_id") as string | null) ?? null;
        const auth = await requireOrgMember(request, organizationId);
        if (isResponse(auth)) return auth;
        const denied = await requirePermission(
          auth,
          "templates.manage",
          "manage message templates",
        );
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

        const bytes = new Uint8Array(await file.arrayBuffer());

        const { uploadTemplateMedia } = await import("@/lib/template-media.server");
        const uploaded = await uploadTemplateMedia(supabase, {
          organizationId: auth.organizationId,
          userId,
          bytes,
          mime,
          fileName: file.name,
          format,
          slot,
          whatsappAccountId: (form.get("whatsapp_account_id") as string | null) || null,
        });
        if (!uploaded.ok) return jsonError(uploaded.error, uploaded.status ?? 400);

        return Response.json({
          id: uploaded.id,
          format: uploaded.format,
          handle: uploaded.handle,
          media_url: uploaded.mediaUrl,
          file_name: uploaded.fileName,
          byte_size: uploaded.byteSize,
        });
      },
    },
  },
});
