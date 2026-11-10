import type { SupabaseClient } from "@supabase/supabase-js";
import { refusalRow, type RefusalEndpoint, type RefusalRow } from "@/lib/api-refusals";

/**
 * Batch 67: the recorder behind the two Public API send routes. It looks at
 * the answer the route already built and, when it is a refusal (see
 * refusalRow), writes one api_refusals row — after the answer, through the
 * runtime's waitUntil when there is one (Cloudflare), else awaited (dev and
 * tests). The answer itself is returned untouched: same object, status, body
 * and headers. A failed or slow insert never changes or delays it, and never
 * throws. 401 (no valid key, no workspace) is never recorded.
 */

/**
 * The caller behind a refusal the key check answered after it knew whose key
 * it was (403 public_api_disabled, 403 endpoint_not_in_plan): the route has no
 * caller then, so authenticateApiKey tags the Response here. Never read for
 * anything but recording the refusal.
 */
const keyOwners = new WeakMap<Response, { keyId: string; organizationId: string }>();

export function tagRefusalOwner(
  response: Response,
  owner: { keyId: string; organizationId: string },
): Response {
  keyOwners.set(response, owner);
  return response;
}

type WaitUntil = (work: Promise<unknown>) => void;

/** The runtime's "keep working after the response" (as whatsapp-webhook's waitUntilOf). */
function waitUntilOf(request: Request): WaitUntil | null {
  const r = request as Request & {
    waitUntil?: WaitUntil;
    runtime?: { cloudflare?: { context?: { waitUntil?: WaitUntil } } };
  };
  if (typeof r.waitUntil === "function") return r.waitUntil;
  const ctx = r.runtime?.cloudflare?.context;
  if (ctx && typeof ctx.waitUntil === "function") return ctx.waitUntil.bind(ctx);
  return null;
}

/** One insert; a repeat of the same key and code is ignored. Never throws. */
export async function insertRefusal(supabase: SupabaseClient, row: RefusalRow): Promise<void> {
  try {
    const query = row.dedupe_key
      ? supabase.from("api_refusals").upsert(row, {
          onConflict: "organization_id,dedupe_key",
          ignoreDuplicates: true,
        })
      : supabase.from("api_refusals").insert(row);
    const { error } = await query;
    if (error)
      console.warn(
        JSON.stringify({
          scope: "api_refusals",
          step: "insert",
          organization_id: row.organization_id,
          code: row.error_code,
          error: error.message,
        }),
      );
  } catch (error) {
    console.warn(
      JSON.stringify({
        scope: "api_refusals",
        step: "insert",
        organization_id: row.organization_id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/**
 * Records `response` when it is a refusal, then returns it unchanged.
 * `caller` null: the key check answered (only a tagged answer is recorded).
 */
export async function recordRefusal(
  request: Request,
  supabase: SupabaseClient,
  context: {
    endpoint: RefusalEndpoint;
    caller: { keyId: string; organizationId: string; source?: "api_console" } | null;
    body: unknown;
  },
  response: Response,
): Promise<Response> {
  try {
    if (response.status < 400) return response;
    const caller = context.caller ?? keyOwners.get(response) ?? null;
    if (!caller) return response;
    let answer: unknown = null;
    try {
      answer = await response.clone().json();
    } catch {
      answer = null;
    }
    const row = refusalRow({
      organizationId: caller.organizationId,
      keyId: caller.keyId,
      source:
        "source" in caller && (caller as { source?: unknown }).source === "api_console"
          ? "api_console"
          : undefined,
      endpoint: context.endpoint,
      status: response.status,
      replayed: response.headers.get("idempotent-replayed") === "true",
      answer,
      request: context.body,
      idempotencyHeader: request.headers.get("idempotency-key"),
    });
    if (!row) return response;
    const work = insertRefusal(supabase, row);
    const later = waitUntilOf(request);
    if (later) later(work);
    else await work;
  } catch {
    // recording never changes the answer
  }
  return response;
}
