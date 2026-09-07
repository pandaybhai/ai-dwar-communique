/**
 * The owner's own chat with Aiden.
 *
 * Everything that arrives on the platform's onboarding number comes from a
 * business owner setting Aiden up, never from one of their customers. So this
 * path deliberately skips opt-out keywords, cash-on-delivery replies,
 * automations and the customer-facing AI: none of them mean anything here.
 *
 * The chat lives in the platform organization's inbox (that is whose number it
 * is), while the thinking, the knowledge and the run record belong to the
 * owner's own workspace.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "@/lib/phone";
import { sendServiceText } from "@/lib/service-text.server";

export type OnboardingSession = {
  id: string;
  organization_id: string;
  user_id: string;
  phone: string;
  wa_id: string | null;
  code: string;
  status: string;
  source_id: string | null;
};

const CODE_PATTERN = /AD-[A-Z0-9]{4}/i;

/** What we say to someone who writes in without a workspace behind them. */
const STRANGER_REPLY =
  "Hi! I'm Aiden from AiDwar. Sign up at aidwar.in first, then send me your code and I'll get started.";

const STRANGER_QUIET_MS = 24 * 60 * 60 * 1000;

const SESSION_COLUMNS = "id, organization_id, user_id, phone, wa_id, code, status, source_id";

/** The session this message belongs to: by code first, then by number. */
async function findSession(
  supabase: SupabaseClient,
  waId: string,
  body: string,
): Promise<OnboardingSession | null> {
  const match = body.match(CODE_PATTERN);
  if (match) {
    const { data } = await supabase
      .from("onboarding_sessions")
      .select(SESSION_COLUMNS)
      .eq("code", match[0].toUpperCase())
      .maybeSingle();
    const byCode = data as OnboardingSession | null;
    if (byCode && byCode.status !== "expired") return byCode;
  }

  // No code, or a code we don't know: fall back to the number they gave us
  // when they signed up. Newest first, so a fresh attempt wins.
  const { data: rows } = await supabase
    .from("onboarding_sessions")
    .select(SESSION_COLUMNS)
    .eq("phone", normalizePhone(waId))
    .not("status", "in", '("completed","expired")')
    .order("created_at", { ascending: false })
    .limit(1);
  return ((rows ?? []) as OnboardingSession[])[0] ?? null;
}

/** Don't repeat ourselves at someone who isn't signed up. */
async function shouldGreetStranger(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("messages")
    .select("created_at")
    .eq("conversation_id", conversationId)
    .eq("direction", "outbound")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const last = (data as { created_at?: string } | null)?.created_at;
  if (!last) return true;
  return Date.now() - new Date(last).getTime() > STRANGER_QUIET_MS;
}

export async function handleMerchantInbound(
  supabase: SupabaseClient,
  args: {
    /** The platform organization that owns the onboarding number. */
    organizationId: string;
    accountId: string;
    phoneNumberId: string;
    accessToken: string;
    waId: string;
    conversationId: string;
    contactId: string;
    body: string;
  },
): Promise<void> {
  const body = (args.body ?? "").trim();
  const reply = (text: string) =>
    sendServiceText(supabase, {
      organizationId: args.organizationId,
      phoneNumberId: args.phoneNumberId,
      accessToken: args.accessToken,
      conversationId: args.conversationId,
      to: args.waId,
      body: text,
    });

  const session = await findSession(supabase, args.waId, body);

  if (!session) {
    if (await shouldGreetStranger(supabase, args.conversationId)) await reply(STRANGER_REPLY);
    return;
  }

  // Bind the session to this number the first time they write, and record
  // every inbound so a nudge job can tell who has gone quiet.
  await supabase
    .from("onboarding_sessions")
    .update({
      wa_id: args.waId,
      ...(session.status === "pending" ? { status: "bound" } : {}),
      last_inbound_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", session.id);

  // A website link is the fastest way to teach him, so it is handled plainly
  // rather than left to the model.
  const link = body.match(/https?:\/\/[^\s]+/i)?.[0] ?? null;
  if (link && !session.source_id) {
    const { addWebsiteSource } = await import("@/lib/knowledge.server");
    const added = await addWebsiteSource(supabase, session.organization_id, link, session.user_id);
    if (added.sourceId) {
      await supabase
        .from("onboarding_sessions")
        .update({ source_id: added.sourceId, status: "learning", updated_at: new Date().toISOString() })
        .eq("id", session.id);
    }
    await reply(
      added.ok
        ? `Got it — I've read ${added.itemCount} page${added.itemCount === 1 ? "" : "s"} from your website. Ask me something a customer would ask and I'll answer from it.`
        : "I couldn't read that page. Send me the link again, or tell me about your business in your own words.",
    );
    return;
  }

  if (!body) return;

  const [{ data: org }, { data: profile }] = await Promise.all([
    supabase.from("organizations").select("name").eq("id", session.organization_id).maybeSingle(),
    supabase.from("profiles").select("full_name").eq("id", session.user_id).maybeSingle(),
  ]);

  const { merchantAnswer } = await import("@/lib/ai-tasks.server");
  const run = await merchantAnswer(
    supabase,
    { organizationId: session.organization_id, actorUserId: session.user_id },
    {
      conversationId: args.conversationId,
      question: body,
      session: {
        id: session.id,
        organization_id: session.organization_id,
        user_id: session.user_id,
        business_name: (org as { name?: string } | null)?.name ?? null,
        owner_name: (profile as { full_name?: string } | null)?.full_name ?? null,
      },
    },
  );

  const text = (run.output ?? "").trim();
  await reply(
    text ||
      "I'm having trouble thinking just now. Give me a minute and ask me again — someone from the AiDwar team is watching this chat too.",
  );

  if (!session.first_sourced_run_id && run.id) {
    await supabase
      .from("onboarding_sessions")
      .update({ first_sourced_run_id: run.id, updated_at: new Date().toISOString() })
      .eq("id", session.id)
      .is("first_sourced_run_id", null);
  }
}
