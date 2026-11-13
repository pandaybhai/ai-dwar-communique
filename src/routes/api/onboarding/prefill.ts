import { createFileRoute } from "@tanstack/react-router";

/**
 * Batch 78: GET — what the post-sign-up business step can prefill for the
 * signed-in person: { business_name } from their own linked /start lead, or
 * null. Reads only; the name stays editable and nothing is saved here.
 */
export const Route = createFileRoute("/api/onboarding/prefill")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { requireSignedIn, isResponse } = await import("@/lib/whatsapp-api.server");
        const auth = await requireSignedIn(request);
        if (isResponse(auth)) return auth;
        const { leadBusinessNameFor } = await import("@/lib/lead-prefill.server");
        const business_name = await leadBusinessNameFor(auth.supabase, auth.userId);
        return Response.json({ business_name });
      },
      POST: async () => Response.json({ error: "Not allowed." }, { status: 405 }),
    },
  },
});
