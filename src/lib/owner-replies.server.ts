/**
 * Questions waiting on the owner, and the owner's answers on the AiDwar number.
 *
 * Aiden's Unanswered items (recordCustomerGap) are quiet: they are filed for
 * the dashboard only and never enter the owner's WhatsApp waiting list
 * (notify 'silent'; the list reads only notify 'ping', and since Batch 35
 * nothing writes 'ping'). An answer reaches a customer only when the owner
 * explicitly picked that one waiting item (selected_at) — never because it
 * happened to be the only one open, and never from an ordinary message.
 *
 * Owners with several businesses get a list to choose from, and every message
 * on the AiDwar number is prefixed with the business it is about.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getScript } from "@/lib/scripts.server";
import { normalizePhone } from "@/lib/phone";
import { sendServiceText, sendServiceList } from "@/lib/service-text.server";
import { isServiceWindowOpen } from "@/lib/service-window";

export type PendingReply = {
  id: string;
  organization_id: string;
  owner_phone: string;
  conversation_id: string | null;
  contact_id: string | null;
  question: string;
  source: string;
  selected_at: string | null;
  created_at: string;
  reminded_at: string | null;
};

const PENDING_COLUMNS =
  "id, organization_id, owner_phone, conversation_id, contact_id, question, source, selected_at, created_at, reminded_at";

export type OnboardingChannel = {
  organizationId: string;
  phoneNumberId: string;
  accessToken: string;
  conversationId: string;
  to: string;
};

/** Everything still waiting on this owner, most recently picked first. */
export async function loadPendingReplies(
  supabase: SupabaseClient,
  ownerPhone: string,
): Promise<PendingReply[]> {
  const { data } = await supabase
    .from("pending_owner_replies")
    .select(PENDING_COLUMNS)
    .eq("owner_phone", normalizePhone(ownerPhone))
    .eq("status", "pending")
    // Silent gaps live on the Unanswered tab only: never the owner's WhatsApp
    // waiting list, never a "Still waiting on your answer".
    .eq("notify", "ping")
    // Only a customer's question can be answered to a customer.
    .eq("source", "customer")
    .order("selected_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(10);
  return (data ?? []) as PendingReply[];
}

/** Workspace names, for list rows and the "[Business] " prefix. */
export async function orgNames(
  supabase: SupabaseClient,
  ids: string[],
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids)).filter(Boolean);
  if (unique.length === 0) return new Map();
  const { data } = await supabase.from("organizations").select("id, name").in("id", unique);
  const map = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ id: string; name: string | null }>) {
    map.set(row.id, (row.name ?? "").trim() || "your business");
  }
  return map;
}

/**
 * The workspaces this phone belongs to. More than one means every message
 * needs to say which business it is about.
 */
export async function ownerOrganizationIds(
  supabase: SupabaseClient,
  ownerPhone: string,
): Promise<string[]> {
  const phone = normalizePhone(ownerPhone);
  const ids = new Set<string>();

  const { data: sessions } = await supabase
    .from("onboarding_sessions")
    .select("organization_id")
    .eq("phone", phone);
  for (const row of (sessions ?? []) as Array<{ organization_id: string }>) {
    ids.add(row.organization_id);
  }

  for (const id of await memberOrganizationIds(supabase, phone)) ids.add(id);

  return Array.from(ids);
}

/**
 * The workspaces this phone is an owner or member of, by the phone on their
 * profile (organization_members) — not by onboarding sessions, which a code
 * that lapsed also leaves behind. Batch 28: a known owner whose setup sessions
 * all expired is still an owner on the AiDwar number, never a stranger.
 */
export async function memberOrganizationIds(supabase: SupabaseClient, phoneOrWaId: string): Promise<string[]> {
  const phone = normalizePhone(phoneOrWaId);
  if (!phone) return [];
  const { data: profiles } = await supabase.from("profiles").select("id").eq("phone", phone);
  const userIds = ((profiles ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (userIds.length === 0) return [];
  const { data: members } = await supabase
    .from("organization_members")
    .select("organization_id")
    .in("user_id", userIds);
  return [...new Set(((members ?? []) as Array<{ organization_id: string }>).map((r) => r.organization_id))];
}

/** "[Chai Point] " when this owner runs more than one business, else "". */
export function prefixFor(multiBusiness: boolean, businessName: string | null): string {
  if (!multiBusiness) return "";
  const name = (businessName ?? "").trim();
  return name ? `[${name}] ` : "";
}

/**
 * Put the "[Business] " prefix on exactly once. Any leading "[...] " the text
 * already carries (the model copies it from the transcript) is dropped first.
 */
export function withPrefix(prefix: string, text: string): string {
  let body = text ?? "";
  if (prefix) {
    const tag = prefix.trim();
    while (body.trimStart().startsWith(tag)) body = body.trimStart().slice(tag.length).trimStart();
  }
  return prefix + body;
}

/** The owner's number: the oldest owner on the workspace, then the signup. */
export async function ownerPhoneFor(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<string | null> {
  const { data: members } = await supabase
    .from("organization_members")
    .select("user_id, role, created_at")
    .eq("organization_id", organizationId)
    .eq("role", "owner")
    .order("created_at", { ascending: true })
    .limit(1);
  const userId = ((members ?? []) as Array<{ user_id: string }>)[0]?.user_id ?? null;
  if (userId) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("phone")
      .eq("id", userId)
      .maybeSingle();
    const phone = normalizePhone((profile as { phone?: string | null } | null)?.phone ?? "");
    if (phone) return phone;
  }

  const { data: sessions } = await supabase
    .from("onboarding_sessions")
    .select("phone")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(1);
  const fallback = normalizePhone(((sessions ?? []) as Array<{ phone: string }>)[0]?.phone ?? "");
  return fallback || null;
}

/**
 * The AiDwar number's side of the conversation with one owner. Null when the
 * platform has no onboarding number, or has never spoken to this owner.
 */
export async function onboardingChannelFor(
  supabase: SupabaseClient,
  ownerPhone: string,
): Promise<OnboardingChannel | null> {
  const phone = normalizePhone(ownerPhone);
  if (!phone) return null;

  const { data: setting } = await supabase
    .from("platform_settings")
    .select("onboarding_whatsapp_account_id")
    .maybeSingle();
  const accountId =
    (setting as { onboarding_whatsapp_account_id?: string | null } | null)
      ?.onboarding_whatsapp_account_id ?? null;
  if (!accountId) return null;

  const { data: accountRow } = await supabase
    .from("whatsapp_accounts")
    .select("id, organization_id, phone_number_id")
    .eq("id", accountId)
    .maybeSingle();
  const account = accountRow as {
    id: string;
    organization_id: string;
    phone_number_id: string;
  } | null;
  if (!account) return null;

  const { data: contact } = await supabase
    .from("contacts")
    .select("id")
    .eq("organization_id", account.organization_id)
    .eq("phone", phone)
    .maybeSingle();
  if (!contact) return null;

  const { data: conversation } = await supabase
    .from("conversations")
    .select("id")
    .eq("organization_id", account.organization_id)
    .eq("contact_id", (contact as { id: string }).id)
    .eq("whatsapp_account_id", account.id)
    .order("last_message_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!conversation) return null;

  const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
  const { connection } = await getWhatsAppConnection(supabase, account.organization_id, account.id);
  const accessToken = connection?.accessToken ?? "";
  if (!accessToken) return null;

  return {
    organizationId: account.organization_id,
    phoneNumberId: account.phone_number_id,
    accessToken,
    conversationId: conversation.id as string,
    to: phone.replace(/\D/g, ""),
  };
}

/**
 * A customer got a helpful answer, but part of it needed the owner. File it
 * under Unanswered and say nothing to anyone: no ping, no template, no
 * message. The owner picks it up in their own time.
 */
export async function recordCustomerGap(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    conversationId: string;
    contactId: string | null;
    question: string;
    aiRunId: string | null;
  },
): Promise<boolean> {
  const ownerPhone = (await ownerPhoneFor(supabase, args.organizationId)) ?? "";
  const { error } = await supabase.from("pending_owner_replies").insert({
    organization_id: args.organizationId,
    owner_phone: ownerPhone,
    conversation_id: args.conversationId,
    contact_id: args.contactId,
    question: args.question.slice(0, 1000),
    ai_run_id: args.aiRunId,
    source: "customer",
    notify: "silent",
  });
  if (error) {
    console.error("[owner-gap] insert failed", error.message);
    return false;
  }
  return true;
}

/** Record a question the owner asked in their own chat that we couldn't answer. */
export async function recordOnboardingGap(
  supabase: SupabaseClient,
  args: { organizationId: string; ownerPhone: string; question: string; aiRunId: string | null },
): Promise<void> {
  const phone = normalizePhone(args.ownerPhone);
  if (!phone) return;
  const { error } = await supabase.from("pending_owner_replies").insert({
    organization_id: args.organizationId,
    owner_phone: phone,
    question: args.question.slice(0, 1000),
    ai_run_id: args.aiRunId,
    source: "onboarding",
    notify: "silent",
  });
  if (error) console.error("[owner-ping] onboarding insert failed", error.message);
}

/** Send the owner's answer on to the customer who asked. */
export async function deliverToCustomer(
  supabase: SupabaseClient,
  pending: PendingReply,
  answer: string,
): Promise<boolean> {
  if (pending.source !== "customer" || !pending.conversation_id) return false;

  const { data: conversationRow } = await supabase
    .from("conversations")
    .select("id, organization_id, contact_id, whatsapp_account_id, last_customer_message_at")
    .eq("id", pending.conversation_id)
    .maybeSingle();
  const conversation = conversationRow as {
    id: string;
    organization_id: string;
    contact_id: string | null;
    whatsapp_account_id: string | null;
    last_customer_message_at: string | null;
  } | null;
  if (!conversation || !isServiceWindowOpen(conversation)) return false;

  const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
  const { connection } = await getWhatsAppConnection(
    supabase,
    conversation.organization_id,
    conversation.whatsapp_account_id,
  );
  if (!connection?.accessToken || !connection.phoneNumberId) return false;

  const { data: contact } = await supabase
    .from("contacts")
    .select("phone")
    .eq("id", conversation.contact_id ?? "")
    .maybeSingle();
  const to = String((contact as { phone?: string } | null)?.phone ?? "").replace(/\D/g, "");
  if (!to) return false;

  const sent = await sendServiceText(supabase, {
    organizationId: conversation.organization_id,
    phoneNumberId: connection.phoneNumberId,
    accessToken: connection.accessToken,
    conversationId: conversation.id,
    to,
    body: answer,
  });

  if (sent.ok) {
    await supabase
      .from("conversations")
      .update({ needs_human: false, needs_human_reason: null, handover_state: null })
      .eq("id", conversation.id)
      .eq("organization_id", conversation.organization_id);
  }
  return sent.ok;
}

/**
 * The open questions for this owner, with anything older than the teaching
 * window closed off first. Callers decide what to do with them.
 */
export async function openPendingReplies(
  supabase: SupabaseClient,
  ownerPhone: string,
): Promise<PendingReply[]> {
  const { teachWindowExpired } = await import("@/lib/teach-guard");
  const loaded = await loadPendingReplies(supabase, ownerPhone);
  if (loaded.length === 0) return [];

  const stale = loaded.filter((p) => teachWindowExpired(p.selected_at ?? p.created_at));
  if (stale.length > 0) {
    await supabase
      .from("pending_owner_replies")
      .update({ status: "expired" })
      .in(
        "id",
        stale.map((p) => p.id),
      );
  }
  return loaded.filter((p) => !stale.includes(p));
}

type ReplyFns = {
  reply: (text: string) => Promise<unknown>;
  list: (
    body: string,
    rows: Array<{ id: string; title: string; description?: string }>,
  ) => Promise<unknown>;
};

/**
 * The owner tapped one of the waiting questions. Their next plain message is
 * the answer to that one. Returns true when the tap was one of ours.
 */
export async function handleOwnerPick(
  supabase: SupabaseClient,
  args: { ownerPhone: string; interactiveId: string } & ReplyFns,
): Promise<boolean> {
  const pending = await openPendingReplies(supabase, args.ownerPhone);
  const chosen = pending.find((p) => p.id === args.interactiveId);
  if (!chosen) return false;

  await supabase
    .from("pending_owner_replies")
    .update({ selected_at: new Date().toISOString() })
    .eq("id", chosen.id);
  await args.reply(`Reply here with the answer to: "${chosen.question.slice(0, 300)}"`);
  return true;
}

/**
 * A plain message from the owner while something is waiting on them. It only
 * counts as an answer when exactly one question is open (or they picked one),
 * and only when it reads like an answer rather than a tap or a new question.
 */
export async function handleOwnerAnswer(
  supabase: SupabaseClient,
  args: {
    ownerPhone: string;
    body: string;
    /** The three questions we offered as taps: never an answer. */
    suggestions?: string[];
  } & ReplyFns,
): Promise<boolean> {
  const { isSkipWord, isTeachableAnswer } = await import("@/lib/teach-guard");

  const pending = await openPendingReplies(supabase, args.ownerPhone);
  if (pending.length === 0) return false;

  const answer = args.body.trim();
  if (!answer) return false;

  // "skip" calls the question off rather than answering it.
  if (isSkipWord(answer)) {
    const target = pending.find((p) => p.selected_at) ?? pending[0]!;
    await supabase.from("pending_owner_replies").update({ status: "expired" }).eq("id", target.id);
    await args.reply("Skipped.");
    return true;
  }

  // Another question, or a bare "ok", is not an answer. Leave the row open,
  // mention it once, and let the message be handled as ordinary chat.
  if (!isTeachableAnswer(answer, { suggestions: args.suggestions ?? [] })) {
    const target = pending.find((p) => p.selected_at) ?? pending[0]!;
    if (!target.reminded_at) {
      await supabase
        .from("pending_owner_replies")
        .update({ reminded_at: new Date().toISOString() })
        .eq("id", target.id);
      await args.reply(
        `Still waiting on your answer for "${target.question.slice(0, 200)}" — reply whenever.`,
      );
    }
    return false;
  }

  // Batch 35: only an item the owner explicitly picked is answered — even
  // when it is the only one open, the owner taps it first. Never a guess.
  const target = pending.find((p) => p.selected_at) ?? null;
  if (!target) {
    const names = await orgNames(
      supabase,
      pending.map((p) => p.organization_id),
    );
    await args.list(
      "Which one is this for?",
      pending.map((p) => ({
        id: p.id,
        title: (names.get(p.organization_id) ?? "Question").slice(0, 24),
        description: p.question.slice(0, 72),
      })),
    );
    return true;
  }

  const { saveCorrection } = await import("@/lib/knowledge.server");
  await saveCorrection(supabase, target.organization_id, {
    question: target.question,
    answer,
    userId: null,
  });

  const delivered = await deliverToCustomer(supabase, target, answer);

  await supabase
    .from("pending_owner_replies")
    .update({ status: "answered", answer, answered_at: new Date().toISOString() })
    .eq("id", target.id);

  await args.reply(
    delivered ? "Sent. I'll remember that for next time." : await getScript(supabase, "fact_saved"),
  );
  return true;
}

/**
 * Batch 35: whether this owner was just told, on the AiDwar number, that a
 * customer is waiting (a hand-off alert in the last 24 hours on a chat still
 * with a person). Their next plain message is then probably meant for that
 * customer, so it is never saved as a business fact for everyone. A failed
 * read counts as yes — holding a fact back is the safe side.
 */
export async function ownerToldOfWaitingCustomer(
  supabase: SupabaseClient,
  organizationId: string,
  ownerPhone: string,
): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("conversations")
    .select("id, handoff_alert_result")
    .eq("organization_id", organizationId)
    .eq("needs_human", true)
    .gte("handoff_alert_at", since)
    .limit(20);
  if (error) return true;
  const owner = normalizePhone(ownerPhone);
  return ((data ?? []) as Array<{ handoff_alert_result?: { whatsapp?: unknown } | null }>).some((row) => {
    const told = row.handoff_alert_result?.whatsapp;
    // An alert recorded before handoff_alert_result existed: assume the owner was told.
    if (!Array.isArray(told)) return true;
    return told.some((p) => normalizePhone(String(p)) === owner);
  });
}
