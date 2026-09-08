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
import {
  sendServiceText,
  sendServiceImage,
  sendServiceButtons,
  sendServiceList,
} from "@/lib/service-text.server";
import {
  handleOwnerReply,
  onboardingChannelFor,
  ownerOrganizationIds,
  orgNames,
  prefixFor,
  recordOnboardingGap,
} from "@/lib/owner-replies.server";

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
  pending_asked_at: string | null;
  suggested_questions: string[] | null;

};

const CODE_PATTERN = /AD-[A-Z0-9]{4}/i;

/** What we say to someone who writes in without a workspace behind them. */
const STRANGER_REPLY =
  "Hi! I'm Aiden from AiDwar. Sign up at aidwar.in first, then send me your code and I'll get started.";

/** When there is nothing behind an answer we ask instead of inventing one. */
const NO_SOURCE_REPLY =
  "I couldn't find that on your website yet. Tell me the answer here and I'll remember it for your customers.";

/**
 * Questions about AiDwar's own plans — never about the owner's own prices,
 * which are exactly what they test the AI with ("What is the price?").
 */
const UPGRADE_INTENT =
  /\b(upgrade|subscribe|subscription|paid plan|buy (a |the )?plan|choose (a |the |my )?plan|pick (a |the |my )?plan|your (plans?|pricing|prices|rates)|aidwar('s)? (plans?|pricing|price|cost|charges?)|how much (do you|does aidwar|will you) (cost|charge)|what (do you|does aidwar) (cost|charge)|after (the |my )?trial|trial (ends?|over|expire))\b/i;

const STRANGER_QUIET_MS = 24 * 60 * 60 * 1000;

const SESSION_COLUMNS =
  "id, organization_id, user_id, phone, wa_id, code, status, step, source_id, pending_question, pending_asked_at, suggested_questions";


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

/**
 * A website link the owner typed. People write "talentdwar.com" far more often
 * than they write the scheme, so a bare domain counts as a link everywhere.
 */
export function extractSiteLink(body: string): string | null {
  const withScheme = body.match(/https?:\/\/[^\s]+/i)?.[0];
  if (withScheme) return withScheme;
  for (const token of body.split(/\s+/)) {
    const candidate = token.replace(/^[("'<]+|[)"'>.,;!]+$/g, "");
    if (!candidate || candidate.includes("@")) continue;
    if (/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}(?:\/\S*)?$/i.test(candidate)) {
      return `https://${candidate}`;
    }
  }
  return null;
}

/** The session this message belongs to: by code first, then by number. */
async function findSession(
  supabase: SupabaseClient,
  waId: string,
  body: string,
): Promise<{ session: OnboardingSession | null; byCode: boolean }> {
  const match = body.match(CODE_PATTERN);
  if (match) {
    const { data } = await supabase
      .from("onboarding_sessions")
      .select(SESSION_COLUMNS)
      .eq("code", match[0].toUpperCase())
      .maybeSingle();
    const byCode = data as OnboardingSession | null;
    if (byCode && byCode.status !== "expired") return { session: byCode, byCode: true };
  }

  // No code, or a code we don't know: fall back to the number they gave us
  // when they signed up. Newest first, so a fresh attempt wins.
  const { data: rows } = await supabase
    .from("onboarding_sessions")
    .select(SESSION_COLUMNS)
    .eq("phone", normalizePhone(waId))
    .not("status", "in", '("completed","expired")')
    .order("last_inbound_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(1);
  return { session: ((rows ?? []) as OnboardingSession[])[0] ?? null, byCode: false };
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

/** A question, by shape or by opening word — in English and in Hinglish. */
function looksLikeQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (t.endsWith("?")) return true;
  return /^(what|where|when|why|who|which|how|is|are|do|does|did|can|could|should|will|would|tell me|kya|kitna|kitne|kab|kaise|kahan|kaun)\b/.test(
    t,
  );
}

/**
 * One inbound message from an owner, taken in a strict order. Each stage that
 * matches answers and returns: a code is never a fact, a link is never an
 * answer, a tap is never teaching. Getting this order wrong is how the
 * notebook gets poisoned, so nothing here falls through by accident.
 */
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
    /** button_reply.id / list_reply.id, when they tapped instead of typed. */
    interactiveId?: string | null;
    /** "meta:<id>" when they sent a picture or a document. */
    mediaUrl?: string | null;
    mediaMime?: string | null;
    /** The document's filename, when Meta sent one. */
    mediaName?: string | null;
  },
): Promise<void> {
  const body = (args.body ?? "").trim();
  const interactiveId = args.interactiveId ?? null;

  const channel = {
    organizationId: args.organizationId,
    phoneNumberId: args.phoneNumberId,
    accessToken: args.accessToken,
    conversationId: args.conversationId,
    to: args.waId,
  };

  // Stage 9: the business prefix is applied here and nowhere else, so a
  // message can never come out as "[Shiva] [Shiva] …".
  let prefix = "";
  const reply = (text: string) => sendServiceText(supabase, { ...channel, body: prefix + text });
  const replyButtons = (
    text: string,
    buttons: Array<{ id: string; title: string }>,
    imageUrl: string | null,
  ) => sendServiceButtons(supabase, { ...channel, body: prefix + text, buttons, imageUrl });
  const replyList = (
    text: string,
    rows: Array<{ id: string; title: string; description?: string }>,
  ) => sendServiceList(supabase, { ...channel, body: prefix + text, buttonText: "Choose", rows });

  // Which businesses this number speaks for. More than one and every message
  // says which one it is about.
  const ownerOrgs = await ownerOrganizationIds(supabase, args.waId);
  const multiBusiness = ownerOrgs.length > 1;

  // ------------------------------------------------ whose chat this is
  const { session, byCode } = await findSession(supabase, args.waId, body);

  if (!session) {
    if (await shouldGreetStranger(supabase, args.conversationId)) await reply(STRANGER_REPLY);
    return;
  }

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
  prefix = prefixFor(multiBusiness, businessName || null);

  // The update above may have just moved pending -> bound.
  const currentStatus = session.status === "pending" ? "bound" : session.status;

  const { renderCard } = await import("@/lib/onboarding-cards.server");

  /** The Day One script: meeting Aiden, then asking for the website. */
  const dayOneStep = async (): Promise<void> => {
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
    await reply(
      `Send me your website link. Give me 2 minutes with it and I'll know ${businessName || "your business"} the way a good new hire knows it on day one — what you sell, what you charge, how you deliver.`,
    );
  };

  const answering = currentStatus === "ready" || currentStatus === "tested";

  // If a previous inbound is still being read, nothing else may start.
  if (session.status === "learning") {
    await reply("Still reading — one moment.");
    return;
  }

  // ---------------------------------------------------------- 1. THE CODE
  // A code is never a question, an answer or a fact. It binds or switches,
  // says so, and stops.
  if (byCode && !interactiveId) {
    if (currentStatus === "bound" && session.step !== "await_site") {
      await dayOneStep();
      return;
    }
    await reply(
      `Connected — we're on ${businessName || "your business"} now. Ask me anything about it.`,
    );
    return;
  }

  // ------------------------------------------------------ 2. CONTROL WORDS
  const { controlWord, isBareReference } = await import("@/lib/teach-guard");
  const control = !interactiveId && !args.mediaUrl ? controlWord(body) : null;
  if (control) {
    if (control === "skip") {
      const { openPendingReplies } = await import("@/lib/owner-replies.server");
      const open = await openPendingReplies(supabase, args.waId);
      const target = open.find((p) => p.selected_at) ?? open[0] ?? null;
      if (target) {
        await supabase
          .from("pending_owner_replies")
          .update({ status: "expired" })
          .eq("id", target.id);
      }
      await reply("Skipped.");
      return;
    }
    if (control === "help") {
      await reply(
        "I read your website, your photos and your files, then answer your customers from them. Send me a link or a picture, ask me anything about your business, or tell me a fact and I'll remember it.",
      );
      return;
    }
    if (control === "greeting" && multiBusiness) {
      const { data: sessionRows } = await supabase
        .from("onboarding_sessions")
        .select(SESSION_COLUMNS)
        .eq("phone", normalizePhone(args.waId))
        .not("status", "in", '("completed","expired")');
      const choices = (sessionRows ?? []) as OnboardingSession[];
      if (choices.length > 1) {
        const names = await orgNames(supabase, choices.map((c) => c.organization_id));
        await sendServiceList(supabase, {
          ...channel,
          body: "Which business are we working on?",
          buttonText: "Choose",
          rows: choices.map((c) => ({
            id: `sess:${c.id}`,
            title: (names.get(c.organization_id) ?? "Business").slice(0, 24),
          })),
        });
        return;
      }
    }
    if (!answering) {
      await dayOneStep();
      return;
    }
    await reply(
      control === "test"
        ? "Go on then — ask me anything one of your customers would ask."
        : control === "greeting"
          ? `Here and ready. Ask me anything about ${businessName || "your business"}.`
          : "Got it.",
    );
    return;
  }

  // -------------------------------------- 3. A PICTURE, A FILE, A VOICE NOTE
  if (args.mediaUrl?.startsWith("meta:")) {
    const mime = (args.mediaMime ?? "").toLowerCase();
    const mediaId = args.mediaUrl.slice(5);

    // A voice note is just the owner talking: once it is words it re-enters
    // this pipeline from the top, so a transcript with a code in it binds and
    // a transcript that is a link gets crawled.
    if (mime.startsWith("audio/")) {
      const { fetchMetaMedia, transcribeAudio } = await import("@/lib/ai-media.server");
      const file = await fetchMetaMedia(mediaId, args.accessToken);
      if (!file) {
        await reply("That voice note didn't come through. Send it again?");
        return;
      }
      const heard = await transcribeAudio(
        supabase,
        session.organization_id,
        file.bytes,
        file.mime ?? args.mediaMime ?? null,
      );
      if (!heard.text) {
        await reply("I couldn't make out that voice note. Could you type it, or try once more?");
        return;
      }
      await supabase
        .from("messages")
        .update({ body: heard.text })
        .eq("organization_id", args.organizationId)
        .eq("conversation_id", args.conversationId)
        .eq("media_url", args.mediaUrl)
        .eq("direction", "inbound");
      await handleMerchantInbound(supabase, {
        ...args,
        body: heard.text,
        interactiveId: null,
        mediaUrl: null,
        mediaMime: null,
        mediaName: null,
      });
      return;
    }

    const kind = mime.startsWith("image/")
      ? "image"
      : mime.includes("pdf")
        ? "pdf"
        : mime.includes("wordprocessingml")
          ? "docx"
          : mime.includes("sheet") || mime.includes("csv") || mime.includes("excel")
            ? "spreadsheet"
            : null;

    if (!kind) {
      await reply(
        "I can read pictures, PDFs, Word files, spreadsheets and voice notes. Send me one of those.",
      );
      return;
    }

    const { ensureUploadSource, ingestUpload } = await import("@/lib/knowledge.server");
    const source = await ensureUploadSource(supabase, session.organization_id, session.user_id);
    if (!source) {
      await reply("I couldn't keep that just now. Send it again in a moment.");
      return;
    }

    // The same file twice in five minutes is a WhatsApp retry or a slip of the
    // thumb, not new material.
    const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    if (await seenRecently(supabase, source.id, { media_id: mediaId }, recent)) {
      await reply("Already have that one.");
      return;
    }

    await reply("Reading it…");

    // Reading is platform-paid; on a free trial it stays under the day-0 cap.
    const [{ data: orgRow }, { data: platform }] = await Promise.all([
      supabase
        .from("organizations")
        .select("plan_status")
        .eq("id", session.organization_id)
        .maybeSingle(),
      supabase.from("platform_settings").select("day0_crawl_cost_cap").maybeSingle(),
    ]);
    const onTrial = (orgRow as { plan_status?: string } | null)?.plan_status !== "active";
    const costCap = Number(
      (platform as { day0_crawl_cost_cap?: number } | null)?.day0_crawl_cost_cap ?? 2,
    );
    if (onTrial && source.cost_amount >= costCap) {
      await reply(
        "I've used up today's free reading allowance. Send this again tomorrow, or pick a plan at https://aidwar.in/app/billing and I'll read it straight away.",
      );
      return;
    }

    const { fetchMetaMedia, TRANSCRIBE_COST } = await import("@/lib/ai-media.server");
    const file = await fetchMetaMedia(mediaId, args.accessToken);
    if (!file) {
      await reply("That file didn't come through. Send it again and I'll read it.");
      return;
    }

    const label =
      (args.mediaName ?? "").trim() ||
      (kind === "image"
        ? "photo"
        : `${kind === "spreadsheet" ? "sheet" : kind.toUpperCase()} you sent`);
    const fileName =
      kind === "image" && !args.mediaName ? `Photo from ${new Date().toDateString()}` : label;

    const firstMaterial = !session.source_id;
    if (firstMaterial) {
      await patchSession(supabase, session.id, { status: "learning", source_id: source.id });
    }
    const ingested = await ingestUpload(
      supabase,
      session.organization_id,
      source.id,
      fileName,
      file.bytes,
      kind,
      {
        mime: file.mime ?? args.mediaMime ?? null,
        extra: { media_id: mediaId, file: fileName },
        refPrefix: mediaId,
        channel: "onboarding",
      },
    );

    // Vision runs are metered on ai_usage; the source keeps a running total
    // so the trial cap above has something to compare against.
    if (kind === "image") {
      await supabase
        .from("knowledge_sources")
        .update({ cost_amount: source.cost_amount + TRANSCRIBE_COST })
        .eq("id", source.id);
    }

    // The same words as something we read minutes ago: drop the copy.
    if (ingested.ok && ingested.contentHash) {
      const duplicate = await seenRecently(
        supabase,
        source.id,
        { content_sha: ingested.contentHash },
        recent,
      );
      await stampHash(supabase, source.id, mediaId, ingested.contentHash);
      if (duplicate) {
        await supabase
          .from("knowledge_documents")
          .delete()
          .eq("source_id", source.id)
          .like("source_ref", `${mediaId}:%`);
        if (firstMaterial) await patchSession(supabase, session.id, { status: "ready", step: "answering" });
        await reply("Already have that one.");
        return;
      }
    }

    if (firstMaterial) {
      await finishOnboardingCrawl(supabase, source.id, ingested);
    } else {
      const items = ingested.factCount || ingested.itemCount;
      await reply(
        ingested.ok
          ? `Got it — I now know ${items} item${items === 1 ? "" : "s"} from ${kind === "image" ? "your photo" : label}.`
          : "Couldn't read that one — try a clearer photo or a PDF.",
      );
    }
    return;
  }

  // ------------------------------------------------------------- 4. A LINK
  // A website address is always something to read, never a fact and never an
  // answer to an open question.
  const link = !interactiveId ? extractSiteLink(body) : null;
  if (link) {
    let host = link;
    try {
      host = new URL(link).hostname;
    } catch {
      // keep the raw link in the copy if it isn't parseable
    }

    const firstSite = !session.source_id;
    if (firstSite) {
      await patchSession(supabase, session.id, { status: "learning", step: "reading" });
    }

    const readingCaption = firstSite
      ? `Reading ${host} now. Go grab a chai — I'll ping you in 2 minutes with everything I learned.`
      : `Reading ${host} now — I'll add whatever I find to what I already know.`;
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
      await sendServiceImage(supabase, {
        ...channel,
        imageUrl: notebook,
        caption: prefix + readingCaption,
      });
    } else {
      await reply(readingCaption);
    }

    const { addWebsiteSource } = await import("@/lib/knowledge.server");
    const added = await addWebsiteSource(supabase, session.organization_id, link, session.user_id, {
      mode: "day0",
    });

    if (!added.ok || !added.sourceId) {
      if (firstSite) await patchSession(supabase, session.id, { status: "bound", step: "await_site" });
      await reply(
        "I couldn't read anything useful from that link. Send another link, or tell me in a few lines what you sell and where you deliver.",
      );
      return;
    }

    // The reading itself happens in the worker; it sends the brief card when
    // it finishes, so nothing here waits on a website.
    if (firstSite) await patchSession(supabase, session.id, { source_id: added.sourceId });
    return;
  }

  // ------------------------------------------- 5. TAPS: LISTS AND BUTTONS
  if (interactiveId?.startsWith("sess:")) {
    const pickedId = interactiveId.slice(5);
    await patchSession(supabase, pickedId, { last_inbound_at: new Date().toISOString() });
    const { data: picked } = await supabase
      .from("onboarding_sessions")
      .select(SESSION_COLUMNS)
      .eq("id", pickedId)
      .maybeSingle();
    const pickedSession = picked as OnboardingSession | null;
    if (pickedSession) {
      const names = await orgNames(supabase, [pickedSession.organization_id]);
      prefix = prefixFor(multiBusiness, names.get(pickedSession.organization_id) ?? null);
      await reply("Right — ask me anything about this one.");
      return;
    }
  }

  if (interactiveId) {
    const { handleOwnerPick } = await import("@/lib/owner-replies.server");
    const picked = await handleOwnerPick(supabase, {
      ownerPhone: args.waId,
      interactiveId,
      reply: (text) => reply(text),
      list: (text, rows) => replyList(text, rows),
    });
    if (picked) return;
  }

  if (!body) return;

  // The "connect" button, tapped or typed.
  if (interactiveId === "connect" || /^connect my whatsapp$/i.test(body)) {
    await reply(
      "Open Settings → WhatsApp in your dashboard and tap Connect — takes a minute. I'll message you here the moment it's live.\n\nhttps://aidwar.in/app/settings\n\n" +
        "Use a number that isn't on your phone's WhatsApp — a fresh SIM works. Once a number joins the WhatsApp API it leaves the normal app. Your own number stays yours; that's where you and I talk.",
    );
    return;
  }

  if (interactiveId === "start") {
    await dayOneStep();
    return;
  }

  // Anything before the website is still the Day One script.
  if (!answering) {
    await dayOneStep();
    return;
  }

  // ------------------------------------------------------ 6. A TAUGHT ANSWER
  // Only a typed message, only when exactly one question is open, only when it
  // reads like an answer. More than one open and we ask which.
  if (!interactiveId) {
    const { handleOwnerAnswer } = await import("@/lib/owner-replies.server");
    const consumed = await handleOwnerAnswer(supabase, {
      ownerPhone: args.waId,
      body,
      suggestions: session.suggested_questions ?? [],
      reply: (text) => reply(text),
      list: (text, rows) => replyList(text, rows),
    });
    if (consumed) return;
  }

  // An owner on trial asking about OUR plans (not their own prices): point at
  // the billing page. No plan is ever assigned from chat.
  if (!interactiveId && UPGRADE_INTENT.test(body)) {
    const { data: orgRow } = await supabase
      .from("organizations")
      .select("plan_status, plan_version_id")
      .eq("id", session.organization_id)
      .maybeSingle();
    const o = (orgRow ?? {}) as { plan_status?: string | null; plan_version_id?: string | null };
    if (!o.plan_version_id || o.plan_status === "trial" || o.plan_status === "locked") {
      await reply(
        "Plans start at ₹2,499 a month. Pick one and pay in a minute here — I'll keep working the moment it's done:\nhttps://aidwar.in/app/billing",
      );
      return;
    }
  }

  // ---------------------------------------------------------- 8. A FACT
  // Runs before the model only for messages that are plainly not questions,
  // and never on an address, a code or a phone number on its own.
  if (!interactiveId && !looksLikeQuestion(body) && !isBareReference(body)) {
    const { classifyBusinessFact } = await import("@/lib/ai-tasks.server");
    const verdict = await classifyBusinessFact(
      supabase,
      { organizationId: session.organization_id, actorUserId: session.user_id },
      {
        conversationId: args.conversationId,
        message: body,
        businessName: businessName || null,
      },
    );
    if (verdict.isFact) {
      const { saveFact } = await import("@/lib/knowledge.server");
      const saved = await saveFact(supabase, session.organization_id, {
        topic: verdict.topic,
        text: body,
        userId: session.user_id,
      });
      await reply(
        saved.ok
          ? "Saved — I'll remember that."
          : "I couldn't save that just now. Send it again in a moment and I'll keep it.",
      );
      return;
    }
  }

  // ------------------------------------------------------- 7. A QUESTION
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

  // Nothing behind the answer means nothing gets said: no model text ever
  // leaves this branch unless the run succeeded on real material.
  const grounded = run.status === "ok" && run.sources.length > 0;
  // The model sometimes copies the transcript's speaker prefix into its answer.
  const text = grounded
    ? (run.output ?? "").trim().replace(/^\s*aiden\s*(:|—|-)\s*/i, "").trim()
    : "";
  if (!text) {
    await recordOnboardingGap(supabase, {
      organizationId: session.organization_id,
      ownerPhone: args.waId,
      question: body,
      aiRunId: run.runId,
    });
    await reply(NO_SOURCE_REPLY);
    return;
  }
  await reply(text);

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

/** Have we already filed something carrying this marker in the last minutes? */
async function seenRecently(
  supabase: SupabaseClient,
  sourceId: string,
  marker: Record<string, string>,
  since: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("knowledge_documents")
    .select("id")
    .eq("source_id", sourceId)
    .contains("metadata", marker)
    .gte("created_at", since)
    .limit(1);
  return ((data ?? []) as unknown[]).length > 0;
}

/** Remember the fingerprint of what a file said, so a repeat is spotted. */
async function stampHash(
  supabase: SupabaseClient,
  sourceId: string,
  mediaId: string,
  contentHash: string,
): Promise<void> {
  const { data } = await supabase
    .from("knowledge_documents")
    .select("id, metadata")
    .eq("source_id", sourceId)
    .like("source_ref", `${mediaId}:%`);
  for (const row of (data ?? []) as Array<{ id: string; metadata: Record<string, unknown> | null }>) {
    await supabase
      .from("knowledge_documents")
      .update({ metadata: { ...(row.metadata ?? {}), content_sha: contentHash } })
      .eq("id", row.id);
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
    const guard = modeError.message.includes("AI_GUARD:")
      ? modeError.message.split("AI_GUARD:")[1]?.trim()
      : null;
    await sendServiceText(supabase, {
      ...channel,
      body:
        `I'm connected but not switched on yet${guard ? ` — ${guard.replace(/\.$/, "")}` : ""}. ` +
        "Pick a plan or add credits here and I'll start right away:\nhttps://aidwar.in/app/billing",
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

  await sendServiceText(supabase, {
    ...channel,
    body:
      "If a customer asks something that isn't on your site — a price, a date, stock — I won't make it up. " +
      "I'll message you here; reply once and I'll answer them and remember it for good.",
  });

  await patchSession(supabase, session.id, {
    status: "completed",
    step: "done",
    completed_at: new Date().toISOString(),
  });
}


/** The bytes behind an inbound picture or document. Null when Meta says no. */
async function downloadMedia(mediaId: string, accessToken: string): Promise<Uint8Array | null> {
  const { GRAPH_VERSION } = await import("@/lib/whatsapp-api.server");
  const lookup = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = (await lookup.json().catch(() => ({}))) as Record<string, unknown>;
  const url = body["url"] as string | undefined;
  if (!lookup.ok || !url) return null;
  const file = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!file.ok) return null;
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > 8 * 1024 * 1024) return null;
  return new Uint8Array(buffer);
}

// ------------------------------------------------------- the crawl finishes

/**
 * The worker has finished reading an owner's website. This is the second half
 * of the "send me your link" step: it runs minutes later, in a different
 * process, and speaks in the same chat.
 */
export async function finishOnboardingCrawl(
  supabase: SupabaseClient,
  sourceId: string,
  result: { ok: boolean; itemCount: number; error?: string },
): Promise<void> {
  const { data: sessionRow } = await supabase
    .from("onboarding_sessions")
    .select(SESSION_COLUMNS)
    .eq("source_id", sourceId)
    .eq("status", "learning")
    .limit(1)
    .maybeSingle();
  const session = sessionRow as OnboardingSession | null;
  if (!session || !session.wa_id) return;

  const channel = await onboardingChannelFor(supabase, session.wa_id);
  if (!channel) return;

  const [{ data: org }, ownerOrgs] = await Promise.all([
    supabase.from("organizations").select("name").eq("id", session.organization_id).maybeSingle(),
    ownerOrganizationIds(supabase, session.wa_id),
  ]);
  const businessName = (org as { name?: string } | null)?.name ?? "";
  const prefix = prefixFor(ownerOrgs.length > 1, businessName || null);

  // Nothing readable: keep the session waiting for another link, in our words.
  if (!result.ok || result.itemCount === 0) {
    await patchSession(supabase, session.id, {
      status: "bound",
      step: "await_site",
      source_id: null,
    });
    await sendServiceText(supabase, {
      ...channel,
      body:
        prefix +
        "I couldn't read anything useful from that link. Send another link, or tell me in a few lines what you sell and where you deliver.",
    });
    return;
  }

  await patchSession(supabase, session.id, { status: "ready", step: "answering" });

  const [titles, first] = await Promise.all([
    pageTitles(supabase, sourceId),
    (async () => {
      const { merchantFirstBrief } = await import("@/lib/ai-tasks.server");
      return merchantFirstBrief(supabase, {
        organizationId: session.organization_id,
        userId: session.user_id,
        sourceId,
        businessName,
      });
    })(),
  ]);

  const { data: sourceRow } = await supabase
    .from("knowledge_sources")
    .select("name")
    .eq("id", sourceId)
    .maybeSingle();
  const host = (sourceRow as { name?: string } | null)?.name ?? "";

  const titleLine = shortTitles(titles).join(", ");
  const doneBody =
    `Done. I read ${result.itemCount} page${result.itemCount === 1 ? "" : "s"}${titleLine ? ` — ${titleLine}` : ""}.\n\n` +
    `Here's what I know about ${businessName || "your business"} now. Below are three things a customer might ask you today. Tap one, or ask your own.`;

  const { renderCard } = await import("@/lib/onboarding-cards.server");
  const briefCard = await renderCard(supabase, "brief", {
    sessionId: session.id,
    vars: {
      business_name: businessName || "your business",
      site_host: host,
      pages_read: result.itemCount,
      now_time: istTime(),
      fact_1: first.facts[0] ?? "",
      fact_2: first.facts[1] ?? "",
      fact_3: first.facts[2] ?? "",
    },
  });

  // Remember what we offered, so a tap on one is never mistaken for teaching.
  await patchSession(supabase, session.id, {
    suggested_questions: first.questions.slice(0, 3),
  });

  await sendServiceButtons(supabase, {
    ...channel,
    body: prefix + doneBody,
    buttons: first.questions.slice(0, 3).map((q, i) => ({ id: `q${i + 1}`, title: q.slice(0, 20) })),
    imageUrl: briefCard,
  });

}
