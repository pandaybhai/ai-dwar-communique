import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Batch 38 item 4: what WhatsApp tells us about the number and the account,
 * on the merchant's webhook —
 *
 *   phone_number.quality_changed  the number's quality rating moved
 *                                 (GREEN / YELLOW / RED)
 *   messaging_limit.changed       its daily messaging limit moved
 *                                 (e.g. TIER_1K -> TIER_10K)
 *   account.status_changed        the WhatsApp Business Account was reviewed,
 *                                 restricted, disabled or restored
 *
 * Read from the notices the Meta webhook already handles
 * (processWebhookPayload: phone_number_quality_update / account_update, and
 * account_review_update), after its own writes, and queued through
 * queueAccountEvent (only when the workspace's webhook hears events and the
 * event is in its plan), once per notice: a notice Meta sends again carries
 * the same entry time and so the same dedupe key. Nothing here changes what
 * the handling stores. Never throws.
 */

type AnyRecord = Record<string, unknown>;

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;

/** A notice's own time (the entry's unix seconds), else now. */
export function noticeTime(entry: AnyRecord): string {
  const t = Number(entry["time"]);
  return Number.isFinite(t) && t > 0 ? new Date(t * 1000).toISOString() : new Date().toISOString();
}

export function qualityPayload(input: {
  phoneNumber: string | null;
  previous: string | null;
  current: string;
  whatsappEvent: string | null;
  occurredAt: string;
}): AnyRecord {
  return {
    event: "phone_number.quality_changed",
    phone_number: input.phoneNumber,
    quality: { previous: input.previous, current: input.current },
    whatsapp_event: input.whatsappEvent,
    timestamp: input.occurredAt,
  };
}

export function limitPayload(input: {
  phoneNumber: string | null;
  previous: string | null;
  current: string;
  whatsappEvent: string | null;
  occurredAt: string;
}): AnyRecord {
  return {
    event: "messaging_limit.changed",
    phone_number: input.phoneNumber,
    limit: { previous: input.previous, current: input.current },
    whatsapp_event: input.whatsappEvent,
    timestamp: input.occurredAt,
  };
}

/** What an account notice means, in the API's words. */
export function accountStatus(field: string, value: AnyRecord): string | null {
  if (field === "account_review_update") {
    const decision = String(value["decision"] ?? "").toUpperCase();
    if (decision === "APPROVED") return "approved";
    if (decision === "REJECTED") return "rejected";
    if (decision === "PENDING" || decision === "DEFERRED") return "in_review";
    return null;
  }
  const event = String(value["event"] ?? "").toUpperCase();
  if (["DISABLED_UPDATE", "ACCOUNT_DELETED"].includes(event)) return "disabled";
  if (event === "ACCOUNT_VIOLATION") return "restricted";
  if (["VERIFIED_ACCOUNT", "ACCOUNT_RESTORED"].includes(event)) return "active";
  if (event) return "updated";
  return null;
}

export function accountPayload(input: {
  field: string;
  value: AnyRecord;
  occurredAt: string;
}): AnyRecord | null {
  const status = accountStatus(input.field, input.value);
  if (!status) return null;
  const v = input.value;
  const violation = (v["violation_info"] ?? null) as AnyRecord | null;
  const ban = (v["ban_info"] ?? null) as AnyRecord | null;
  const restrictions = Array.isArray((v["restriction_info"] as unknown) ?? null)
    ? ((v["restriction_info"] as AnyRecord[]).map((r) => ({
        type: str(r["restriction_type"]),
        expires_at: str(r["expiration"]),
      })) as unknown[])
    : [];
  return {
    event: "account.status_changed",
    status,
    whatsapp_event:
      input.field === "account_review_update"
        ? `REVIEW_${String(v["decision"] ?? "").toUpperCase()}`
        : str(v["event"]),
    reason: str(violation?.["violation_type"]) ?? str(ban?.["waba_ban_state"]) ?? null,
    restrictions,
    timestamp: input.occurredAt,
  };
}

/**
 * The webhook pass's hook for one quality / account notice of one number:
 * the events it means, queued. `previous*` are the account row's values as
 * read before the notice was applied.
 */
export async function queueAccountNoticeEvents(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    accountId: string;
    field: string;
    value: AnyRecord;
    entry: AnyRecord;
    phoneNumber: string | null;
    previousQuality: string | null;
    nextQuality: string | null;
    previousLimit: string | null;
  },
): Promise<void> {
  try {
    const { queueAccountEvent } = await import("@/lib/public-api-webhooks.server");
    const occurredAt = noticeTime(input.entry);
    const whatsappEvent = str(input.value["event"]);
    const key = `${input.accountId}:${occurredAt}`;
    if (input.nextQuality && input.nextQuality !== input.previousQuality) {
      await queueAccountEvent(supabase, {
        organizationId: input.organizationId,
        event: "phone_number.quality_changed",
        dedupeKey: `phone_number.quality_changed:${key}`,
        occurredAt,
        payload: qualityPayload({
          phoneNumber: input.phoneNumber,
          previous: input.previousQuality,
          current: input.nextQuality,
          whatsappEvent,
          occurredAt,
        }),
      });
    }
    const limit = str(input.value["current_limit"]);
    if (input.field === "phone_number_quality_update" && limit && limit !== input.previousLimit) {
      await queueAccountEvent(supabase, {
        organizationId: input.organizationId,
        event: "messaging_limit.changed",
        dedupeKey: `messaging_limit.changed:${key}`,
        occurredAt,
        payload: limitPayload({
          phoneNumber: input.phoneNumber,
          previous: str(input.value["old_limit"]) ?? input.previousLimit,
          current: limit,
          whatsappEvent,
          occurredAt,
        }),
      });
    }
    if (input.field === "account_update" || input.field === "account_review_update") {
      const payload = accountPayload({ field: input.field, value: input.value, occurredAt });
      if (payload) {
        await queueAccountEvent(supabase, {
          organizationId: input.organizationId,
          event: "account.status_changed",
          dedupeKey: `account.status_changed:${input.organizationId}:${input.field}:${occurredAt}`,
          occurredAt,
          payload,
        });
      }
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        scope: "api_webhook",
        step: "account_notice",
        organization_id: input.organizationId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
