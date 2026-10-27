import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiCaller } from "@/lib/public-api.server";

/**
 * Batch 34 item 3: GET /api/v1/messages/{message_id} — what happened to a
 * message the API sent. Only the key's own workspace, and only messages the
 * API sent (metadata.source "api"); anything else is the same 404 as an id
 * that doesn't exist, so ids can't be probed. The status is the messages
 * row's own, moved by the Meta webhook as for every message.
 */

/** The public status of a message (pending is "queued": Meta has it, WhatsApp hasn't confirmed yet). */
export function publicStatus(
  status: string | null | undefined,
): "queued" | "sent" | "delivered" | "read" | "failed" {
  switch (String(status ?? "")) {
    case "sent":
      return "sent";
    case "delivered":
      return "delivered";
    case "read":
      return "read";
    case "failed":
      return "failed";
    default:
      return "queued";
  }
}

/**
 * The reason a message failed, from messages.error_detail: our send path
 * stores providerErrorDetail (an object), the status webhook Meta's errors
 * array. Null when it didn't fail.
 */
export function publicError(
  status: string | null | undefined,
  detail: string | null | undefined,
): { code: string | null; message: string } | null {
  if (status !== "failed") return null;
  let parsed: unknown = null;
  try {
    parsed = detail ? JSON.parse(detail) : null;
  } catch {
    parsed = null;
  }
  const first = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | null;
  if (!first || typeof first !== "object")
    return {
      code: null,
      message: detail ? String(detail).slice(0, 300) : "The message couldn't be delivered.",
    };
  const data = (first["error_data"] ?? null) as Record<string, unknown> | null;
  const message =
    (first["error_user_msg"] as string | undefined) ??
    (data?.["details"] as string | undefined) ??
    (first["message"] as string | undefined) ??
    (first["title"] as string | undefined) ??
    "The message couldn't be delivered.";
  return {
    code: first["code"] != null ? String(first["code"]) : null,
    message: String(message).slice(0, 300),
  };
}

export type ApiMessageRow = {
  id: string;
  status: string | null;
  template_name: string | null;
  meta_message_id: string | null;
  error_detail: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  status_updated_at: string | null;
};

export async function apiMessageStatus(
  supabase: SupabaseClient,
  caller: ApiCaller,
  messageId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const notFound = {
    status: 404,
    body: { error: "There is no message with this id in this workspace.", code: "not_found" },
  };
  if (!/^[A-Za-z0-9-]{1,64}$/.test(messageId)) return notFound;
  const { data, error } = await supabase
    .from("messages")
    .select(
      "id, status, template_name, meta_message_id, error_detail, metadata, created_at, status_updated_at",
    )
    .eq("id", messageId)
    .eq("organization_id", caller.organizationId)
    .eq("metadata->>source", "api")
    .maybeSingle();
  // A malformed id is a database error too: answered as not found.
  if (error || !data) return notFound;
  const row = data as ApiMessageRow;
  const meta = row.metadata ?? {};
  return {
    status: 200,
    body: {
      message_id: row.id,
      status: publicStatus(row.status),
      to: typeof meta["to"] === "string" ? meta["to"] : null,
      template_name: row.template_name,
      idempotency_key: typeof meta["idempotency_key"] === "string" ? meta["idempotency_key"] : null,
      wamid: row.meta_message_id,
      error: publicError(row.status, row.error_detail),
      created_at: row.created_at,
      updated_at: row.status_updated_at ?? row.created_at,
    },
  };
}
