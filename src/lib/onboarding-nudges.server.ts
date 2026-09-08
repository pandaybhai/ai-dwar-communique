/**
 * Day-one follow-ups on the merchant channel.
 *
 * An owner who went quiet for a day gets exactly one gentle reminder, sent as
 * an approved utility template from the onboarding number (the free-form
 * window has closed by then). A session quiet for a week is over.
 *
 * Runs inside the knowledge-worker tick; there is no cron of its own.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export const RESUME_TEMPLATE_NAME = "aidwar_onboarding_resume";
export const RESUME_TEMPLATE_BODY =
  "Hi {{1}}, Aiden here from AiDwar. We stopped at {{2}}. Reply here to continue, or say 'help'.";

const NUDGE_AFTER_MS = 24 * 60 * 60 * 1000;
const EXPIRE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const NUDGEABLE = ["bound", "learning", "ready", "tested"];

type SessionRow = {
  id: string;
  organization_id: string;
  phone: string;
  status: string;
  step: string | null;
  nudges_sent: number | null;
  last_inbound_at: string | null;
  created_at: string;
};

/** What the owner would recognise as "where we stopped". */
function stoppedAt(session: SessionRow): string {
  switch (session.status) {
    case "bound":
      return "your website link";
    case "learning":
      return "reading your website";
    case "ready":
      return "testing me with a question";
    case "tested":
      return "connecting your WhatsApp number";
    default:
      return session.step?.replace(/_/g, " ") || "getting started";
  }
}

/**
 * Creates the resume template in the platform workspace and submits it to
 * Meta, once. Nothing is sent until Meta approves it.
 */
export async function ensureResumeTemplate(
  supabase: SupabaseClient,
  actorId: string,
): Promise<{ status: string | null; created: boolean; error: string | null }> {
  const { resolvePlatformOrg } = await import("@/lib/billing-notify.server");
  const orgId = await resolvePlatformOrg(supabase);
  if (!orgId) return { status: null, created: false, error: "No platform workspace." };

  const { data: existing } = await supabase
    .from("message_templates")
    .select("status")
    .eq("organization_id", orgId)
    .eq("name", RESUME_TEMPLATE_NAME)
    .eq("language", "en")
    .maybeSingle();
  if (existing) {
    return { status: (existing as { status: string | null }).status, created: false, error: null };
  }

  const { emptyDraft, extractVariables } = await import("@/lib/templates");
  const { createTemplateFromDraft } = await import("@/lib/template-create.server");
  const draft = emptyDraft();
  draft.name = RESUME_TEMPLATE_NAME;
  draft.language = "en";
  draft.category = "UTILITY";
  draft.body = RESUME_TEMPLATE_BODY;
  draft.bodyExamples = Object.fromEntries(
    extractVariables(RESUME_TEMPLATE_BODY).map((v, i) => [v, ["Priya", "your website link"][i] ?? ""]),
  );
  const result = await createTemplateFromDraft(supabase, { organizationId: orgId, userId: actorId, draft });
  if (!result.ok) return { status: null, created: false, error: result.error };
  return { status: "PENDING", created: true, error: null };
}

/**
 * One pass: expire week-old sessions, nudge day-old ones (once each).
 * Returns counts so the worker can report them.
 */
export async function runOnboardingNudges(
  supabase: SupabaseClient,
  limit = 20,
): Promise<{ expired: number; nudged: number; skipped: string | null }> {
  const now = Date.now();

  // A week of silence: the session is over. Quiet, no message.
  const { data: expiredRows } = await supabase
    .from("onboarding_sessions")
    .update({ status: "expired" })
    .in("status", NUDGEABLE)
    .lt("last_inbound_at", new Date(now - EXPIRE_AFTER_MS).toISOString())
    .select("id");
  const expired = (expiredRows ?? []).length;

  const { data: candidates } = await supabase
    .from("onboarding_sessions")
    .select("id, organization_id, phone, status, step, nudges_sent, last_inbound_at, created_at")
    .in("status", NUDGEABLE)
    .eq("nudges_sent", 0)
    .lt("last_inbound_at", new Date(now - NUDGE_AFTER_MS).toISOString())
    .order("last_inbound_at", { ascending: true })
    .limit(limit);
  const sessions = (candidates ?? []) as SessionRow[];
  if (sessions.length === 0) return { expired, nudged: 0, skipped: null };

  // The template must exist and be approved on the platform workspace.
  const { resolvePlatformOrg } = await import("@/lib/billing-notify.server");
  const platformOrgId = await resolvePlatformOrg(supabase);
  if (!platformOrgId) return { expired, nudged: 0, skipped: "no_platform_org" };

  const { data: templateRow } = await supabase
    .from("message_templates")
    .select("name, language, components, status")
    .eq("organization_id", platformOrgId)
    .eq("name", RESUME_TEMPLATE_NAME)
    .eq("language", "en")
    .maybeSingle();
  const template = templateRow as
    | { name: string; language: string; components: unknown; status: string | null }
    | null;
  if (!template) return { expired, nudged: 0, skipped: "template_missing" };
  if (String(template.status ?? "").toUpperCase() !== "APPROVED") {
    return { expired, nudged: 0, skipped: `template_${String(template.status ?? "unknown").toLowerCase()}` };
  }

  // Sent from the onboarding number, never from a merchant's own number.
  const { data: setting } = await supabase
    .from("platform_settings")
    .select("onboarding_whatsapp_account_id")
    .maybeSingle();
  const accountId =
    (setting as { onboarding_whatsapp_account_id?: string | null } | null)
      ?.onboarding_whatsapp_account_id ?? null;
  if (!accountId) return { expired, nudged: 0, skipped: "no_onboarding_number" };

  const { loadSenderContext, sendCampaignTemplate } = await import("@/lib/campaigns.server");
  const sender = await loadSenderContext(supabase, platformOrgId, accountId);
  if (!sender) return { expired, nudged: 0, skipped: "onboarding_number_not_connected" };

  let nudged = 0;
  for (const session of sessions) {
    // Claim first so two overlapping ticks can never send twice.
    const { data: claimed } = await supabase
      .from("onboarding_sessions")
      .update({ nudges_sent: (session.nudges_sent ?? 0) + 1 })
      .eq("id", session.id)
      .eq("nudges_sent", 0)
      .select("id")
      .maybeSingle();
    if (!claimed) continue;

    const [{ data: contact }, { data: org }] = await Promise.all([
      supabase
        .from("contacts")
        .select("id, name")
        .eq("organization_id", platformOrgId)
        .eq("phone", session.phone)
        .maybeSingle(),
      supabase.from("organizations").select("name").eq("id", session.organization_id).maybeSingle(),
    ]);
    const firstName =
      ((contact as { name?: string | null } | null)?.name ?? "").trim().split(/\s+/)[0] ||
      ((org as { name?: string } | null)?.name ?? "").trim() ||
      "there";

    const outcome = await sendCampaignTemplate(
      supabase,
      platformOrgId,
      sender,
      {
        contactId: (contact as { id: string } | null)?.id ?? null,
        phone: session.phone,
        variables: { "1": firstName, "2": stoppedAt(session) },
      },
      {
        name: template.name,
        language: template.language,
        variableOrder: [1, 2],
        components: (template.components ?? null) as import("@/lib/templates").TemplateComponent[] | null,
      },
      { campaignId: null, category: "utility" },
    );

    if (outcome.messageId && !outcome.error) nudged += 1;
    else console.error("[onboarding-nudge] send failed", session.id, outcome.error);
  }

  return { expired, nudged, skipped: null };
}
