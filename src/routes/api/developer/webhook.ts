import { createFileRoute } from "@tanstack/react-router";

/**
 * Settings → API & webhooks: the workspace's one webhook (Batch 34).
 * GET: its address, the latest deliveries (never the secret). POST: save an
 * address (a new webhook gets a signing secret, shown in this one answer),
 * rotate the secret (the new one shown once), remove it, or send a test
 * event now. Needs public_api.manage; all but remove need the flag on.
 */
export const Route = createFileRoute("/api/developer/webhook")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { requireOrgMember, requirePermission, isResponse } =
          await import("@/lib/whatsapp-api.server");
        const url = new URL(request.url);
        const auth = await requireOrgMember(request, url.searchParams.get("organization_id"));
        if (isResponse(auth)) return auth;
        const denied = await requirePermission(auth, "public_api.manage", "manage the API webhook");
        if (denied) return denied;
        const { loadWebhookEndpoint } = await import("@/lib/public-api-webhooks.server");
        const endpoint = await loadWebhookEndpoint(auth.supabase, auth.organizationId);
        const { data } = await auth.supabase
          .from("api_webhook_deliveries")
          .select(
            "id, event, state, attempts, last_status, last_error, last_attempt_at, delivered_at, created_at, next_attempt_at",
          )
          .eq("organization_id", auth.organizationId)
          .order("created_at", { ascending: false })
          .limit(10);
        const recent = (data ?? []) as Array<Record<string, unknown>>;
        return Response.json({
          url: endpoint?.url ?? null,
          status: endpoint?.status ?? null,
          last_delivery:
            recent.find((d) => d["state"] !== "pending" || d["last_attempt_at"]) ?? null,
          recent,
        });
      },

      POST: async ({ request }) => {
        const { requireOrgMember, requirePermission, isResponse, jsonError, logServerActivity } =
          await import("@/lib/whatsapp-api.server");
        let p: Record<string, unknown> = {};
        try {
          p = (await request.json()) as Record<string, unknown>;
        } catch {
          return jsonError("Invalid request.");
        }
        const auth = await requireOrgMember(request, (p["organization_id"] as string) ?? null);
        if (isResponse(auth)) return auth;
        const denied = await requirePermission(auth, "public_api.manage", "manage the API webhook");
        if (denied) return denied;
        const { supabase, organizationId, userId } = auth;
        const hooks = await import("@/lib/public-api-webhooks.server");
        const { publicApiEnabled } = await import("@/lib/public-api.server");
        const { saveConnection, deleteConnection } = await import("@/lib/flow-connections.server");
        const action = String(p["action"] ?? "");

        if (action === "remove") {
          await deleteConnection(supabase, organizationId, "api_webhook");
          await logServerActivity(supabase, organizationId, userId, "api_webhook_removed", {});
          return Response.json({ ok: true });
        }

        if (!(await publicApiEnabled(supabase, organizationId))) {
          return jsonError("The Public API isn't switched on for this workspace.", 403);
        }
        const existing = await hooks.loadWebhookEndpoint(supabase, organizationId);

        if (action === "save" || action === "rotate") {
          const address = action === "save" ? String(p["url"] ?? "").trim() : (existing?.url ?? "");
          if (!address) return jsonError("Set a webhook address first.");
          if (action === "save") {
            const problem = await hooks.webhookUrlProblem(address);
            if (problem) return jsonError(problem);
          }
          // A new webhook, or a rotation, gets a new secret; changing the address keeps it.
          const fresh = action === "rotate" || !existing;
          const secret = fresh ? hooks.newSigningSecret() : existing.secret;
          const saved = await saveConnection(supabase, {
            organizationId,
            provider: "api_webhook",
            label: new URL(address).host,
            config: { url: address },
            secret: { signing_secret: secret },
            userId,
          });
          if (saved.error) return jsonError(saved.error, 503);
          await logServerActivity(
            supabase,
            organizationId,
            userId,
            action === "rotate" ? "api_webhook_secret_rotated" : "api_webhook_saved",
            { host: new URL(address).host },
          );
          // The only time the secret leaves the server.
          return Response.json({ ok: true, url: address, ...(fresh ? { secret } : {}) });
        }

        if (action === "test") {
          const sent = await hooks.sendTestEvent(supabase, organizationId);
          if (!sent.ok) return jsonError(sent.error);
          await logServerActivity(supabase, organizationId, userId, "api_webhook_test_sent", {
            ok: sent.result.ok,
            status: sent.result.status,
          });
          return Response.json({ ok: true, result: sent.result });
        }

        return jsonError("Unknown action.");
      },
    },
  },
});
