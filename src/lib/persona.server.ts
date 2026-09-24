import type { SupabaseClient } from "@supabase/supabase-js";
import type { BehaviourFields } from "@/lib/behaviour-save.server";

/**
 * "Generate from website": a first draft of how Aiden behaves, grounded only
 * on the workspace's saved website pages. It never writes numbers (phones,
 * prices, delivery times, offers) unless they appear verbatim in the pages.
 */

export const MIN_PAGES = 3;

const HANDOVER_RULES =
  "Hand over to the team when a customer asks for a person, wants a custom or bulk order, received a damaged or wrong item, or asks for a refund.";

async function websitePages(supabase: SupabaseClient, organizationId: string) {
  const { data: sources } = await supabase
    .from("knowledge_sources")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("type", "website");
  const ids = ((sources ?? []) as Array<{ id: string }>).map((s) => s.id);
  if (!ids.length) return [];
  const { data } = await supabase
    .from("knowledge_documents")
    .select("source_ref, title, content")
    .in("source_id", ids)
    .limit(400);
  return (data ?? []) as Array<{ source_ref: string; title: string | null; content: string | null }>;
}

/** Home, about, contact and policy pages first — they say who the business is. */
function rank(url: string): number {
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  })();
  if (path === "/" || path === "") return 0;
  if (/about|our-story|who-we-are/.test(path)) return 1;
  if (/contact/.test(path)) return 2;
  if (/faq|shipping|return|refund|policy|terms/.test(path)) return 3;
  if (/collection|category|shop/.test(path)) return 4;
  if (/product/.test(path)) return 6;
  return 5;
}

/** Drops any sentence carrying a number that isn't written word for word in the pages. */
function stripUngroundedNumbers(text: string, material: string): string {
  const haystack = material.replace(/\s+/g, " ").toLowerCase();
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => {
      const numbers = sentence.match(/[₹$]?\s?\d[\d,.:/-]*\s?(%|days?|hours?|hrs?|am|pm)?/gi) ?? [];
      return numbers.every((n) => haystack.includes(n.trim().toLowerCase()));
    })
    .join(" ")
    .trim();
}

function limitWords(text: string, max: number): string {
  const words = text.split(/\s+/);
  if (words.length <= max) return text;
  const cut = words.slice(0, max).join(" ");
  const end = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"));
  return end > 40 ? cut.slice(0, end + 1) : cut;
}

export type PersonaResult =
  | { ok: true; fields: BehaviourFields; pages: number }
  | { ok: false; error: string; pages: number };

export async function generatePersona(
  supabase: SupabaseClient,
  organizationId: string,
  options: { agentId: string | null; actorUserId?: string | null },
): Promise<PersonaResult> {
  const pages = await websitePages(supabase, organizationId);
  if (pages.length < MIN_PAGES)
    return { ok: false, pages: pages.length, error: `Needs at least ${MIN_PAGES} website pages read (has ${pages.length}).` };

  const { data: org } = await supabase.from("organizations").select("name").eq("id", organizationId).maybeSingle();
  const orgName = (org as { name?: string } | null)?.name ?? "";

  const picked = [...pages].sort((a, b) => rank(a.source_ref) - rank(b.source_ref)).slice(0, 12);
  const material = picked
    .map((p) => `### ${p.title ?? ""} (${p.source_ref})\n${(p.content ?? "").slice(0, 2500)}`)
    .join("\n\n")
    .slice(0, 26000);

  const { executeRun } = await import("@/lib/ai-run.server");
  const run = await executeRun(supabase, {
    organizationId,
    task: "summarise",
    agentId: options.agentId,
    actorUserId: options.actorUserId ?? null,
    tier: "everyday",
    useKnowledge: false,
    useTools: false,
    billingExempt: true,
    metadata: { purpose: "persona_generate" },
    system: [
      "You write the brief for a business's WhatsApp assistant, using ONLY the website pages given.",
      "persona_name: the business name exactly as written on the site.",
      "instructions: at most 120 words, second person ('You are … for …'). Say what the business sells and who it serves, in plain words. Tone warm and short. Reply in English or Hindi (Hinglish is fine), matching the customer.",
      "Never write phone numbers, prices, delivery times, offers, discounts or policies unless they appear word for word in the pages. When unsure, leave it out.",
      'Answer with JSON only: {"persona_name": "...", "instructions": "..."}',
    ].join("\n"),
    input: `WEBSITE PAGES:\n${material}`,
  });
  if (run.status !== "ok" || !run.output.trim())
    return { ok: false, pages: pages.length, error: "The generator didn't answer. Try again in a minute." };

  let parsed: { persona_name?: unknown; instructions?: unknown } = {};
  try {
    const raw = run.output.trim();
    parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch {
    return { ok: false, pages: pages.length, error: "The generator's answer couldn't be read. Try again." };
  }
  const name = String(parsed.persona_name ?? "").trim().slice(0, 60);
  const personaName = name && material.toLowerCase().includes(name.toLowerCase()) ? name : orgName || "Aiden";
  const instructions = limitWords(stripUngroundedNumbers(String(parsed.instructions ?? "").trim(), material), 120);
  if (instructions.length < 20)
    return { ok: false, pages: pages.length, error: "The draft came out empty after safety checks. Try again." };

  return {
    ok: true,
    pages: pages.length,
    fields: {
      persona_name: personaName,
      tone: "warm",
      instructions,
      escalation_rules: HANDOVER_RULES,
      handover_message: "Let me get someone from the team to help — they'll reply here shortly.",
      languages: ["en", "hi"],
      working_hours_behaviour: "always",
    },
  };
}

/**
 * After a workspace's first website read: if it has no behaviour of its own
 * yet (nothing, or only the seeded default), save a suggested version for
 * the owner to review. Never throws.
 */
export async function suggestPersonaAfterRead(supabase: SupabaseClient, sourceId: string): Promise<void> {
  try {
    const { data: source } = await supabase
      .from("knowledge_sources")
      .select("organization_id, type")
      .eq("id", sourceId)
      .maybeSingle();
    const src = source as { organization_id: string; type: string } | null;
    if (!src || src.type !== "website") return;
    const { data: agent } = await supabase
      .from("ai_agents")
      .select("id")
      .eq("organization_id", src.organization_id)
      .eq("is_default", true)
      .maybeSingle();
    const agentId = (agent as { id?: string } | null)?.id;
    if (!agentId) return;
    const { data: authored } = await supabase
      .from("ai_instructions")
      .select("id")
      .eq("agent_id", agentId)
      .or("updated_by.not.is.null,origin.not.is.null")
      .limit(1);
    if ((authored ?? []).length > 0) return;

    const result = await generatePersona(supabase, src.organization_id, { agentId });
    if (!result.ok) {
      console.info("[persona] no suggestion", JSON.stringify({ org: src.organization_id, reason: result.error }));
      return;
    }
    const { saveBehaviourVersion } = await import("@/lib/behaviour-save.server");
    await saveBehaviourVersion(supabase, {
      organizationId: src.organization_id,
      agentId,
      userId: null,
      fields: result.fields,
      audience: "admin",
      via: "system",
      origin: "suggested",
    });
  } catch (error) {
    console.error("[persona] suggestion failed", error instanceof Error ? error.message : String(error));
  }
}
