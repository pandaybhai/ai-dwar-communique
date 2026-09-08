/**
 * When Aiden doesn't know, he asks the owner — and never guesses.
 *
 * A customer question the material can't answer becomes a row in
 * pending_owner_replies plus a message to the owner on the AiDwar number. The
 * owner's next message is the answer: it goes back to the customer on their
 * own business number and is remembered for good.
 *
 * Owners with several businesses get a list to choose from, and every message
 * on the AiDwar number is prefixed with the business it is about.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
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
};

const PENDING_COLUMNS =
  "id, organization_id, owner_phone, conversation_id, contact_id, question, source, selected_at";

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

  const { data: profiles } = await supabase.from("profiles").select("id").eq("phone", phone);
  const userIds = ((profiles ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (userIds.length > 0) {
    const { data: members } = await supabase
      .from("organization_members")
      .select("organization_id")
      .in("user_id", userIds);
    for (const row of (members ?? []) as Array<{ organization_id: string }>) {
      ids.add(row.organization_id);
    }
  }

  return Array.from(ids);
}

/** "[Chai Point] " when this owner runs more than one business, else "". */
export function prefixFor(multiBusiness: boolean, businessName: string | null): string {
  if (!multiBusiness) return "";
  const name = (businessName ?? "").trim();
  return name ? `[${name}] ` : "";
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
  const account = accountRow as
    | { id: string; organization_id: string; phone_number_id: string }
    | null;
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
  const { connection } = await getWhatsAppConnection(
    supabase,
    account.organization_id,
    account.id,
  );
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
 * A customer asked something the material doesn't answer. Record it and put
 * the question in front of the owner on the AiDwar number. When their 24-hour
 * window is closed the row is still written — nothing is lost.
 */
export async function pingOwnerForAnswer(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    conversationId: string;
    contactId: string | null;
    question: string;
    aiRunId: string | null;
  },
): Promise<{ recorded: boolean; sent: boolean }> {
  const ownerPhone = await ownerPhoneFor(supabase, args.organizationId);
  if (!ownerPhone) return { recorded: false, sent: false };

  const { error } = await supabase.from("pending_owner_replies").insert({
    organization_id: args.organizationId,
    owner_phone: ownerPhone,
    conversation_id: args.conversationId,
    contact_id: args.contactId,
    question: args.question.slice(0, 1000),
    ai_run_id: args.aiRunId,
    source: "customer",
  });
  if (error) {
    console.error("[owner-ping] insert failed", error.message);
    return { recorded: false, sent: false };
  }

  const channel = await onboardingChannelFor(supabase, ownerPhone);
  if (!channel) return { recorded: true, sent: false };

  const [{ data: conversation }, names, orgs] = await Promise.all([
    supabase
      .from("conversations")
      .select("whatsapp_account_id")
      .eq("id", args.conversationId)
      .maybeSingle(),
    orgNames(supabase, [args.organizationId]),
    ownerOrganizationIds(supabase, ownerPhone),
  ]);

  let businessNumber = "your business number";
  const accountId = (conversation as { whatsapp_account_id?: string | null } | null)
    ?.whatsapp_account_id;
  if (accountId) {
    const { data: account } = await supabase
      .from("whatsapp_accounts")
      .select("display_phone_number")
      .eq("id", accountId)
      .maybeSingle();
    businessNumber =
      (account as { display_phone_number?: string | null } | null)?.display_phone_number ||
      businessNumber;
  }

  const prefix = prefixFor(orgs.length > 1, names.get(args.organizationId) ?? null);
  const sent = await sendServiceText(supabase, {
    ...channel,
    body:
      `${prefix}A customer on ${businessNumber} asked: "${args.question.slice(0, 400)}". ` +
      "Reply here with the answer and I'll send it to them now.",
  });
  return { recorded: true, sent: sent.ok };
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
  });
  if (error) console.error("[owner-ping] onboarding insert failed", error.message);
}

/** Send the owner's answer on to the customer who asked. */
async function deliverToCustomer(
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
  const conversation = conversationRow as
    | {
        id: string;
        organization_id: string;
        contact_id: string | null;
        whatsapp_account_id: string | null;
        last_customer_message_at: string | null;
      }
    | null;
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
 * The owner has written on the AiDwar number while something was waiting for
 * them. Returns true when this message was consumed as an answer or a choice,
 * so the onboarding state machine is left alone.
 */
export async function handleOwnerReply(
  supabase: SupabaseClient,
  args: {
    ownerPhone: string;
    body: string;
    interactiveId: string | null;
    reply: (text: string) => Promise<unknown>;
    list: (
      body: string,
      rows: Array<{ id: string; title: string; description?: string }>,
    ) => Promise<unknown>;
    multiBusiness: boolean;
  },
): Promise<boolean> {
  const pending = await loadPendingReplies(supabase, args.ownerPhone);
  if (pending.length === 0) return false;

  const names = await orgNames(
    supabase,
    pending.map((p) => p.organization_id),
  );

  // Picking a question from the list: the next plain message answers it.
  if (args.interactiveId) {
    const chosen = pending.find((p) => p.id === args.interactiveId);
    if (chosen) {
      await supabase
        .from("pending_owner_replies")
        .update({ selected_at: new Date().toISOString() })
        .eq("id", chosen.id);
      const name = names.get(chosen.organization_id) ?? "your business";
      await args.reply(
        `${prefixFor(args.multiBusiness, name)}Reply here with the answer to: "${chosen.question.slice(0, 300)}"`,
      );
      return true;
    }
  }

  const answer = args.body.trim();
  if (!answer) return false;

  let target: PendingReply | null = null;
  if (pending.length === 1) target = pending[0]!;
  else target = pending.find((p) => p.selected_at) ?? null;

  if (!target) {
    await args.list(
      "You have a few questions waiting. Which one are you answering?",
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

  const name = names.get(target.organization_id) ?? null;
  await args.reply(
    `${prefixFor(args.multiBusiness, name)}` +
      (delivered ? "Sent. I'll remember that for next time." : "Saved — I'll remember that."),
  );
  return true;
}
