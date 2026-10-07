import { createFileRoute } from "@tanstack/react-router";

/** Google sends the merchant back here after consent. State is HMAC-signed. */
export const Route = createFileRoute("/api/public/google-oauth-callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const back = (q: string) => Response.redirect(`${url.origin}/app/settings?google=${q}`, 302);
        const lib = await import("@/lib/flow-connections.server");
        const state = lib.readState(url.searchParams.get("state") ?? "");
        const code = url.searchParams.get("code");
        if (!state || !code || !lib.googleOAuthConfigured()) return back("failed");
        // Only in the browser of the signed-in user who started it.
        const { bindingFrom, sameBinding } = await import("@/lib/oauth-binding.server");
        if (!state["user"] || !sameBinding(state["bind"], bindingFrom(request, "google"))) return back("failed");
        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const svc = getServiceClient();
        // That user must still be allowed to manage integrations in the workspace.
        const { hasPermission } = await import("@/lib/permissions.server");
        if (!(await hasPermission(svc, state["org"]!, state["user"]!, "integrations.manage"))) return back("failed");
        const result = await lib.exchangeGoogleCode(url.origin, code);
        if ("error" in result) return back("failed");
        const { error } = await lib.saveConnection(svc, {
          organizationId: state["org"]!,
          provider: "google",
          label: result.email,
          config: {},
          secret: { refresh_token: result.refreshToken },
          userId: state["user"]!,
        });
        if (error) return back("failed");
        const { logServerActivity } = await import("@/lib/whatsapp-api.server");
        await logServerActivity(svc, state["org"]!, state["user"]!, "flow_connection_added", { provider: "google" });
        return back("connected");
      },
    },
  },
});
