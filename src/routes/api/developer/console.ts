import { createFileRoute } from "@tanstack/react-router";

/**
 * Settings → API & webhooks → "Try it" (Batch 38 item 7). Owners and admins
 * (public_api.manage) of a workspace with public_api on.
 *
 * POST { action: "quote", template_name, language?, to }
 *   -> what the send would cost at this customer's rate (nothing sent).
 * POST { action: "call", endpoint: "send_template" | "send_session" | "contact_upsert", body }
 * POST { action: "call", endpoint: "message_status", message_id }
 * POST { action: "call", endpoint: "contacts_list" | "templates_list" | "account_balance", query }
 *   -> a REAL call (CONSOLE_ENDPOINTS, public-api-console.ts; the body and
 *      filters passed on are only the endpoint's own spec fields): the request is handed to the very /api/v1 handler an API
 *      key reaches, carrying the console credential (consoleCredential,
 *      public-api-console.server.ts) — minted here for this workspace and
 *      this member, 10 minutes, never shown and never an API key. Answers
 *      with the request as curl (the credential masked) and the handler's
 *      status and body. Rate-limited per member like a key, on top of the
 *      key and workspace limits the handler applies itself.
 */

/** The largest console request: a 16 MB file in base64 and the rest of the send. */
const MAX_CONSOLE_BYTES = 23 * 1024 * 1024 + 64 * 1024;

/** The /api/v1 route each console endpoint calls — the same handler an API key reaches. */
const ROUTE_OF = {
  send_template: () => import("@/routes/api/v1/messages/template"),
  send_session: () => import("@/routes/api/v1/messages/session"),
  message_status: () => import("@/routes/api/v1/messages/$messageId"),
  contact_upsert: () => import("@/routes/api/v1/contacts/index"),
  contacts_list: () => import("@/routes/api/v1/contacts/index"),
  templates_list: () => import("@/routes/api/v1/templates/index"),
  account_balance: () => import("@/routes/api/v1/account/balance"),
} satisfies Record<
  import("@/lib/public-api-console").ConsoleEndpoint,
  () => Promise<{ Route: unknown }>
>;

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
        const { isConsoleEndpoint } = await import("@/lib/public-api-console");
        const endpoint = p["endpoint"];
        if (!isConsoleEndpoint(endpoint)) return jsonError("Pick an endpoint to call.");

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
        const params: Record<string, string> = {};
        if (endpoint === "message_status") {
          const { validId } = await import("@/lib/public-api-route.server");
          const messageId = String(p["message_id"] ?? "").trim();
          if (!validId(messageId)) return jsonError("Which message? Give its message_id.");
          path = spec.path.replace("{message_id}", messageId);
          params["messageId"] = messageId;
        }
        const body = spec.method === "POST" ? lib.consoleBody(endpoint, p["body"]) : undefined;
        if (spec.method === "GET") path += lib.consoleQuery(endpoint, p["query"]);
        const { Route: target } = await ROUTE_OF[endpoint]();
        const res = await lib.invokeRoute(target, spec.method, {
          request: new Request(`${origin}${path}`, {
            method: spec.method,
            headers: {
              authorization: `Bearer ${credential.token}`,
              ...(body ? { "content-type": "application/json" } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          }),
          params,
        });
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
