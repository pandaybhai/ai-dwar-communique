import { createFileRoute } from "@tanstack/react-router";

/**
 * Product picture upload for manually added products — and pictures on flow
 * steps (purpose=flow). Paths are org-scoped and random; the bucket is
 * public-read because these images end up inside WhatsApp messages, which Meta
 * fetches with no credentials.
 */

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = ["image/jpeg", "image/png", "image/webp"];

export const Route = createFileRoute("/api/catalog/image")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireOrgMember, requirePermission, isResponse, jsonError } = await import(
          "@/lib/whatsapp-api.server"
        );

        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return jsonError("We couldn't read that upload. Try again.");
        }

        const auth = await requireOrgMember(
          request,
          (form.get("organization_id") as string | null) ?? null,
        );
        if (isResponse(auth)) return auth;
        // A flow step's picture is sent as a WhatsApp image: JPEG or PNG only.
        const forFlow = form.get("purpose") === "flow";
        const denied = forFlow
          ? await requirePermission(auth, "flows_v2.edit", "edit flows")
          : await requirePermission(auth, "catalog.manage", "manage the catalogue");
        if (denied) return denied;

        const file = form.get("file");
        if (!(file instanceof File)) return jsonError("Choose an image to upload.");
        if (file.size === 0) return jsonError("That file is empty.");
        if (forFlow) {
          const { IMAGE_MAX_BYTES, IMAGE_TYPES } = await import("@/lib/flow-graph");
          if (file.size > IMAGE_MAX_BYTES) return jsonError("WhatsApp pictures must be under 5 MB.");
          if (!IMAGE_TYPES.includes(file.type)) return jsonError("WhatsApp pictures must be JPG or PNG.");
        }
        if (file.size > MAX_BYTES) return jsonError("Product images must be under 5 MB.");
        const mime = file.type || "application/octet-stream";
        if (!ALLOWED.includes(mime)) return jsonError("Use a JPG, PNG or WebP image.");

        const extension = (file.name.split(".").pop() ?? "jpg").toLowerCase().slice(0, 8);
        const path = `${auth.organizationId}/${crypto.randomUUID()}.${extension}`;
        const bytes = new Uint8Array(await file.arrayBuffer());
        const { error } = await auth.supabase.storage
          .from("product-images")
          .upload(path, bytes, { contentType: mime, upsert: false });
        if (error) return jsonError(`We couldn't save that image: ${error.message}`, 500);

        const { data } = auth.supabase.storage.from("product-images").getPublicUrl(path);
        return Response.json({ url: data.publicUrl });
      },
    },
  },
});
