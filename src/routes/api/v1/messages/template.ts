import { createFileRoute } from "@tanstack/react-router";

/**
 * Public API (Batch 34): send one approved template with a document header —
 * an invoice PDF — to one customer. "Authorization: Bearer adw_live_…".
 * The key, the public_api flag and the rate limits are checked before the
 * body is read; the send itself is sendTemplateViaApi
 * (src/lib/public-api-send.server.ts). Docs: /developers/api.
 */
export const Route = createFileRoute("/api/v1/messages/template")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const { apiError, authenticateApiKey, takeRateLimit } =
          await import("@/lib/public-api.server");
        const { MAX_REQUEST_BYTES, sendTemplateViaApi } =
          await import("@/lib/public-api-send.server");
        const { BodyTooLargeError, readBodyCapped } = await import("@/lib/safe-fetch.server");

        const supabase = getServiceClient();
        // Batch 67: the answer is built exactly as before; a refusal is then
        // recorded for the shop (api-refusals.server.ts), the answer untouched.
        let seenCaller: { keyId: string; organizationId: string; source?: "api_console" } | null =
          null;
        let seenBody: unknown = null;
        const answerFor = async (): Promise<Response> => {
          const caller = await authenticateApiKey(supabase, request);
          if (caller instanceof Response) return caller;
          seenCaller = caller;
          const limited = await takeRateLimit(supabase, caller);
          if (limited) return limited;

          const declared = Number(request.headers.get("content-length") ?? NaN);
          if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
            return apiError(
              413,
              "request_too_large",
              "The request is larger than the 23 MB limit (a 16 MB PDF in base64).",
            );
          }
          let raw: unknown;
          try {
            const bytes = await readBodyCapped(request.body, MAX_REQUEST_BYTES);
            raw = JSON.parse(new TextDecoder().decode(bytes));
            seenBody = raw;
          } catch (error) {
            if (error instanceof BodyTooLargeError) {
              return apiError(
                413,
                "request_too_large",
                "The request is larger than the 23 MB limit (a 16 MB PDF in base64).",
              );
            }
            return apiError(400, "invalid_json", "The request body must be JSON.");
          }

          try {
            const answer = await sendTemplateViaApi(supabase, caller, raw, {
              idempotencyHeader: request.headers.get("idempotency-key"),
            });
            return Response.json(answer.body, {
              status: answer.status,
              headers: answer.headers ?? {},
            });
          } catch (error) {
            console.error(
              JSON.stringify({
                scope: "public_api",
                step: "send",
                organization_id: caller.organizationId,
                key_id: caller.keyId,
                error: error instanceof Error ? error.message : String(error),
              }),
            );
            return apiError(
              500,
              "internal_error",
              "Something went wrong on our side. Repeat the call with the same idempotency_key: it is sent if it wasn't, and it is never sent twice.",
            );
          }
        };
        const answer = await answerFor();
        const { recordRefusal } = await import("@/lib/api-refusals.server");
        return recordRefusal(
          request,
          supabase,
          { endpoint: "template", caller: seenCaller, body: seenBody },
          answer,
        );
      },
    },
  },
});
