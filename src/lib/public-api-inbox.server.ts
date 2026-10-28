import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiCaller } from "@/lib/public-api.server";
import {
  decodeCursor,
  encodeCursor,
  fail,
  validId,
  type ApiReply,
} from "@/lib/public-api-route.server";

/**
 * Batch 38 item 2: the inbox from the merchant's own software.
 *
 *   GET  /api/v1/conversations                    status / assignee / updated_since, cursor
 *   POST /api/v1/conversations/{phone}/assign     { assignee: email | user id | null }
 *   POST /api/v1/conversations/{phone}/close
 *   POST /api/v1/conversations/{phone}/reopen
 *   POST /api/v1/conversations/{phone}/tags       { add: [...], remove: [...] }
 *
 * The inbox makes these changes from the browser (inbox-view.tsx
 * handleAssign / handleToggleStatus, chat-thread.tsx applyTags): the same
 * column writes are made here — conversations.assigned_to /
 * conversations.status, the customer's tags in tags / contact_tags — with
 * the same activity log actions (conversation_assigned,
 * conversation_closed; conversation_reopened for a reopen, which the inbox
 * doesn't log) carrying source "api" and the key id, and the same analytics
 * events (conversation.assigned, conversation.closed) through emitEvent.
 *
 * {phone} is the customer's number (any formatting; normalizePhone); it
 * names the customer's most recent conversation in the key's workspace.
 * Another workspace's customer is the same 404 as one that doesn't exist.
 * An assignee must be a member of the workspace. Never logs a key or a body.
 */

export const MAX_INBOX_REQUEST_BYTES = 64 * 1024;
export const DEFAULT_LIST = 25;
export const MAX_LIST = 100;
const STATUSES = ["open", "closed", "pending"];

/** Read with the columns every database has (conversations.updated_at comes with 20261160). */
const CONVERSATION_COLUMNS =
  "id, organization_id, contact_id, whatsapp_account_id, status, assigned_to, last_message_at, last_customer_message_at, unread_count, needs_human, created_at";

type ConversationRow = Record<string, unknown>;
type ContactRow = { id: string; phone: string; name: string | null; opt_in_status: string | null };

const notFound = () =>
  fail(404, "not_found", "There is no conversation with this customer in this workspace.");

/** A conversation as the API shows it. */
export function publicConversation(
  row: ConversationRow,
  contact: ContactRow | null,
  assignee: { id: string; email: string | null } | null,
  tags: string[],
): Record<string, unknown> {
  return {
    conversation_id: row["id"],
    phone: contact?.phone ?? null,
    contact: contact
      ? {
          name: contact.name ?? null,
          phone: contact.phone,
          opt_in_status: contact.opt_in_status ?? null,
        }
      : null,
    status: row["status"] ?? null,
    assignee: assignee ? { user_id: assignee.id, email: assignee.email } : null,
    needs_human: row["needs_human"] === true,
    whatsapp_account_id: row["whatsapp_account_id"] ?? null,
    unread_count: Number(row["unread_count"] ?? 0),
    last_message_at: row["last_message_at"] ?? null,
    last_customer_message_at: row["last_customer_message_at"] ?? null,
    created_at: row["created_at"] ?? null,
    updated_at: row["changed_at"] ?? row["last_message_at"] ?? row["created_at"] ?? null,
    tags,
  };
}

// ------------------------------------------------------------ lookups

/** Emails of these users (profiles), for the members the API names. */
async function emailsOf(
  supabase: SupabaseClient,
  ids: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (!ids.length) return out;
  const { data } = await supabase.from("profiles").select("id, email").in("id", ids);
  for (const p of (data ?? []) as Array<{ id: string; email: string | null }>)
    out.set(p.id, p.email ?? null);
  return out;
}

/** Tag names per contact, in this workspace. */
async function tagsOf(
  supabase: SupabaseClient,
  organizationId: string,
  contactIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!contactIds.length) return out;
  const { data: links } = await supabase
    .from("contact_tags")
    .select("contact_id, tag_id")
    .eq("organization_id", organizationId)
    .in("contact_id", contactIds);
  const rows = (links ?? []) as Array<{ contact_id: string; tag_id: string }>;
  const tagIds = Array.from(new Set(rows.map((r) => r.tag_id)));
  if (!tagIds.length) return out;
  const { data: tags } = await supabase
    .from("tags")
    .select("id, name")
    .eq("organization_id", organizationId)
    .in("id", tagIds);
  const names = new Map(
    ((tags ?? []) as Array<{ id: string; name: string }>).map((t) => [t.id, t.name]),
  );
  for (const r of rows) {
    const name = names.get(r.tag_id);
    if (!name) continue;
    out.set(
      r.contact_id,
      [...(out.get(r.contact_id) ?? []), name].sort((a, b) => a.localeCompare(b)),
    );
  }
  return out;
}

/**
 * A member of this workspace by email (any case) or user id. Null when the
 * person isn't a member — whatever else they are elsewhere.
 */
export async function findMember(
  supabase: SupabaseClient,
  organizationId: string,
  who: string,
): Promise<{ id: string; email: string | null } | null> {
  const { data: members, error } = await supabase
    .from("organization_members")
    .select("user_id")
    .eq("organization_id", organizationId)
    .limit(500);
  if (error) throw new Error(error.message);
  const ids = ((members ?? []) as Array<{ user_id: string }>).map((m) => m.user_id);
  if (!ids.length) return null;
  const emails = await emailsOf(supabase, ids);
  const wanted = who.trim().toLowerCase();
  if (wanted.includes("@")) {
    const id = ids.find((m) => (emails.get(m) ?? "").toLowerCase() === wanted);
    return id ? { id, email: emails.get(id) ?? null } : null;
  }
  return ids.includes(who.trim())
    ? { id: who.trim(), email: emails.get(who.trim()) ?? null }
    : null;
}

/** The customer's most recent conversation in this workspace, with the contact. */
async function conversationForPhone(
  supabase: SupabaseClient,
  organizationId: string,
  rawPhone: string,
): Promise<{ row: ConversationRow; contact: ContactRow } | null> {
  const { normalizePhone, toWaId } = await import("@/lib/phone");
  let text = rawPhone;
  try {
    text = decodeURIComponent(rawPhone);
  } catch {
    // not encoded
  }
  const phone = normalizePhone(text);
  const digits = toWaId(phone);
  if (digits.length < 8 || digits.length > 15) return null;
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, phone, name, opt_in_status")
    .eq("organization_id", organizationId)
    .eq("phone", phone)
    .maybeSingle();
  if (!contact) return null;
  const c = contact as ContactRow;
  const { data } = await supabase
    .from("conversations")
    .select(CONVERSATION_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("contact_id", c.id)
    .order("last_message_at", { ascending: false })
    .limit(1);
  const row = ((data ?? []) as ConversationRow[])[0];
  return row ? { row, contact: c } : null;
}

async function shown(
  supabase: SupabaseClient,
  organizationId: string,
  conversationId: string,
  contact: ContactRow,
): Promise<Record<string, unknown>> {
  const { data } = await supabase
    .from("conversations")
    .select(CONVERSATION_COLUMNS)
    .eq("id", conversationId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const row = (data ?? {}) as ConversationRow;
  const assignedTo = typeof row["assigned_to"] === "string" ? (row["assigned_to"] as string) : null;
  const emails = await emailsOf(supabase, assignedTo ? [assignedTo] : []);
  const tags = await tagsOf(supabase, organizationId, [contact.id]);
  return publicConversation(
    row,
    contact,
    assignedTo ? { id: assignedTo, email: emails.get(assignedTo) ?? null } : null,
    tags.get(contact.id) ?? [],
  );
}

async function log(
  supabase: SupabaseClient,
  caller: ApiCaller,
  action: string,
  details: Record<string, unknown>,
): Promise<void> {
  const { logServerActivity } = await import("@/lib/whatsapp-api.server");
  await logServerActivity(supabase, caller.organizationId, null, action, {
    ...details,
    source: "api",
    api_key_id: caller.keyId,
  });
}

// ------------------------------------------------------------ actions

/** POST /api/v1/conversations/{phone}/assign — { assignee: email | user id | null }. */
export async function assignConversation(
  supabase: SupabaseClient,
  caller: ApiCaller,
  phone: string,
  raw: unknown,
): Promise<ApiReply> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("assignee" in (raw as object)))
    return fail(
      400,
      "invalid_assignee",
      "`assignee` is required: a team member's email or user id, or null to unassign.",
    );
  const value = (raw as Record<string, unknown>)["assignee"];
  if (value !== null && (typeof value !== "string" || !value.trim() || value.length > 320))
    return fail(
      400,
      "invalid_assignee",
      "`assignee` must be a team member's email or user id, or null to unassign.",
    );
  const found = await conversationForPhone(supabase, caller.organizationId, phone);
  if (!found) return notFound();

  let assignee: { id: string; email: string | null } | null = null;
  if (typeof value === "string") {
    assignee = await findMember(supabase, caller.organizationId, value);
    if (!assignee)
      return fail(
        400,
        "assignee_not_member",
        "That person isn't a member of this workspace. Invite them in AiDwar first.",
      );
  }
  const conversationId = String(found.row["id"]);
  const { error } = await supabase
    .from("conversations")
    .update({ assigned_to: assignee?.id ?? null })
    .eq("id", conversationId)
    .eq("organization_id", caller.organizationId);
  if (error)
    return fail(503, "unavailable", "We couldn't update the assignment. Please try again.");

  await log(supabase, caller, "conversation_assigned", {
    conversation_id: conversationId,
    assigned_to: assignee?.id ?? null,
  });
  const { emitEvent } = await import("@/lib/events.server");
  await emitEvent(supabase, "conversation.assigned", {
    organizationId: caller.organizationId,
    entityType: "conversation",
    entityId: conversationId,
    whatsappAccountId: (found.row["whatsapp_account_id"] as string | null) ?? null,
    properties: { assigned_to: assignee?.id ?? null, source: "api" },
  });
  return {
    status: 200,
    body: {
      conversation: await shown(supabase, caller.organizationId, conversationId, found.contact),
    },
  };
}

/** POST /api/v1/conversations/{phone}/close and /reopen. Already in that state: the same 200, nothing logged. */
export async function setConversationStatus(
  supabase: SupabaseClient,
  caller: ApiCaller,
  phone: string,
  next: "open" | "closed",
): Promise<ApiReply> {
  const found = await conversationForPhone(supabase, caller.organizationId, phone);
  if (!found) return notFound();
  const conversationId = String(found.row["id"]);
  if (found.row["status"] !== next) {
    const { error } = await supabase
      .from("conversations")
      .update({ status: next })
      .eq("id", conversationId)
      .eq("organization_id", caller.organizationId);
    if (error)
      return fail(503, "unavailable", "We couldn't update this conversation. Please try again.");
    if (next === "closed") {
      await log(supabase, caller, "conversation_closed", { conversation_id: conversationId });
      const { emitEvent } = await import("@/lib/events.server");
      await emitEvent(supabase, "conversation.closed", {
        organizationId: caller.organizationId,
        entityType: "conversation",
        entityId: conversationId,
        whatsappAccountId: (found.row["whatsapp_account_id"] as string | null) ?? null,
        properties: { source: "api" },
      });
    } else {
      await log(supabase, caller, "conversation_reopened", { conversation_id: conversationId });
    }
  }
  return {
    status: 200,
    body: {
      conversation: await shown(supabase, caller.organizationId, conversationId, found.contact),
    },
  };
}

/**
 * POST /api/v1/conversations/{phone}/tags — { add: [...], remove: [...] } on
 * the customer's tags (the inbox's "Labels"), through the Contacts API's own
 * changeContactTags (Batch 37): the same checks, the same tags / contact_tags
 * writes, the same updated_at bump a contacts sync sees. A tag that doesn't
 * exist yet is created on add; removing one the customer doesn't have is
 * fine. Names match without regard to case.
 */
export async function changeConversationTags(
  supabase: SupabaseClient,
  caller: ApiCaller,
  phone: string,
  raw: unknown,
): Promise<ApiReply> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return fail(400, "invalid_tags", 'Send { "add": [...], "remove": [...] }.');
  const body = raw as Record<string, unknown>;
  const add = body["add"] ?? [];
  const remove = body["remove"] ?? [];
  if (!Array.isArray(add) || !Array.isArray(remove))
    return fail(400, "invalid_tags", "`add` and `remove` must be arrays of tag names.");
  if (!add.length && !remove.length)
    return fail(400, "invalid_tags", "Name at least one tag to `add` or `remove`.");
  const found = await conversationForPhone(supabase, caller.organizationId, phone);
  if (!found) return notFound();

  const { changeContactTags } = await import("@/lib/public-api-contacts.server");
  for (const [action, tags] of [
    ["add", add],
    ["remove", remove],
  ] as const) {
    if (!tags.length) continue;
    const changed = await changeContactTags(supabase, caller, found.contact.phone, action, tags);
    if (changed.status !== 200) return changed;
  }
  await log(supabase, caller, "contact_tags_changed", {
    conversation_id: found.row["id"],
    contact_id: found.contact.id,
    added: add,
    removed: remove,
  });
  return {
    status: 200,
    body: {
      conversation: await shown(
        supabase,
        caller.organizationId,
        String(found.row["id"]),
        found.contact,
      ),
    },
  };
}

// ------------------------------------------------------------ list

/**
 * GET /api/v1/conversations?status=&assignee=&updated_since=&limit=&cursor=
 * — oldest change first, so a caller can keep up by asking for what changed
 * since its last call. Read by api_list_conversations (20261160); before it
 * is applied this answers 503 unavailable.
 */
export async function listConversations(
  supabase: SupabaseClient,
  caller: ApiCaller,
  params: URLSearchParams,
): Promise<ApiReply> {
  const orgId = caller.organizationId;
  const status = params.get("status");
  if (status && !STATUSES.includes(status))
    return fail(400, "invalid_status", `\`status\` must be one of ${STATUSES.join(", ")}.`);
  const limitRaw = params.get("limit");
  const limit = limitRaw ? Number(limitRaw) : DEFAULT_LIST;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST)
    return fail(400, "invalid_limit", `\`limit\` must be 1–${MAX_LIST}.`);
  const since = params.get("updated_since");
  if (since && Number.isNaN(Date.parse(since)))
    return fail(400, "invalid_updated_since", "`updated_since` must be an ISO date and time.");
  const cursor = decodeCursor(params.get("cursor"));
  if (cursor === "invalid") return fail(400, "invalid_cursor", "`cursor` isn't one this API gave.");

  let assignedTo: string | null | undefined;
  const assignee = params.get("assignee");
  if (assignee) {
    if (assignee === "none") assignedTo = null;
    else {
      const member = await findMember(supabase, orgId, assignee);
      if (!member)
        return fail(
          400,
          "assignee_not_member",
          "`assignee` must be a member's email or user id, or none.",
        );
      assignedTo = member.id;
    }
  }

  const { data, error } = await supabase.rpc("api_list_conversations", {
    p_org: orgId,
    p_limit: limit + 1,
    p_after_at: cursor ? cursor.at : null,
    p_after_id: cursor ? cursor.id : null,
    p_status: status,
    p_assignee: assignedTo ?? null,
    p_unassigned: assignedTo === null,
    p_changed_since: since ? new Date(since).toISOString() : null,
  });
  // No function (20261160 not applied) or a failed read: never a wrong list.
  if (error)
    return fail(
      503,
      "unavailable",
      "Listing conversations isn't available yet. Please try again later.",
    );
  const rows = (data ?? []) as ConversationRow[];
  const page = rows.slice(0, limit);
  const contactIds = Array.from(
    new Set(page.map((r) => String(r["contact_id"] ?? "")).filter(validId)),
  );
  const contacts = new Map<string, ContactRow>();
  if (contactIds.length) {
    const { data: cs } = await supabase
      .from("contacts")
      .select("id, phone, name, opt_in_status")
      .eq("organization_id", orgId)
      .in("id", contactIds);
    for (const c of (cs ?? []) as ContactRow[]) contacts.set(c.id, c);
  }
  const assignees = Array.from(
    new Set(page.map((r) => r["assigned_to"]).filter((v): v is string => typeof v === "string")),
  );
  const emails = await emailsOf(supabase, assignees);
  const tags = await tagsOf(supabase, orgId, contactIds);
  const last = page[page.length - 1];
  return {
    status: 200,
    body: {
      conversations: page.map((r) => {
        const contactId = String(r["contact_id"] ?? "");
        const a = typeof r["assigned_to"] === "string" ? (r["assigned_to"] as string) : null;
        return publicConversation(
          r,
          contacts.get(contactId) ?? null,
          a ? { id: a, email: emails.get(a) ?? null } : null,
          tags.get(contactId) ?? [],
        );
      }),
      next_cursor:
        rows.length > limit && last
          ? encodeCursor(String(last["changed_at"]), String(last["id"]))
          : null,
    },
  };
}
