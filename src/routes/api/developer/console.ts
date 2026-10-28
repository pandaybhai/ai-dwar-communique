import { createFileRoute } from "@tanstack/react-router";

/**
 * Settings → API & webhooks → "Try it" (Batch 38 item 7). Owners and admins
 * (public_api.manage) of a workspace with public_api on.
 *
 * POST { action: "quote", template_name, language?, to }
 *   -> what the send would cost at this customer's rate (nothing sent).
 * POST { action: "call", endpoint: "send_template", body }
 * POST { action: "call", endpoint: "message_status", message_id }
 *   -> a REAL call: the request is handed to the very /api/v1 handler an API
 *      key reaches, carrying the console credential (consoleCredential,
 *      public-api-console.server.ts) — minted here for this workspace and
 *      this member, 10 minutes, never shown and never an API key. Answers
 *      with the request as curl (the credential masked) and the handler's
 *      status and body. Rate-limited per member like a key, on top of the
 *      key and workspace limits the handler applies itself.
 */

/** The largest console request: a 16 MB file in base64 and the rest of the send. */
const MAX_CONSOLE_BYTES = 23 * 1024 * 1024 + 64 * 1024;

export const Route = createFileRoute("/api/developer/console")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireOrgMember, requirePermission, isResponse, jsonError } =
          await import("@/lib/whatsapp-api.server");
        const declared = Number(request.headers.get("content-length") ?? NaN);
        if (Number.isFinite(declared) && declared > MAX_CONSOLE_BYTES)
          return jsonError("That file is too large: WhatsApp takes up to 16 MB.", 413);
        let p: Record<string, unknown> = {};
        try {
          p = (await request.json()) as Record<string, unknown>;
        } catch {
          return jsonError("Invalid request.");
        }
        const auth = await requireOrgMember(request, (p["organization_id"] as string) ?? null);
        if (isResponse(auth)) return auth;
        const denied = await requirePermission(auth, "public_api.manage", "use the API console");
        if (denied) return denied;
        const { supabase, organizationId, userId } = auth;
        const { publicApiEnabled } = await import("@/lib/public-api.server");
        if (!(await publicApiEnabled(supabase, organizationId)))
          return jsonError("The Public API isn't switched on for this workspace.", 403);

        const action = String(p["action"] ?? "");
        const lib = await import("@/lib/public-api-console.server");

        if (action === "quote") {
          const quote = await lib.consoleQuote(supabase, {
            organizationId,
            templateName: String(p["template_name"] ?? ""),
            language: typeof p["language"] === "string" ? p["language"] : null,
            to: String(p["to"] ?? ""),
          });
          return Response.json(quote);
        }

        if (action !== "call") return jsonError("Unknown action.");
        const endpoint = String(
          p["endpoint"] ?? "",
        ) as import("@/lib/public-api-console.server").ConsoleEndpoint;
        if (!(endpoint in lib.CONSOLE_ENDPOINTS)) return jsonError("Pick an endpoint to call.");

        const limited = await lib.takeConsoleRate(supabase, { organizationId, userId });
        if (limited)
          return Response.json(limited.body, {
            status: limited.status,
            headers: limited.retryAfter ? { "Retry-After": String(limited.retryAfter) } : {},
          });

        let credential: { token: string; expiresAt: number };
        try {
          credential = await lib.consoleCredential(supabase, { organizationId, userId });
        } catch {
          return jsonError("The API console isn't available yet. Please try again later.", 503);
        }

        const origin = new URL(request.url).origin;
        const spec = lib.CONSOLE_ENDPOINTS[endpoint];
        let path: string = spec.path;
        let body: Record<string, unknown> | undefined;
        let res: Response;
        if (endpoint === "message_status") {
          const { validId } = await import("@/lib/public-api-route.server");
          const messageId = String(p["message_id"] ?? "").trim();
          if (!validId(messageId)) return jsonError("Which message? Give its message_id.");
          path = spec.path.replace("{message_id}", messageId);
          const { Route: StatusRoute } = await import("@/routes/api/v1/messages/$messageId");
          res = await lib.invokeRoute(StatusRoute, "GET", {
            request: new Request(`${origin}${path}`, {
              method: "GET",
              headers: { authorization: `Bearer ${credential.token}` },
            }),
            params: { messageId },
          });
        } else {
          body = lib.consoleSendBody(p["body"]);
          const { Route: SendRoute } = await import("@/routes/api/v1/messages/template");
          res = await lib.invokeRoute(SendRoute, "POST", {
            request: new Request(`${origin}${path}`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${credential.token}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
            }),
            params: {},
          });
        }
        let answer: unknown = null;
        try {
          answer = await res.json();
        } catch {
          answer = null;
        }
        return Response.json({
          request: {
            method: spec.method,
            path,
            curl: lib.consoleCurl({ origin, method: spec.method, path, body }),
          },
          response: { status: res.status, body: answer },
          console_expires_at: new Date(credential.expiresAt).toISOString(),
        });
      },
    },
  },
});
