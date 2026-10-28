import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiCaller } from "@/lib/public-api.server";

/**
 * Batch 38: one Public API route's request, start to end — the key, the
 * public_api flag, the plan and the rate limit checked before the body is
 * read (authenticateApiKey + takeRateLimit, as the Batch 34 routes do), the
 * JSON body read up to `maxBytes` when the route takes one, and an
 * unexpected error answered as 500 internal_error (logged with the
 * workspace and key id only, never the key or the body).
 *
 * The same shape as Batch 37's runApiRoute (public-api.server.ts), which
 * replaces this once Batch 37 is on main.
 */

export type ApiReply = {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
};

export const fail = (status: number, code: string, error: string): ApiReply => ({
  status,
  body: { error, code },
});

export async function runV1Route(
  request: Request,
  options: { step: string; body?: { maxBytes: number } },
  handle: (input: {
    supabase: SupabaseClient;
    caller: ApiCaller;
    body: unknown;
  }) => Promise<ApiReply | Response>,
): Promise<Response> {
  const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
  const { apiError, authenticateApiKey, takeRateLimit } = await import("@/lib/public-api.server");
  const supabase = getServiceClient();
  const caller = await authenticateApiKey(supabase, request);
  if (caller instanceof Response) return caller;
  const limited = await takeRateLimit(supabase, caller);
  if (limited) return limited;

  let body: unknown = null;
  if (options.body) {
    const max = options.body.maxBytes;
    const tooLarge = () =>
      apiError(
        413,
        "request_too_large",
        `The request is larger than the ${Math.round(max / 1024 / 1024)} MB limit.`,
      );
    const declared = Number(request.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > max) return tooLarge();
    const { BodyTooLargeError, readBodyCapped } = await import("@/lib/safe-fetch.server");
    try {
      const bytes = await readBodyCapped(request.body, max);
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      if (error instanceof BodyTooLargeError) return tooLarge();
      return apiError(400, "invalid_json", "The request body must be JSON.");
    }
  }

  try {
    const answer = await handle({ supabase, caller, body });
    if (answer instanceof Response) return answer;
    return Response.json(answer.body, { status: answer.status, headers: answer.headers ?? {} });
  } catch (error) {
    console.error(
      JSON.stringify({
        scope: "public_api",
        step: options.step,
        organization_id: caller.organizationId,
        key_id: caller.keyId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return apiError(
      500,
      "internal_error",
      "Something went wrong on our side. Please try again (with the same idempotency_key where the call takes one).",
    );
  }
}

/** A cursor for "after this row" lists: opaque to callers (base64url of "time|id"). */
export function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(raw: string | null): { at: string; id: string } | null | "invalid" {
  if (!raw) return null;
  try {
    const text = Buffer.from(raw, "base64url").toString("utf8");
    const [at, id] = text.split("|");
    if (
      !at ||
      !id ||
      !/^[0-9T:.+\- Z]{10,40}$/.test(at) ||
      Number.isNaN(Date.parse(at)) ||
      !/^[A-Za-z0-9-]{1,64}$/.test(id)
    )
      return "invalid";
    return { at, id };
  } catch {
    return "invalid";
  }
}

/** Ids the API takes in a path: uuid-like, nothing else reaches a query. */
export function validId(raw: string): boolean {
  return /^[A-Za-z0-9-]{1,64}$/.test(raw);
}
