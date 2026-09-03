import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/billing/ledger")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { requireOrgMember, isResponse } = await import("@/lib/whatsapp-api.server");
        const url = new URL(request.url);
        const auth = await requireOrgMember(request, url.searchParams.get("organization_id"));
        if (isResponse(auth)) return auth;

        const { billingGate, billingError } = await import("@/lib/billing-route.server");
        const gate = await billingGate(auth.supabase, auth.organizationId);
        if (gate) return gate;

        const limit = Number(url.searchParams.get("limit") ?? 50);
        const kind = url.searchParams.get("kind") ?? "ledger";
        try {
          const { listLedger, listBillingDocuments } = await import("@/lib/billing.server");

          // Invoices and payments are the same "show me the paperwork" read,
          // gated by the same permission, so they live on this route too.
          if (kind === "invoices" || kind === "payments") {
            const rows = await listBillingDocuments(
              auth.supabase,
              auth.organizationId,
              { userId: auth.userId },
              kind,
            );
            return Response.json({ entries: rows, next_cursor: null });
          }

          const entries = await listLedger(
            auth.supabase,
            auth.organizationId,
            { userId: auth.userId },
            {
              limit: Number.isFinite(limit) ? limit : 50,
              before: url.searchParams.get("cursor"),
            },
          );
          const last = entries.at(-1) as { created_at?: string } | undefined;
          return Response.json({
            entries,
            next_cursor: entries.length > 0 ? (last?.created_at ?? null) : null,
          });
        } catch (error) {
          return billingError(error);
        }
      },
    },
  },
});

