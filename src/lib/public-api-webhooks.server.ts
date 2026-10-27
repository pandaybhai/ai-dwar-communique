import type { SupabaseClient } from "@supabase/supabase-js";
import { createHmac, randomBytes } from "crypto";
import {
  WEBHOOK_EVENT_NAMES,
  WEBHOOK_RETRY_HOURS,
  WEBHOOK_TIMEOUT_SECONDS,
} from "@/lib/public-api";

/**
 * Batch 34 item 4: the merchant's own webhook hears about every message the
 * Public API sent — message.sent / message.delivered / message.read /
 * message.failed.
 *
 * Nothing re-reads Meta's webhook: the existing status handling
 * (processWebhookPayload) moves the message row as always and, for a row with
 * metadata.source "api", queues one row in public.api_webhook_deliveries per
 * (message, event) — a unique pair, so a status Meta repeats is queued once.
 * The minute flow-worker tick (the most frequent cron job; no new cron)
 * claims due rows (api_webhook_claim, FOR UPDATE SKIP LOCKED) and POSTs them,
 * retrying with backoff for up to 24 hours.
 *
 * The endpoint is one per workspace, stored like the flow connections
 * (workspace_connections, provider "api_webhook": the URL in public_config,
 * the signing secret in Vault through the same service-role functions). The
 * secret is shown when it is made or rotated, and never again.
 *
 * Signature: X-AiDwar-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + body)>
 * with X-AiDwar-Timestamp: <unix seconds>. Every delivery is SSRF-safe like the
 * document link: https, public on every address, no redirect followed, 10 s.
 */

export const API_WEBHOOK_EVENTS = WEBHOOK_EVENT_NAMES;
export type ApiWebhookEvent = (typeof API_WEBHOOK_EVENTS)[number] | "webhook.test";
export const TEST_EVENT = "webhook.test";

export const DELIVERY_TIMEOUT_MS = WEBHOOK_TIMEOUT_SECONDS * 1000;
/** A delivery is given up this long after its event. */
export const DELIVERY_GIVE_UP_MS = WEBHOOK_RETRY_HOURS * 60 * 60 * 1000;
/** Wait before attempt n+1 after n failed ones (the last step repeats). */
export const BACKOFF_MS = [
  60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000,
];
export const CLAIM_LIMIT = 25;
const CONCURRENCY = 5;
/** The tick stops starting deliveries after this long (pg_net drops the call at 120 s). */
export const DELIVERY_BUDGET_MS = 40_000;
const SECRET_PREFIX = "whsec_";

export function newSigningSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** The value of X-AiDwar-Signature for one body sent at `timestamp` (unix seconds). */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex")}`;
}

export function backoffAfter(attempts: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1]!;
}

const STATUS_OF: Record<string, string> = {
  "message.sent": "sent",
  "message.delivered": "delivered",
  "message.read": "read",
  "message.failed": "failed",
  [TEST_EVENT]: "test",
};

/** The JSON the merchant receives. */
export function webhookBody(input: {
  event: ApiWebhookEvent;
  messageId: string | null;
  idempotencyKey: string | null;
  to: string | null;
  error: { code: string | null; message: string } | null;
  occurredAt: string;
}): Record<string, unknown> {
  return {
    event: input.event,
    message_id: input.messageId,
    idempotency_key: input.idempotencyKey,
    to: input.to,
    status: STATUS_OF[input.event] ?? null,
    error: input.error,
    timestamp: input.occurredAt,
  };
}

/** A message the Public API sent (its row says so). */
export function isApiMessage(metadata: unknown): metadata is Record<string, unknown> {
  return Boolean(
    metadata &&
    typeof metadata === "object" &&
    (metadata as Record<string, unknown>)["source"] === "api",
  );
}

/**
 * Queues one event for an API message. Idempotent: (message_id, event) is
 * unique, so the same status twice is one delivery. Returns the error text
 * (the caller keeps its event retryable), else null. Never throws.
 */
export async function enqueueApiWebhookEvent(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    messageId: string;
    event: (typeof API_WEBHOOK_EVENTS)[number];
    occurredAt: string;
    metadata: Record<string, unknown>;
    /** For a failure: Meta's errors (as stored on messages.error_detail) or our own message. */
    error?: string | null;
  },
): Promise<string | null> {
  try {
    let error: { code: string | null; message: string } | null = null;
    if (input.event === "message.failed") {
      const { publicError } = await import("@/lib/public-api-messages.server");
      error = publicError("failed", input.error ?? null);
    }
    const payload = webhookBody({
      event: input.event,
      messageId: input.messageId,
      idempotencyKey:
        typeof input.metadata["idempotency_key"] === "string"
          ? (input.metadata["idempotency_key"] as string)
          : null,
      to: typeof input.metadata["to"] === "string" ? (input.metadata["to"] as string) : null,
      error,
      occurredAt: input.occurredAt,
    });
    const { error: writeError } = await supabase.from("api_webhook_deliveries").upsert(
      {
        organization_id: input.organizationId,
        message_id: input.messageId,
        event: input.event,
        payload,
        occurred_at: input.occurredAt,
        state: "pending",
        next_attempt_at: new Date().toISOString(),
      },
      { onConflict: "message_id,event", ignoreDuplicates: true },
    );
    if (!writeError) return null;
    console.warn(
      JSON.stringify({
        scope: "api_webhook",
        step: "enqueue",
        message_id: input.messageId,
        event: input.event,
        error: writeError.message,
      }),
    );
    return `api webhook: ${writeError.message}`;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    console.warn(
      JSON.stringify({
        scope: "api_webhook",
        step: "enqueue",
        message_id: input.messageId,
        event: input.event,
        error: text,
      }),
    );
    return `api webhook: ${text}`;
  }
}

/** The status webhook's hook: an API message moved to `status` queues its event. */
export async function queueApiStatus(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    messageId: string;
    status: string;
    at: string;
    metadata: unknown;
    errorDetail: string | null;
  },
): Promise<string | null> {
  if (!isApiMessage(input.metadata)) return null;
  const event = `message.${input.status}` as (typeof API_WEBHOOK_EVENTS)[number];
  if (!API_WEBHOOK_EVENTS.includes(event)) return null;
  return enqueueApiWebhookEvent(supabase, {
    organizationId: input.organizationId,
    messageId: input.messageId,
    event,
    occurredAt: input.at,
    metadata: input.metadata,
    error: input.errorDetail,
  });
}

// ------------------------------------------------------------ the endpoint

export type WebhookEndpoint = { id: string; url: string; status: string; secret: string };

export async function loadWebhookEndpoint(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<WebhookEndpoint | null> {
  const { loadSecret } = await import("@/lib/flow-connections.server");
  const row = await loadSecret(supabase, organizationId, "api_webhook");
  const url = typeof row?.config["url"] === "string" ? (row.config["url"] as string) : "";
  const secret = row?.secret["signing_secret"] ?? "";
  if (!row || !url || !secret) return null;
  return { id: row.id, url, status: row.status, secret };
}

/** An address the webhook may be set to: https, a public host as written and as resolved. Null when fine, else why not. */
export async function webhookUrlProblem(raw: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "That isn't a valid web address.";
  }
  if (url.protocol !== "https:") return "The webhook must be an https:// address.";
  if (url.username || url.password) return "Leave the user name and password out of the address.";
  const { assertPublicUrl, BlockedUrlError } = await import("@/lib/safe-fetch.server");
  try {
    await assertPublicUrl(url.toString(), undefined, { httpsOnly: true });
    return null;
  } catch (error) {
    if (error instanceof BlockedUrlError && error.code === "dns_lookup_failed")
      return "We couldn't look that address up. Check it and try again.";
    if (error instanceof BlockedUrlError && error.code === "dns_no_address")
      return "That address doesn't exist.";
    return "The webhook must be a public address (not a private or internal one).";
  }
}

export type DeliveryResult = { ok: boolean; status: number | null; error: string | null };

/** One POST to the merchant's webhook. Never throws, never follows a redirect, never logs the secret. */
export async function deliverWebhook(
  endpoint: { url: string; secret: string },
  input: { deliveryId: string; event: string; payload: Record<string, unknown>; now?: number },
): Promise<DeliveryResult> {
  const { assertPublicUrl, BlockedUrlError } = await import("@/lib/safe-fetch.server");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const url = await assertPublicUrl(endpoint.url, controller.signal, { httpsOnly: true });
    const timestamp = String(Math.floor((input.now ?? Date.now()) / 1000));
    const body = JSON.stringify(input.payload);
    const res = await fetch(url.toString(), {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "user-agent": "AiDwar-Webhooks/1.0",
        "x-aidwar-event": input.event,
        "x-aidwar-delivery": input.deliveryId,
        "x-aidwar-timestamp": timestamp,
        "x-aidwar-signature": signWebhook(endpoint.secret, timestamp, body),
      },
      body,
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.status >= 300 && res.status < 400)
      return { ok: false, status: res.status, error: "redirect_not_followed" };
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, error: null };
    return { ok: false, status: res.status, error: `http_${res.status}` };
  } catch (error) {
    if (error instanceof BlockedUrlError) return { ok: false, status: null, error: error.code };
    if (controller.signal.aborted) return { ok: false, status: null, error: "timeout_10s" };
    return { ok: false, status: null, error: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------ the tick

type DeliveryRow = {
  id: string;
  organization_id: string;
  event: string;
  payload: Record<string, unknown>;
  attempts: number;
  created_at: string;
};

export type DeliveryReport = {
  claimed: number;
  delivered: number;
  retrying: number;
  failed: number;
  skipped: number;
  released: number;
  error?: string;
};

/**
 * One tick: claim due deliveries, POST them (a few at a time), and record
 * each outcome: delivered; retried later (backoff) while the event is under
 * 24 h old; else failed. A workspace with no webhook set skips its events.
 * Rows claimed but not started before the deadline are handed back.
 * Never throws.
 */
export async function runApiWebhookDeliveries(
  supabase: SupabaseClient,
  options: { deadlineAt?: number } = {},
): Promise<DeliveryReport> {
  const deadlineAt = options.deadlineAt ?? Date.now() + DELIVERY_BUDGET_MS;
  const report: DeliveryReport = {
    claimed: 0,
    delivered: 0,
    retrying: 0,
    failed: 0,
    skipped: 0,
    released: 0,
  };
  try {
    const { data, error } = await supabase.rpc("api_webhook_claim", {
      p_limit: CLAIM_LIMIT,
      p_lease_seconds: 120,
    });
    if (error) {
      report.error = error.message;
      return report;
    }
    const rows = ((data ?? []) as DeliveryRow[]).filter((r) => r && r.id);
    report.claimed = rows.length;
    const endpoints = new Map<string, Promise<WebhookEndpoint | null>>();
    const endpointFor = (orgId: string) => {
      if (!endpoints.has(orgId))
        endpoints.set(
          orgId,
          loadWebhookEndpoint(supabase, orgId).catch(() => null),
        );
      return endpoints.get(orgId)!;
    };

    const queue = [...rows];
    const worker = async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        if (Date.now() >= deadlineAt) {
          await supabase
            .from("api_webhook_deliveries")
            .update({ lease_until: null })
            .eq("id", row.id);
          report.released += 1;
          continue;
        }
        await deliverOne(supabase, row, await endpointFor(row.organization_id), report);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
    await housekeeping(supabase);
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  return report;
}

async function deliverOne(
  supabase: SupabaseClient,
  row: DeliveryRow,
  endpoint: WebhookEndpoint | null,
  report: DeliveryReport,
): Promise<void> {
  const now = Date.now();
  const at = new Date(now).toISOString();
  if (!endpoint || endpoint.status !== "active") {
    await supabase
      .from("api_webhook_deliveries")
      .update({
        state: "skipped",
        lease_until: null,
        last_error: "no_webhook_set",
        last_attempt_at: at,
      })
      .eq("id", row.id);
    report.skipped += 1;
    return;
  }
  const result = await deliverWebhook(endpoint, {
    deliveryId: row.id,
    event: row.event,
    payload: row.payload,
    now,
  });
  const attempts = Number(row.attempts ?? 0) + 1;
  const base = {
    attempts,
    lease_until: null,
    last_attempt_at: at,
    last_status: result.status,
    last_error: result.error,
  };
  if (result.ok) {
    await supabase
      .from("api_webhook_deliveries")
      .update({ ...base, state: "delivered", delivered_at: at })
      .eq("id", row.id);
    report.delivered += 1;
    return;
  }
  const next = now + backoffAfter(attempts);
  const giveUpAt = Date.parse(row.created_at) + DELIVERY_GIVE_UP_MS;
  if (row.event === TEST_EVENT || now >= giveUpAt) {
    await supabase
      .from("api_webhook_deliveries")
      .update({ ...base, state: "failed" })
      .eq("id", row.id);
    report.failed += 1;
    return;
  }
  await supabase
    .from("api_webhook_deliveries")
    .update({ ...base, next_attempt_at: new Date(Math.min(next, giveUpAt)).toISOString() })
    .eq("id", row.id);
  report.retrying += 1;
}

/** Old counters and answers go; a delivery's record is kept 30 days. */
async function housekeeping(supabase: SupabaseClient): Promise<void> {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  try {
    await supabase
      .from("api_rate_windows")
      .delete()
      .lt("window_start", ago(60 * 60_000));
    await supabase
      .from("api_requests")
      .delete()
      .lt("created_at", ago(48 * 60 * 60_000));
    await supabase
      .from("api_webhook_deliveries")
      .delete()
      .neq("state", "pending")
      .lt("created_at", ago(30 * 24 * 60 * 60_000));
  } catch (error) {
    console.warn(
      JSON.stringify({
        scope: "api_webhook",
        step: "housekeeping",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/**
 * Settings → "Send test event": one delivery of webhook.test right now, its
 * result recorded like any delivery (and never retried).
 */
export async function sendTestEvent(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<{ ok: true; result: DeliveryResult } | { ok: false; error: string }> {
  const endpoint = await loadWebhookEndpoint(supabase, organizationId);
  if (!endpoint) return { ok: false, error: "Set a webhook address first." };
  const occurredAt = new Date().toISOString();
  const payload = webhookBody({
    event: TEST_EVENT,
    messageId: null,
    idempotencyKey: null,
    to: null,
    error: null,
    occurredAt,
  });
  const { data, error } = await supabase
    .from("api_webhook_deliveries")
    .insert({
      organization_id: organizationId,
      message_id: null,
      event: TEST_EVENT,
      payload,
      occurred_at: occurredAt,
      state: "pending",
      lease_until: new Date(Date.now() + 120_000).toISOString(),
    })
    .select("id, organization_id, event, payload, attempts, created_at")
    .single();
  if (error || !data) return { ok: false, error: "We couldn't record the test. Please try again." };
  const row = {
    attempts: 0,
    ...(data as Omit<DeliveryRow, "attempts"> & { attempts?: number }),
  } as DeliveryRow;
  const result = await deliverWebhook(endpoint, {
    deliveryId: row.id,
    event: TEST_EVENT,
    payload: row.payload,
  });
  const at = new Date().toISOString();
  await supabase
    .from("api_webhook_deliveries")
    .update({
      attempts: 1,
      lease_until: null,
      last_attempt_at: at,
      last_status: result.status,
      last_error: result.error,
      state: result.ok ? "delivered" : "failed",
      ...(result.ok ? { delivered_at: at } : {}),
    })
    .eq("id", row.id);
  return { ok: true, result };
}
