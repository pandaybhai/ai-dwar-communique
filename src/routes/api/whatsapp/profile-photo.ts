import { createFileRoute } from "@tanstack/react-router";

/**
 * Batch 35: a number's WhatsApp profile photo. The browser crops it square
 * (640 × 640); here it goes to Meta through the Resumable Upload API and is
 * set by its handle. JPG or PNG, 5 MB at most. Owners and admins.
 */
export const Route = createFileRoute("/api/whatsapp/profile-photo")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireOrgMember, requirePermission, isResponse, jsonError } =
          await import("@/lib/whatsapp-api.server");

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
        const denied = await requirePermission(
          auth,
          "settings.manage",
          "change the WhatsApp profile",
        );
        if (denied) return denied;

        const file = form.get("file");
        if (!(file instanceof File)) return jsonError("Choose a picture first.");

        const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
        const { connection, error } = await getWhatsAppConnection(
          auth.supabase,
          auth.organizationId,
          (form.get("whatsapp_account_id") as string | null) || null,
        );
        if (!connection) return jsonError(error ?? "Connect a number first.", 400);

        const { updateProfilePhoto } = await import("@/lib/whatsapp-profile.server");
        const answer = await updateProfilePhoto(
          auth.supabase,
          { organizationId: auth.organizationId, userId: auth.userId },
          connection,
          {
            bytes: new Uint8Array(await file.arrayBuffer()),
            mime: file.type,
            fileName: file.name || "profile.jpg",
          },
        );
        if (!answer.ok) return jsonError(answer.error, answer.status);
        return Response.json(answer.data);
      },
    },
  },
});
