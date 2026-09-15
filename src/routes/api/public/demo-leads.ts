import { createFileRoute } from "@tanstack/react-router";

/**
 * Public demo enquiry intake. Write-only on purpose: nobody can list or read
 * leads through this route, and the table itself is unreachable from any
 * client key. All validation, normalisation and rate limiting is server-side.
 */
export const Route = createFileRoute("/api/public/demo-leads")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const { submitLead } = await import("@/lib/leads.server");

        let body: Record<string, unknown>;
        try {
          const raw = await request.text();
          if (raw.length > 8000) {
            return Response.json({ error: "That request was too large." }, { status: 413 });
          }
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return Response.json({ error: "We couldn't read that request." }, { status: 400 });
        }

        const ip =
          request.headers.get("cf-connecting-ip") ??
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          null;

        const result = await submitLead(getServiceClient(), body, {
          ip,
          referrer: request.headers.get("referer"),
        });

        if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
        return Response.json({ ok: true, duplicate: result.duplicate });
      },
    },
  },
});
