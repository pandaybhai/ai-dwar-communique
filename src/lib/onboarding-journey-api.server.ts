/**
 * Batch 40: what /api/onboarding/journey does, kept out of the route so the
 * tests drive it with a fake database. Every write reuses the existing path:
 * the website goes through addWebsiteSource (Day-0 read), a "no website"
 * description through saveFact, the test answer through playgroundAnswer,
 * the mode through setAgentMode, the funnel through recordFunnelStep, a
 * call-back request through the admin notice queue.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { JourneyMark } from "@/lib/onboarding-journey";

export type JourneyAuth = {
  supabase: SupabaseClient;
  organizationId: string;
  userId: string;
  role: string;
  /** May set Aiden up (owner, or the ai.configure permission). */
  canConfigure: boolean;
};

export type JourneyReply = { status: number; body: Record<string, unknown> };

const ok = (body: Record<string, unknown>): JourneyReply => ({ status: 200, body });
const refuse = (
  error: string,
  status = 400,
  extra: Record<string, unknown> = {},
): JourneyReply => ({
  status,
  body: { error, ...extra },
});

/** Marks the browser may record itself (the rest are recorded by the server). */
const CLIENT_MARKS: ReadonlyArray<JourneyMark | "connect_opened"> = [
  "connect_opened",
  "connect_skipped",
  "dismissed",
];

/** One call-back request per workspace per half hour reaches the team. */
const CALLBACK_COOLDOWN_MS = 30 * 60 * 1000;

export async function journeyState(auth: JourneyAuth, withLearned: boolean): Promise<JourneyReply> {
  const { loadJourneyState, learnedSoFar } = await import("@/lib/onboarding-journey.server");
  const [state, learned, profile] = await Promise.all([
    loadJourneyState(auth.supabase, auth.organizationId),
    withLearned ? learnedSoFar(auth.supabase, auth.organizationId) : Promise.resolve(null),
    auth.supabase.from("profiles").select("phone").eq("id", auth.userId).maybeSingle(),
  ]);
  const ownerPhone = (profile.data as { phone?: string | null } | null)?.phone ?? null;
  return ok({
    state,
    can_configure: auth.canConfigure,
    owner_phone: ownerPhone,
    ...(learned ? { learned } : {}),
  });
}

/** Saves the colours and logo the site showed, only where the workspace has none yet. */
async function keepBrand(
  supabase: SupabaseClient,
  organizationId: string,
  brand: { logoUrl?: unknown; color?: unknown },
): Promise<void> {
  const { safeColor } = await import("@/lib/site-peek");
  const logo =
    typeof brand.logoUrl === "string" && /^https:\/\//i.test(brand.logoUrl)
      ? brand.logoUrl.slice(0, 500)
      : null;
  const color = safeColor(typeof brand.color === "string" ? brand.color : null);
  if (!logo && !color) return;
  const { data } = await supabase
    .from("organizations")
    .select("branding")
    .eq("id", organizationId)
    .maybeSingle();
  const branding = ((data as { branding?: Record<string, unknown> | null } | null)?.branding ??
    {}) as Record<string, unknown>;
  const next = { ...branding };
  if (logo && !branding["brand_logo_url"] && !branding["logo_url"]) next["brand_logo_url"] = logo;
  if (color && !branding["brand_primary"]) next["brand_primary"] = color;
  if (Object.keys(next).length === Object.keys(branding).length) return;
  await supabase.from("organizations").update({ branding: next }).eq("id", organizationId);
}

/**
 * Step 1: the workspace exists (create_organization, unchanged); this starts
 * the journey, keeps the brand, and gives Aiden something to read.
 */
export async function journeyBegin(
  auth: JourneyAuth,
  payload: Record<string, unknown>,
): Promise<JourneyReply> {
  if (!auth.canConfigure) return refuse("Only the workspace owner can set Aiden up.", 403);
  const { supabase, organizationId, userId } = auth;
  const { recordFunnelStep } = await import("@/lib/onboarding-journey.server");
  await recordFunnelStep(supabase, { organizationId, userId, step: "started" });

  const brand = (payload["brand"] ?? {}) as { logoUrl?: unknown; color?: unknown };
  await keepBrand(supabase, organizationId, brand);

  // Back on step 1 with a corrected name: the workspace takes it.
  const name = String(payload["name"] ?? "")
    .trim()
    .slice(0, 120);
  if (name.length >= 2) {
    const { data: org } = await supabase
      .from("organizations")
      .select("name")
      .eq("id", organizationId)
      .maybeSingle();
    if ((org as { name?: string | null } | null)?.name !== name) {
      await supabase.from("organizations").update({ name }).eq("id", organizationId);
    }
  }

  const knowledge = await import("@/lib/knowledge.server");
  const { normaliseSiteInput } = await import("@/lib/site-peek");
  const about = String(payload["about"] ?? "").trim();
  const url = normaliseSiteInput(String(payload["url"] ?? ""));

  if (url) {
    const added = await knowledge.addWebsiteSource(supabase, organizationId, url, userId, {
      mode: "day0",
    });
    if (added.limited) return refuse(added.error ?? knowledge.TRIAL_LINK_LIMIT_REPLY, 429);
    if (!added.sourceId) return refuse(added.error ?? "We couldn't add that website.");
    const { logServerActivity } = await import("@/lib/whatsapp-api.server");
    await logServerActivity(supabase, organizationId, userId, "ai_knowledge_added", {
      type: "website",
      via: "onboarding",
    });
    return ok({
      source_id: added.sourceId,
      queued: added.queued ?? false,
      reused: added.reused ?? false,
    });
  }
  if (about.length >= 12) {
    const saved = await knowledge.saveFact(supabase, organizationId, {
      topic: "About the business",
      text: about.slice(0, 2000),
      userId,
    });
    if (!saved.ok) return refuse("We couldn't save that. Please try again.");
    return ok({ saved: true });
  }
  return refuse("Add your website, or tell Aiden in a sentence or two what you sell.");
}

export async function journeyMark(
  auth: JourneyAuth,
  payload: Record<string, unknown>,
): Promise<JourneyReply> {
  const step = String(payload["step"] ?? "") as JourneyMark | "connect_opened";
  if (!CLIENT_MARKS.includes(step)) return refuse("Unknown step.");
  const { recordFunnelStep } = await import("@/lib/onboarding-journey.server");
  const recorded = await recordFunnelStep(auth.supabase, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    step,
  });
  return ok({ recorded });
}

type TestTurn = { role: "user" | "assistant"; content: string };

/** Meet Aiden: one customer question, answered from the workspace's own material. Sends nothing. */
export async function journeyTest(
  auth: JourneyAuth,
  payload: Record<string, unknown>,
): Promise<JourneyReply> {
  if (!auth.canConfigure) return refuse("Only the workspace owner can test Aiden here.", 403);
  const question = String(payload["question"] ?? "")
    .trim()
    .slice(0, 500);
  if (!question) return refuse("Type a question a customer might ask.");
  const { testsToday, TESTS_PER_DAY, recordFunnelStep } =
    await import("@/lib/onboarding-journey.server");
  if ((await testsToday(auth.supabase, auth.organizationId)) >= TESTS_PER_DAY) {
    return refuse(
      "That's a lot of questions for one day — Aiden's ready. Carry on to Go live.",
      429,
    );
  }
  const history = (Array.isArray(payload["history"]) ? payload["history"] : [])
    .map((t) => t as Partial<TestTurn>)
    .filter(
      (t): t is TestTurn =>
        (t.role === "user" || t.role === "assistant") && typeof t.content === "string",
    )
    .map((t) => ({ role: t.role, content: t.content.slice(0, 1000) }))
    .slice(-10);

  const { playgroundAnswer } = await import("@/lib/ai-tasks.server");
  const run = await playgroundAnswer(
    auth.supabase,
    { organizationId: auth.organizationId, actorUserId: auth.userId, actingRole: auth.role },
    question,
    null,
    null,
    null,
    { history, purpose: "onboarding_test" },
  );
  const answer = String(run.output ?? "").trim();
  const answered = run.status === "ok" && answer.length > 0;
  if (answered) {
    await recordFunnelStep(auth.supabase, {
      organizationId: auth.organizationId,
      userId: auth.userId,
      step: "aiden_tested",
      properties: { grounded: (run.sources ?? []).length > 0 },
    });
  }
  return ok({
    answered,
    answer: answered ? answer : null,
    sources: (run.sources ?? []).length,
    status: run.status,
  });
}

/** Go live: Draft or Replying, through the one mode switch. */
export async function journeyGoLive(
  auth: JourneyAuth,
  payload: Record<string, unknown>,
): Promise<JourneyReply> {
  if (!auth.canConfigure) return refuse("Only the workspace owner can switch Aiden on.", 403);
  const mode = String(payload["mode"] ?? "");
  if (mode !== "draft" && mode !== "replying") return refuse("Choose Draft or Replying.");
  const { setAgentMode } = await import("@/lib/agent-mode.server");
  const result = await setAgentMode(auth.supabase, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    mode,
  });
  if (!result.ok) return { status: result.status, body: result.body };

  const { recordFunnelStep } = await import("@/lib/onboarding-journey.server");
  await recordFunnelStep(auth.supabase, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    step: "went_live",
    properties: { mode },
  });

  // The WhatsApp setup session is finished too: the owner is known on the
  // onboarding number from now on, and no "reply with your code" nudge follows.
  const { data: session } = await auth.supabase
    .from("onboarding_sessions")
    .select("id, status")
    .eq("organization_id", auth.organizationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = session as { id: string; status: string } | null;
  if (row && row.status !== "completed" && row.status !== "expired") {
    await auth.supabase
      .from("onboarding_sessions")
      .update({
        status: "completed",
        step: "done",
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
  }
  return ok({ ok: true, mode: result.mode });
}

/** "Need help? We'll call you": one notice to the AiDwar team, at most every half hour. */
export async function journeyCallback(
  auth: JourneyAuth,
  payload: Record<string, unknown>,
): Promise<JourneyReply> {
  const { supabase, organizationId, userId } = auth;
  const { normalizePhone } = await import("@/lib/phone");
  const { data: profile } = await supabase
    .from("profiles")
    .select("phone, full_name")
    .eq("id", userId)
    .maybeSingle();
  const prof = (profile ?? {}) as { phone?: string | null; full_name?: string | null };
  const phone = normalizePhone(String(payload["phone"] ?? "")) || normalizePhone(prof.phone ?? "");
  if (!phone) return refuse("Add the number we should call.");
  const where = String(payload["where"] ?? "connect").slice(0, 40);
  const problem = String(payload["problem"] ?? "").slice(0, 80);

  const { data: recent } = await supabase
    .from("activity_log")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("action", "onboarding_callback_requested")
    .gte("created_at", new Date(Date.now() - CALLBACK_COOLDOWN_MS).toISOString())
    .limit(1);
  if (((recent ?? []) as unknown[]).length > 0) return ok({ ok: true, already: true });

  const { data: org } = await supabase
    .from("organizations")
    .select("name")
    .eq("id", organizationId)
    .maybeSingle();
  const name =
    String((org as { name?: string | null } | null)?.name ?? "").trim() || "A new workspace";
  const headline = `${name} asked for a call while setting up (${where.replace(/_/g, " ")})`;
  const detail = `call ${phone}${problem ? ` — stuck on: ${problem.replace(/_/g, " ")}` : ""}`;

  await supabase.from("activity_log").insert({
    organization_id: organizationId,
    user_id: userId,
    action: "onboarding_callback_requested",
    details: { phone, where, problem: problem || null },
  });
  await supabase.from("billing_notifications").insert({
    organization_id: organizationId,
    audience: "admin",
    kind: "onboarding_callback",
    channel: "whatsapp",
    payload: { headline, detail, link: "https://aidwar.in/admin/onboarding" },
  });
  const { recordFunnelStep } = await import("@/lib/onboarding-journey.server");
  await recordFunnelStep(supabase, {
    organizationId,
    userId,
    step: "callback_requested",
    properties: { where },
  });
  return ok({ ok: true });
}
