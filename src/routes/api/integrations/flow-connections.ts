import { createFileRoute } from "@tanstack/react-router";

/**
 * Workspace-facing controls for the merchant's own Google and Razorpay accounts
 * used by Flows v2 steps. Secrets are write-only: saved to Vault, never returned.
 */
export const Route = createFileRoute("/api/integrations/flow-connections")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { requireOrgMember, isResponse } = await import("@/lib/whatsapp-api.server");
        const url = new URL(request.url);
        const auth = await requireOrgMember(request, url.searchParams.get("organization_id"));
        if (isResponse(auth)) return auth;
        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const { googleOAuthConfigured } = await import("@/lib/flow-connections.server");
        const { data } = await getServiceClient()
          .from("workspace_connections")
          .select("provider, account_label, status, last_error, public_config, updated_at")
          .eq("organization_id", auth.organizationId);
        const rows = (data ?? []) as Array<{ provider: string; account_label: string | null; status: string; last_error: string | null; public_config: Record<string, unknown>; updated_at: string }>;
        const pick = (p: string) => rows.find((r) => r.provider === p) ?? null;
        return Response.json({
          google_available: googleOAuthConfigured(),
          google: pick("google"),
          razorpay: pick("razorpay"),
          razorpay_webhook_url: `${url.origin}/api/public/razorpay-flow-webhook/${auth.organizationId}`,
        });
      },

      POST: async ({ request }) => {
        const { requireOrgMember, requirePermission, isResponse, jsonError, logServerActivity } = await import("@/lib/whatsapp-api.server");
        let p: Record<string, unknown> = {};
        try {
          p = (await request.json()) as Record<string, unknown>;
        } catch {
          p = {};
        }
        const auth = await requireOrgMember(request, (p["organization_id"] as string) ?? null);
        if (isResponse(auth)) return auth;
        const denied = await requirePermission(auth, "integrations.manage", "manage integrations");
        if (denied) return denied;
        const { organizationId, userId } = auth;
        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const svc = getServiceClient();
        const lib = await import("@/lib/flow-connections.server");
        const action = String(p["action"] ?? "");
        const origin = new URL(request.url).origin;

        if (action === "google_start") {
          if (!lib.googleOAuthConfigured()) return jsonError("Google connection isn't switched on yet.", 409);
          // Bound to this signed-in user's browser: the callback needs the cookie too.
          const { newBinding, bindingCookie } = await import("@/lib/oauth-binding.server");
          const bind = newBinding();
          const state = lib.signState({ org: organizationId, user: userId ?? "", bind });
          return Response.json({ url: lib.googleAuthUrl(origin, state) }, { headers: { "Set-Cookie": bindingCookie("google", bind) } });
        }

        if (action === "razorpay_save") {
          const keyId = String(p["key_id"] ?? "").trim();
          const keySecret = String(p["key_secret"] ?? "").trim();
          const webhookSecret = String(p["webhook_secret"] ?? "").trim();
          if (!/^rzp_(live|test)_[A-Za-z0-9]+$/.test(keyId)) return jsonError("The Key ID should start with rzp_live_ or rzp_test_.", 400);
          if (keySecret.length < 10) return jsonError("Paste the full Key Secret.", 400);
          if (webhookSecret.length < 8) return jsonError("Add the webhook secret you set in Razorpay (8+ characters).", 400);
          if (!(await lib.verifyRazorpayKeys(keyId, keySecret))) return jsonError("Razorpay didn't accept these keys. Check the Key ID and Secret.", 400);
          const mode = keyId.startsWith("rzp_live_") ? "live" : "test";
          const { error } = await lib.saveConnection(svc, {
            organizationId,
            provider: "razorpay",
            label: `${keyId.slice(0, 14)}…`,
            config: { mode },
            secret: { key_id: keyId, key_secret: keySecret, webhook_secret: webhookSecret },
            userId,
          });
          if (error) return jsonError(error, 500);
          await logServerActivity(svc, organizationId, userId, "flow_connection_added", { provider: "razorpay", mode });
          return Response.json({ ok: true });
        }

        if (action === "disconnect") {
          const provider = p["provider"] === "google" ? "google" : p["provider"] === "razorpay" ? "razorpay" : null;
          if (!provider) return jsonError("Unknown connection.", 400);
          await lib.deleteConnection(svc, organizationId, provider);
          await logServerActivity(svc, organizationId, userId, "flow_connection_removed", { provider });
          return Response.json({ ok: true });
        }
        return jsonError("Unknown action.", 400);
      },
    },
  },
});
