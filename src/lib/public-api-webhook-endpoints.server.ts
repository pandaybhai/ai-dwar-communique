import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiCaller, ApiReply } from "@/lib/public-api.server";
import { ALL_WEBHOOK_EVENTS } from "@/lib/public-api";
import { fail, validId } from "@/lib/public-api-route.server";

/**
 * Batch 38 item 3: up to 5 webhooks per workspace, each with its own signing
 * secret and event filter, managed from the API (/api/v1/webhooks) and from
 * Settings → API & webhooks.
 *
 * The webhooks live in api_webhook_endpoints (20261160), their secrets in
 * Vault only (api_webhook_endpoint_set_secret / api_webhook_endpoints_for,
 * service role). The workspace's existing Settings webhook — Batch 34's one
 * workspace_connections row — becomes its first entry with the same url and
 * the same secret (api_webhook_adopt_legacy, run by the migration and again
 * on every read, so one saved by older code after it ran is never lost).
 *
 * Before 20261160 is applied (the read function answers PGRST202) everything
 * is as it was: the one Settings webhook hears every event, and the API's
 * webhook endpoints answer 503. Secrets are shown once, when made or
 * rotated, and are never logged.
 */

export const MAX_WEBHOOKS = 5;
export const MAX_WEBHOOK_REQUEST_BYTES = 32 * 1024;

export type Endpoint = {
  id: string;
  url: string;
  /** Null: every event. */
  events: string[] | null;
  status: "active" | "disabled";
  legacy: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  secret: string;
};

export type Endpoints =
  | { mode: "multi"; endpoints: Endpoint[] }
  /** 20261160 not applied: the one Settings webhook (or none). */
  | { mode: "legacy"; endpoints: Endpoint[] }
  | { mode: "error" };

const MISSING = new Set(["PGRST202", "42883", "42P01"]);

/** The workspace's webhooks with their secrets (server only, never an answer). */
export async function loadEndpoints(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<Endpoints> {
  const { data, error } = await supabase.rpc("api_webhook_endpoints_for", {
    p_org: organizationId,
  });
  // A missing function (PGRST202), or no table answer at all: the one Settings webhook, as before.
  if (
    (error && MISSING.has(String((error as { code?: string }).code ?? ""))) ||
    (!error && !Array.isArray(data))
  ) {
    const { loadWebhookEndpoint } = await import("@/lib/public-api-webhooks.server");
    const one = await loadWebhookEndpoint(supabase, organizationId).catch(() => null);
    return {
      mode: "legacy",
      endpoints: one
        ? [
            {
              id: one.id,
              url: one.url,
              events: null,
              status: one.status === "active" ? "active" : "disabled",
              legacy: true,
              createdAt: null,
              updatedAt: null,
              secret: one.secret,
            },
          ]
        : [],
    };
  }
  if (error) return { mode: "error" };
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  return {
    mode: "multi",
    endpoints: rows.map((r) => ({
      id: String(r["id"]),
      url: String(r["url"] ?? ""),
      events: Array.isArray(r["events"]) ? (r["events"] as string[]) : null,
      status: r["status"] === "active" ? "active" : "disabled",
      legacy: r["legacy"] === true,
      createdAt: (r["created_at"] as string | null) ?? null,
      updatedAt: (r["updated_at"] as string | null) ?? null,
      secret: String(r["secret"] ?? ""),
    })),
  };
}

/** Whether this webhook hears `event` (a test event only when asked for by id). */
export function hears(endpoint: Endpoint, event: string): boolean {
  if (endpoint.status !== "active" || !endpoint.secret) return false;
  return endpoint.events === null || endpoint.events.includes(event);
}

/** A webhook as the API and Settings show it: never its secret. */
export function publicWebhook(e: Endpoint): Record<string, unknown> {
  return {
    webhook_id: e.id,
    url: e.url,
    events: e.events ?? [...ALL_WEBHOOK_EVENTS],
    all_events: e.events === null,
    status: e.status,
    created_at: e.createdAt,
    updated_at: e.updatedAt,
  };
}

// ------------------------------------------------------------ input

/** `events`: an array of known event names (or "*" / null for every event). Null = every event. */
export function parseEvents(raw: unknown): string[] | null | string {
  if (raw === undefined || raw === null || raw === "*") return null;
  if (!Array.isArray(raw) || !raw.length)
    return '`events` must be a non-empty array of event names, or "*" for every event.';
  const out: string[] = [];
  for (const e of raw) {
    if (e === "*") return null;
    if (typeof e !== "string" || !(ALL_WEBHOOK_EVENTS as readonly string[]).includes(e))
      return `Unknown event ${JSON.stringify(e)}. GET /api/v1/webhooks/events lists them.`;
    if (!out.includes(e)) out.push(e);
  }
  return out;
}

const unavailable = () =>
  fail(
    503,
    "unavailable",
    "Managing webhooks from the API isn't available yet. Please try again later.",
  );
const notFound = () =>
  fail(404, "not_found", "There is no webhook with this id in this workspace.");

async function urlProblem(raw: unknown): Promise<string | null> {
  if (typeof raw !== "string" || !raw.trim()) return "`url` is required: your https:// endpoint.";
  const { webhookUrlProblem } = await import("@/lib/public-api-webhooks.server");
  return webhookUrlProblem(raw.trim());
}

async function forget(organizationId: string): Promise<void> {
  const { forgetApiEventsWanted } = await import("@/lib/public-api-webhooks.server");
  forgetApiEventsWanted(organizationId);
}

// ------------------------------------------------------------ the operations (API and Settings)

export type WebhookActor = {
  organizationId: string;
  userId: string | null;
  apiKeyId: string | null;
};

async function log(
  supabase: SupabaseClient,
  actor: WebhookActor,
  action: string,
  details: Record<string, unknown>,
): Promise<void> {
  const { logServerActivity } = await import("@/lib/whatsapp-api.server");
  await logServerActivity(supabase, actor.organizationId, actor.userId, action, {
    ...details,
    ...(actor.apiKeyId ? { source: "api", api_key_id: actor.apiKeyId } : {}),
  });
}

/** A new webhook (its secret in this one answer). */
export async function createWebhook(
  supabase: SupabaseClient,
  actor: WebhookActor,
  input: { url: unknown; events: unknown },
): Promise<ApiReply> {
  const problem = await urlProblem(input.url);
  if (problem) return fail(400, "invalid_url", problem);
  const events = parseEvents(input.events);
  if (typeof events === "string") return fail(400, "invalid_events", events);
  const current = await loadEndpoints(supabase, actor.organizationId);
  if (current.mode !== "multi") return unavailable();
  if (current.endpoints.length >= MAX_WEBHOOKS)
    return fail(
      409,
      "webhook_limit_reached",
      `A workspace can have ${MAX_WEBHOOKS} webhooks. Remove one first.`,
    );
  const url = String(input.url).trim();
  const { data, error } = await supabase
    .from("api_webhook_endpoints")
    .insert({
      organization_id: actor.organizationId,
      url,
      events,
      status: "active",
      created_by: actor.userId,
    })
    .select("id")
    .single();
  if (error || !data) {
    if (/webhook_limit_reached/.test(String(error?.message ?? "")))
      return fail(
        409,
        "webhook_limit_reached",
        `A workspace can have ${MAX_WEBHOOKS} webhooks. Remove one first.`,
      );
    return fail(503, "unavailable", "We couldn't save the webhook. Please try again.");
  }
  const id = (data as { id: string }).id;
  const { newSigningSecret } = await import("@/lib/public-api-webhooks.server");
  const secret = newSigningSecret();
  const { error: secretError } = await supabase.rpc("api_webhook_endpoint_set_secret", {
    p_id: id,
    p_secret: secret,
  });
  if (secretError) {
    await supabase.rpc("api_webhook_endpoint_delete", { p_id: id });
    return fail(503, "unavailable", "We couldn't store the signing secret. Please try again.");
  }
  await forget(actor.organizationId);
  await log(supabase, actor, "api_webhook_saved", { webhook_id: id, host: new URL(url).host });
  const saved = (await loadEndpoints(supabase, actor.organizationId)) as Extract<
    Endpoints,
    { mode: "multi" }
  >;
  const row = saved.endpoints?.find((e) => e.id === id);
  // The only time this secret leaves the server.
  return {
    status: 201,
    body: { webhook: row ? publicWebhook(row) : { webhook_id: id, url }, secret },
  };
}

async function own(
  supabase: SupabaseClient,
  organizationId: string,
  webhookId: string,
): Promise<{ all: Endpoints; row: Endpoint | null }> {
  const all = await loadEndpoints(supabase, organizationId);
  if (all.mode === "error" || !validId(webhookId)) return { all, row: null };
  return { all, row: all.endpoints.find((e) => e.id === webhookId) ?? null };
}

/** PATCH: url, events, status (active / disabled), rotate_secret. */
export async function updateWebhook(
  supabase: SupabaseClient,
  actor: WebhookActor,
  webhookId: string,
  raw: unknown,
): Promise<ApiReply> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return fail(400, "invalid_json", "The request body must be a JSON object.");
  const body = raw as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (body["url"] !== undefined) {
    const problem = await urlProblem(body["url"]);
    if (problem) return fail(400, "invalid_url", problem);
    patch["url"] = String(body["url"]).trim();
  }
  if (body["events"] !== undefined) {
    const events = parseEvents(body["events"]);
    if (typeof events === "string") return fail(400, "invalid_events", events);
    patch["events"] = events;
  }
  if (body["status"] !== undefined) {
    if (body["status"] !== "active" && body["status"] !== "disabled")
      return fail(400, "invalid_status", "`status` must be active or disabled.");
    patch["status"] = body["status"];
  }
  const rotate = body["rotate_secret"] === true;
  if (!Object.keys(patch).length && !rotate)
    return fail(
      400,
      "invalid_json",
      "Change at least one of url, events, status or rotate_secret.",
    );
  const { all, row } = await own(supabase, actor.organizationId, webhookId);
  if (all.mode === "error")
    return fail(503, "unavailable", "We couldn't read your webhooks. Please try again.");
  if (all.mode === "legacy") return unavailable();
  if (!row) return notFound();
  if (Object.keys(patch).length) {
    const { error } = await supabase
      .from("api_webhook_endpoints")
      .update(patch)
      .eq("id", row.id)
      .eq("organization_id", actor.organizationId);
    if (error) return fail(503, "unavailable", "We couldn't update the webhook. Please try again.");
  }
  let secret: string | null = null;
  if (rotate) {
    const { newSigningSecret } = await import("@/lib/public-api-webhooks.server");
    secret = newSigningSecret();
    const { error } = await supabase.rpc("api_webhook_endpoint_set_secret", {
      p_id: row.id,
      p_secret: secret,
    });
    if (error)
      return fail(503, "unavailable", "We couldn't rotate the signing secret. Please try again.");
  }
  await forget(actor.organizationId);
  await log(supabase, actor, rotate ? "api_webhook_secret_rotated" : "api_webhook_saved", {
    webhook_id: row.id,
    ...(patch["url"] ? { host: new URL(String(patch["url"])).host } : {}),
  });
  const after = (await own(supabase, actor.organizationId, row.id)).row ?? row;
  return { status: 200, body: { webhook: publicWebhook(after), ...(secret ? { secret } : {}) } };
}

export async function deleteWebhook(
  supabase: SupabaseClient,
  actor: WebhookActor,
  webhookId: string,
): Promise<ApiReply> {
  const { all, row } = await own(supabase, actor.organizationId, webhookId);
  if (all.mode === "error")
    return fail(503, "unavailable", "We couldn't read your webhooks. Please try again.");
  if (all.mode === "legacy") return unavailable();
  if (!row) return notFound();
  const { error } = await supabase.rpc("api_webhook_endpoint_delete", { p_id: row.id });
  if (error) return fail(503, "unavailable", "We couldn't remove the webhook. Please try again.");
  await forget(actor.organizationId);
  await log(supabase, actor, "api_webhook_removed", { webhook_id: row.id });
  return { status: 200, body: { webhook_id: row.id, deleted: true } };
}

export async function listWebhooks(supabase: SupabaseClient, caller: ApiCaller): Promise<ApiReply> {
  const all = await loadEndpoints(supabase, caller.organizationId);
  if (all.mode === "error")
    return fail(503, "unavailable", "We couldn't read your webhooks. Please try again.");
  if (all.mode === "legacy") return unavailable();
  return { status: 200, body: { webhooks: all.endpoints.map(publicWebhook), limit: MAX_WEBHOOKS } };
}

export async function getWebhook(
  supabase: SupabaseClient,
  caller: ApiCaller,
  webhookId: string,
): Promise<ApiReply> {
  const { all, row } = await own(supabase, caller.organizationId, webhookId);
  if (all.mode === "error")
    return fail(503, "unavailable", "We couldn't read your webhooks. Please try again.");
  if (all.mode === "legacy") return unavailable();
  return row ? { status: 200, body: { webhook: publicWebhook(row) } } : notFound();
}

/** POST /api/v1/webhooks/{id}/test: one webhook.test to this webhook now, recorded, never retried. */
export async function testWebhook(
  supabase: SupabaseClient,
  actor: WebhookActor,
  webhookId: string,
): Promise<ApiReply> {
  const { all, row } = await own(supabase, actor.organizationId, webhookId);
  if (all.mode === "error")
    return fail(503, "unavailable", "We couldn't read your webhooks. Please try again.");
  if (all.mode === "legacy") return unavailable();
  if (!row) return notFound();
  const { sendTestEventTo } = await import("@/lib/public-api-webhooks.server");
  const sent = await sendTestEventTo(supabase, actor.organizationId, row);
  if (!sent.ok) return fail(503, "unavailable", sent.error);
  await log(supabase, actor, "api_webhook_test_sent", {
    webhook_id: row.id,
    ok: sent.result.ok,
    status: sent.result.status,
  });
  return {
    status: 200,
    body: {
      webhook_id: row.id,
      delivered: sent.result.ok,
      response_status: sent.result.status,
      error: sent.result.error,
    },
  };
}

/** GET /api/v1/webhooks/events: every event, when it fires, an example, and the plans that have it. */
export async function webhookEventCatalogue(): Promise<ApiReply> {
  const { WEBHOOK_EVENTS } = await import("@/lib/public-api-spec");
  const { eventFor, PLAN_LABELS } = await import("@/lib/public-api-plans");
  return {
    status: 200,
    body: {
      events: WEBHOOK_EVENTS.map((e) => {
        const row = eventFor(e.name);
        return {
          name: e.name,
          description: e.when,
          since: row?.since ?? null,
          plans: (row?.plans ?? []).map((p) => PLAN_LABELS[p]),
          example: e.example,
        };
      }),
    },
  };
}

/** The Public API's caller as an actor. */
export function apiActor(caller: ApiCaller): WebhookActor {
  return { organizationId: caller.organizationId, userId: null, apiKeyId: caller.keyId };
}
