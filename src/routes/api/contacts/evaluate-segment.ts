import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/contacts/evaluate-segment")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireOrgMember, isResponse, jsonError, requirePermission } = await import(
          "@/lib/whatsapp-api.server"
        );
        const { evaluateSegment, resolveSegmentContactIds } = await import(
          "@/lib/segments.server"
        );

        let payload: Record<string, unknown>;
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          return jsonError("Invalid request.");
        }

        const auth = await requireOrgMember(request, (payload["organization_id"] as string) ?? null);
        if (isResponse(auth)) return auth;
        // Who matches a segment is contact data.
        const denied = await requirePermission(auth, "contacts.view", "preview this segment");
        if (denied) return denied;

        try {
          if (payload["mode"] === "ids") {
            const ids = await resolveSegmentContactIds(
              auth.supabase,
              auth.organizationId,
              payload["filters"],
            );
            return Response.json({ ids });
          }
          const result = await evaluateSegment(
            auth.supabase,
            auth.organizationId,
            payload["filters"],
          );
          return Response.json(result);
        } catch {
          return jsonError("We couldn't evaluate this segment. Please try again.", 500);
        }
      },
    },
  },
});
