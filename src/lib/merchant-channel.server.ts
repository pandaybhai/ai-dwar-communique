/**
 * The owner's own chat with Aiden — day one on WhatsApp.
 *
 * Everything that arrives on the platform's onboarding number comes from a
 * business owner setting Aiden up, never from one of their customers. So this
 * path deliberately skips opt-out keywords, cash-on-delivery replies,
 * automations and the customer-facing AI: none of them mean anything here.
 *
 * The chat lives in the platform organization's inbox (that is whose number it
 * is), while the thinking, the knowledge and the run record belong to the
 * owner's own workspace.
 *
 * Every step sends a picture card. A card is decoration only: when one fails
 * to render the same words still go out as plain text.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "@/lib/phone";
import { sendServiceText, sendServiceImage, sendServiceButtons } from "@/lib/service-text.server";

export type OnboardingSession = {
  id: string;
  organization_id: string;
  user_id: string;
  phone: string;
  wa_id: string | null;
  code: string;
  status: string;
  step: string | null;
  source_id: string | null;
  pending_question: string | null;
};

const CODE_PATTERN = /AD-[A-Z0-9]{4}/i;

/** What we say to someone who writes in without a workspace behind them. */
const STRANGER_REPLY =
  "Hi! I'm Aiden from AiDwar. Sign up at aidwar.in first, then send me your code and I'll get started.";

/** When there is nothing behind an answer we ask instead of inventing one. */
const NO_SOURCE_REPLY =
  "I couldn't find that on your website yet. Tell me the answer here and I'll remember it for your customers.";

const STRANGER_QUIET_MS = 24 * 60 * 60 * 1000;

const SESSION_COLUMNS =
  "id, organization_id, user_id, phone, wa_id, code, status, step, source_id, pending_question";

// --------------------------------------------------------------- formatting

const IST = "Asia/Kolkata";

/** "7 Sep 2026" */
function istDate(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: IST,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(at);
}

/** "17:51" */
function istTime(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: IST,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
}

// ------------------------------------------------------------------ session

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

async function patchSession(
  supabase: SupabaseClient,
  sessionId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await supabase
    .from("onboarding_sessions")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", sessionId);
}

/** The page titles this owner's website gave us, newest crawl. */
async function pageTitles(
  supabase: SupabaseClient,
  sourceId: string | null,
): Promise<string[]> {
  if (!sourceId) return [];
  const { data } = await supabase
    .from("knowledge_documents")
    .select("title")
    .eq("source_id", sourceId)
    .limit(20);
  return ((data ?? []) as Array<{ title: string | null }>)
    .map((r) => (r.title ?? "").trim())
    .filter((t) => t.length > 0);
}

/**
 * Page titles as a person would say them: the bit before the site name,
 * trimmed to something that fits in a caption. At most five.
 */
function shortTitles(titles: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of titles) {
    let t = raw.split(/\s+[—|]\s+/)[0]?.trim() ?? "";
    if (!t) continue;
    if (t.length > 24) t = `${t.slice(0, 23).trimEnd()}…`;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length === 5) break;
  }
  return out;
}


// ------------------------------------------------------------------ inbound

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

  const channel = {
    organizationId: args.organizationId,
    phoneNumberId: args.phoneNumberId,
    accessToken: args.accessToken,
    conversationId: args.conversationId,
    to: args.waId,
  };
  const reply = (text: string) => sendServiceText(supabase, { ...channel, body: text });
  const replyButtons = (
    text: string,
    buttons: Array<{ id: string; title: string }>,
    imageUrl: string | null,
  ) =>
    sendServiceButtons(supabase, {
      ...channel,
      body: text,
      buttons,
      imageUrl,
    });

  const session = await findSession(supabase, args.waId, body);

  if (!session) {
    if (await shouldGreetStranger(supabase, args.conversationId)) await reply(STRANGER_REPLY);
    return;
  }

  // Bind the session to this number the first time they write, and record
  // every inbound so a nudge job can tell who has gone quiet. The owner's name
  // and business are needed by almost every branch below, so they're fetched
  // alongside rather than after.
  const [, { data: org }, { data: profile }] = await Promise.all([
    supabase
      .from("onboarding_sessions")
      .update({
        wa_id: args.waId,
        ...(session.status === "pending" ? { status: "bound" } : {}),
        last_inbound_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", session.id),
    supabase.from("organizations").select("name").eq("id", session.organization_id).maybeSingle(),
    supabase.from("profiles").select("full_name").eq("id", session.user_id).maybeSingle(),
  ]);

  const businessName = (org as { name?: string } | null)?.name ?? "";
  const ownerName = (profile as { full_name?: string } | null)?.full_name ?? "";
  const firstName = ownerName.split(" ")[0] || "there";

  // If a previous inbound is still being crawled, don't start a second crawl
  // or ask the model questions until it finishes.
  if (session.status === "learning") {
    await reply("Still reading — one moment.");
    return;
  }

  const { renderCard } = await import("@/lib/onboarding-cards.server");

  // The update above may have just moved pending -> bound, so use the effective status.
  const currentStatus = session.status === "pending" ? "bound" : session.status;

  // ---------------------------------------------------------- the website
  const link = body.match(/https?:\/\/[^\s]+/i)?.[0] ?? null;
  if (link && !session.source_id) {
    let host = link;
    try {
      host = new URL(link).hostname;
    } catch {
      // keep the raw link in the copy if it isn't parseable
    }

    // Mark learning immediately so any concurrent inbound gets the "still
    // reading" reply while the crawl is in progress.
    await patchSession(supabase, session.id, { status: "learning", step: "reading" });

    const readingCaption = `Reading ${host} now. Go grab a chai — I'll ping you in 2 minutes with everything I learned.`;
    const notebook = await renderCard(supabase, "notebook", {
      sessionId: session.id,
      vars: {
        site_host: host,
        now_time: istTime(),
        line_1: "Home",
        line_2: "About",
        line_3: "Products",
        line_4: "Contact",
        page_n: 1,
        page_total: "?",
        progress_pct: 10,
      },
    });
    if (notebook) {
      await sendServiceImage(supabase, { ...channel, imageUrl: notebook, caption: readingCaption });
    } else {
      await reply(readingCaption);
    }

    const { addWebsiteSource } = await import("@/lib/knowledge.server");
    const added = await addWebsiteSource(supabase, session.organization_id, link, session.user_id);

    if (!added.ok || !added.sourceId || !added.itemCount) {
      // Nothing readable came back: leave the session waiting for another link
      // and say so in our own words, never in the crawler's.
      await patchSession(supabase, session.id, { status: "bound", step: "await_site" });
      await reply(
        "I couldn't read anything useful from that link. Send another link, or tell me in a few lines what you sell and where you deliver.",
      );
      return;
    }


    await patchSession(supabase, session.id, {
      source_id: added.sourceId,
      status: "ready",
      step: "answering",
    });

    const [titles, first] = await Promise.all([
      pageTitles(supabase, added.sourceId),
      (async () => {
        const { merchantFirstBrief } = await import("@/lib/ai-tasks.server");
        return merchantFirstBrief(supabase, {
          organizationId: session.organization_id,
          userId: session.user_id,
          sourceId: added.sourceId!,
          businessName,
        });
      })(),
    ]);

    const titleLine = shortTitles(titles).join(", ");
    const doneBody =
      `Done. I read ${added.itemCount} page${added.itemCount === 1 ? "" : "s"}${titleLine ? ` — ${titleLine}` : ""}.\n\n` +
      `Here's what I know about ${businessName || "your business"} now. Below are three things a customer might ask you today. Tap one, or ask your own.`;

    const briefCard = await renderCard(supabase, "brief", {
      sessionId: session.id,
      vars: {
        business_name: businessName || "your business",
        site_host: host,
        pages_read: added.itemCount,
        now_time: istTime(),
        fact_1: first.facts[0] ?? "",
        fact_2: first.facts[1] ?? "",
        fact_3: first.facts[2] ?? "",
      },
    });

    await replyButtons(
      doneBody,
      first.questions.slice(0, 3).map((q, i) => ({ id: `q${i + 1}`, title: q.slice(0, 20) })),
      briefCard,
    );
    return;
  }

  if (!body) return;

  // ------------------------------------------------- the "connect" button
  if (/^connect my whatsapp$/i.test(body)) {
    await reply(
      "Open Settings → WhatsApp in your dashboard and tap Connect — takes a minute. I'll message you here the moment it's live.\n\nhttps://aidwar.in/app/settings",
    );
    return;
  }

  // ------------------------------------------------------- meeting Aiden
  if (currentStatus === "bound" && session.step !== "await_site") {
    const idCard = await renderCard(supabase, "id-card", {
      sessionId: session.id,
      vars: {
        owner_first_name: firstName,
        business_name: businessName || "your business",
        joined_date: istDate(),
        session_code: session.code,
      },
    });

    await replyButtons(
      `${firstName}, meet Aiden. From today he works for ${businessName || "your business"} — answering your customers on WhatsApp, day and night, no leave, no attitude.\n\nHe hasn't read a word about you yet. Let's fix that.`,
      [{ id: "start", title: "Your own AI employee" }],
      idCard,
    );
    await patchSession(supabase, session.id, { status: "bound", step: "await_site" });
    return;
  }

  // Waiting for the link: anything that isn't one gets the same nudge.
  if (currentStatus === "bound" || session.step === "await_site") {
    await reply(
      `Send me your website link. Give me 2 minutes with it and I'll know ${businessName || "your business"} the way a good new hire knows it on day one — what you sell, what you charge, how you deliver.`,
    );
    return;
  }

  // ------------------------------------------------------------ answering
  if (currentStatus !== "ready" && currentStatus !== "tested") return;

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
        business_name: businessName || null,
        owner_name: ownerName || null,
      },
    },
  );

  // The model sometimes copies the transcript's speaker prefix into its answer.
  const text = (run.output ?? "").trim().replace(/^\s*aiden\s*(:|—|-)\s*/i, "").trim();
  await reply(
    text ||
      "I'm having trouble thinking just now. Give me a minute and ask me again — someone from the AiDwar team is watching this chat too.",
  );

  // First real answer on a workspace that already has its starter credits:
  // the credits card, once only.
  if (currentStatus === "ready") {
    const { data: credit } = await supabase
      .from("wallet_ledger")
      .select("id, created_at")
      .eq("organization_id", session.organization_id)
      .eq("entry_type", "starter_credits")
      .limit(1)
      .maybeSingle();

    const ledger = credit as { id: string; created_at?: string } | null;
    if (ledger) {
      await patchSession(supabase, session.id, {
        status: "tested",
        step: "await_connect",
        first_sourced_run_id: run.runId,
      });

      const grantedAt = ledger.created_at ? new Date(ledger.created_at) : new Date();
      const creditsCard = await renderCard(supabase, "credits", {
        sessionId: session.id,
        vars: {
          business_name: businessName || "your business",
          granted_at: `${istDate(grantedAt)}, ${istTime(grantedAt)} IST`,
          ledger_ref: `WLT-${ledger.id.slice(0, 5).toUpperCase()}`,
        },
      });

      await replyButtons(
        "That answer came from your website, not a script. So here's my first day's work, on the house: ₹100 credits, about 700 customer conversations.\n\nReady to put me on your number?",
        [{ id: "connect", title: "Connect my WhatsApp" }],
        creditsCard,
      );
    }
  }
}

// ---------------------------------------------------------- number connects

/**
 * The owner has just connected their own WhatsApp number. Close the loop in
 * the onboarding chat and, when the balance allows it, actually switch Aiden
 * on. Called from the Embedded Signup exchange; never blocks it.
 */
export async function handleNumberConnected(
  supabase: SupabaseClient,
  args: { organizationId: string; accountId: string; displayNumber: string | null },
): Promise<void> {
  const { data: sessionRow } = await supabase
    .from("onboarding_sessions")
    .select(SESSION_COLUMNS)
    .eq("organization_id", args.organizationId)
    .in("status", ["tested", "connected"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const session = sessionRow as OnboardingSession | null;
  if (!session || !session.wa_id) return;

  await patchSession(supabase, session.id, {
    connected_account_id: args.accountId,
    status: "connected",
  });

  // The onboarding number this owner has been talking to.
  const { data: setting } = await supabase
    .from("platform_settings")
    .select("onboarding_whatsapp_account_id")
    .maybeSingle();
  const onboardingAccountId =
    (setting as { onboarding_whatsapp_account_id?: string | null } | null)
      ?.onboarding_whatsapp_account_id ?? null;
  if (!onboardingAccountId) return;

  const { data: accountRow } = await supabase
    .from("whatsapp_accounts")
    .select("id, organization_id, phone_number_id")
    .eq("id", onboardingAccountId)
    .maybeSingle();
  const account = accountRow as
    | { id: string; organization_id: string; phone_number_id: string }
    | null;
  if (!account) return;

  const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
  const { connection } = await getWhatsAppConnection(
    supabase,
    account.organization_id,
    account.id,
  );
  const accessToken = connection?.accessToken ?? "";
  if (!accessToken) return;

  const { data: contact } = await supabase
    .from("contacts")
    .select("id")
    .eq("organization_id", account.organization_id)
    .eq("phone", normalizePhone(session.wa_id))
    .maybeSingle();
  if (!contact) return;

  const { data: conversation } = await supabase
    .from("conversations")
    .select("id")
    .eq("organization_id", account.organization_id)
    .eq("contact_id", (contact as { id: string }).id)
    .eq("whatsapp_account_id", account.id)
    .order("last_message_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!conversation) return;

  const channel = {
    organizationId: account.organization_id,
    phoneNumberId: account.phone_number_id,
    accessToken,
    conversationId: (conversation as { id: string }).id,
    to: session.wa_id,
  };

  // Switching him on is guarded in the database on the workspace balance.
  const { error: modeError } = await supabase
    .from("ai_agents")
    .update({ mode: "replying" })
    .eq("organization_id", args.organizationId);

  if (modeError) {
    await sendServiceText(supabase, {
      ...channel,
      body: "I'm connected but not switched on yet — add credits or pick a plan and I'll start.",
    });
    return;
  }

  const [{ count: pagesRead }, { count: answersGiven }] = await Promise.all([
    supabase
      .from("knowledge_documents")
      .select("id", { count: "exact", head: true })
      .eq("source_id", session.source_id ?? "00000000-0000-0000-0000-000000000000"),
    supabase
      .from("ai_runs")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", args.organizationId),
  ]);

  const number = args.displayNumber ?? "your number";
  const caption =
    `I'm on duty at ${number}. Message it from your own phone and watch me work.\n\n` +
    "When I'm not sure, I hand over to you. I never guess.";

  const { data: org } = await supabase
    .from("organizations")
    .select("name")
    .eq("id", args.organizationId)
    .maybeSingle();

  const { renderCard } = await import("@/lib/onboarding-cards.server");
  const card = await renderCard(supabase, "on-duty", {
    sessionId: session.id,
    vars: {
      business_name: (org as { name?: string } | null)?.name ?? "your business",
      connected_number: number,
      live_since: `Today, ${istTime()}`,
      pages_read: pagesRead ?? 0,
      answers_given: answersGiven ?? 0,
    },
  });

  if (card) {
    await sendServiceImage(supabase, { ...channel, imageUrl: card, caption });
  } else {
    await sendServiceText(supabase, { ...channel, body: caption });
  }

  await patchSession(supabase, session.id, {
    status: "completed",
    step: "done",
    completed_at: new Date().toISOString(),
  });
}
