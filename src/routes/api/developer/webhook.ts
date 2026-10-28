import { createFileRoute } from "@tanstack/react-router";

/**
 * Settings → API & webhooks: the workspace's webhooks.
 * GET: their addresses and events, the latest deliveries (never a secret).
 * POST: add one (its signing secret is in that one answer), change one,
 * rotate a secret (the new one shown once), remove one, or send a test event
 * now. Needs public_api.manage; all but remove need the flag on.
 *
 * Batch 38: up to 5 webhooks (public-api-webhook-endpoints.server.ts), the
 * same operations the API's /api/v1/webhooks makes. Before 20261160 is
 * applied this is Batch 34's one webhook, exactly as before.
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
        const { loadEndpoints, publicWebhook, MAX_WEBHOOKS } =
          await import("@/lib/public-api-webhook-endpoints.server");
        const hooks = await loadEndpoints(auth.supabase, auth.organizationId);
        const list = hooks.mode === "error" ? [] : hooks.endpoints;
        const endpoint = list[0] ?? null;
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
          mode: hooks.mode,
          limit: hooks.mode === "multi" ? MAX_WEBHOOKS : 1,
          webhooks: list.map(publicWebhook),
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

        // Batch 38: several webhooks, once 20261160 is applied.
        const endpoints = await import("@/lib/public-api-webhook-endpoints.server");
        const all = await endpoints.loadEndpoints(supabase, organizationId);
        if (all.mode === "error")
          return jsonError("We couldn't read your webhooks. Please try again.", 503);
        if (all.mode === "multi") {
          if (action !== "remove" && !(await publicApiEnabled(supabase, organizationId)))
            return jsonError("The Public API isn't switched on for this workspace.", 403);
          const actor = { organizationId, userId, apiKeyId: null };
          // Without an id, Batch 34's Settings meant the one webhook: the first.
          const id = String(p["webhook_id"] ?? "") || all.endpoints[0]?.id || "";
          const answer = async () => {
            if (action === "create" || (action === "save" && !all.endpoints.length))
              return endpoints.createWebhook(supabase, actor, {
                url: p["url"],
                events: p["events"],
              });
            if (action === "save" || action === "update")
              return endpoints.updateWebhook(supabase, actor, id, {
                ...(p["url"] !== undefined ? { url: p["url"] } : {}),
                ...(p["events"] !== undefined ? { events: p["events"] } : {}),
                ...(p["status"] !== undefined ? { status: p["status"] } : {}),
              });
            if (action === "rotate")
              return endpoints.updateWebhook(supabase, actor, id, { rotate_secret: true });
            if (action === "remove") return endpoints.deleteWebhook(supabase, actor, id);
            if (action === "test") {
              const tested = await endpoints.testWebhook(supabase, actor, id);
              if (tested.status !== 200) return tested;
              const b = tested.body;
              return {
                status: 200,
                body: {
                  ok: true,
                  result: { ok: b["delivered"], status: b["response_status"], error: b["error"] },
                },
              };
            }
            return { status: 400, body: { error: "Unknown action." } };
          };
          const reply = await answer();
          if (reply.status >= 300)
            return jsonError(String(reply.body["error"] ?? "Something went wrong."), reply.status);
          const w = reply.body["webhook"] as Record<string, unknown> | undefined;
          return Response.json({ ok: true, ...reply.body, ...(w ? { url: w["url"] } : {}) });
        }

        if (action === "remove") {
          await deleteConnection(supabase, organizationId, "api_webhook");
          hooks.forgetApiEventsWanted(organizationId);
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
          // Batch 37: this instance queues the new events at once (others within a minute).
          hooks.forgetApiEventsWanted(organizationId);
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
