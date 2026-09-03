import { createFileRoute } from "@tanstack/react-router";

/**
 * A merchant's own invoices and auto-pay mandate. Everything here is scoped by
 * requireOrgMember and re-checked inside the billing functions.
 */
export const Route = createFileRoute("/api/billing/invoices")({
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

        try {
          const { getAutoPay } = await import("@/lib/subscriptions.server");
          const [{ data: invoices }, autopay] = await Promise.all([
            auth.supabase
              .from("invoices")
              .select(
                "id, invoice_number, kind, purpose, status, issue_date, due_date, period_start, period_end, total, amount_paid, currency, pdf_path, roi_snapshot",
              )
              .eq("organization_id", auth.organizationId)
              .neq("status", "draft")
              .order("issue_date", { ascending: false })
              .limit(60),
            getAutoPay(auth.supabase, auth.organizationId),
          ]);
          return Response.json({ invoices: invoices ?? [], autopay });
        } catch (error) {
          return billingError(error);
        }
      },

      POST: async ({ request }) => {
        const { requireOrgMember, isResponse, jsonError } = await import(
          "@/lib/whatsapp-api.server"
        );

        let payload: Record<string, unknown>;
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          return jsonError("Invalid request.");
        }

        const auth = await requireOrgMember(request, (payload["organization_id"] as string) ?? null);
        if (isResponse(auth)) return auth;

        const { billingGate, billingError } = await import("@/lib/billing-route.server");
        const gate = await billingGate(auth.supabase, auth.organizationId);
        if (gate) return gate;

        const action = String(payload["action"] ?? "");

        try {
          if (action === "download") {
            const invoiceId = String(payload["invoice_id"] ?? "");
            const { data: invoice } = await auth.supabase
              .from("invoices")
              .select("id, pdf_path, organization_id")
              .eq("id", invoiceId)
              .eq("organization_id", auth.organizationId)
              .maybeSingle();
            if (!invoice) return jsonError("We couldn't find that invoice.", 404);

            const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
            const service = getServiceClient();
            let path = (invoice["pdf_path"] as string | null) ?? null;
            if (!path) {
              const { ensureInvoicePdf } = await import("@/lib/invoices.server");
              path = await ensureInvoicePdf(service, invoiceId);
            }
            if (!path) {
              return jsonError(
                "The PDF isn't ready yet. Try again in a moment, or ask us and we'll send it over.",
              );
            }
            const { invoiceDownloadUrl } = await import("@/lib/invoices.server");
            const url = await invoiceDownloadUrl(service, path);
            if (!url) return jsonError("We couldn't open that invoice. Please try again.");
            return Response.json({ url });
          }

          if (action === "autopay_setup") {
            const { setupAutoPay } = await import("@/lib/subscriptions.server");
            const result = await setupAutoPay(auth.supabase, {
              organizationId: auth.organizationId,
              userId: auth.userId,
              cycle: payload["cycle"] === "annual" ? "annual" : "monthly",
            });
            if ("error" in result) return jsonError(result.error);
            return Response.json(result);
          }

          if (action === "autopay_cancel") {
            const { cancelAutoPay } = await import("@/lib/subscriptions.server");
            const result = await cancelAutoPay(auth.supabase, {
              organizationId: auth.organizationId,
              userId: auth.userId,
            });
            if ("error" in result) return jsonError(result.error);
            return Response.json(result);
          }

          return jsonError("Unknown action.");
        } catch (error) {
          return billingError(error);
        }
      },
    },
  },
});
