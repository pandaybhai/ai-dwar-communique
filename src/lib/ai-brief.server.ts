/**
 * One place assembles what the employee is told, so the panel a merchant reads
 * and the prompt a customer's answer came from cannot drift apart.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { listSkills, skillsBlock, type SkillState } from "@/lib/ai-skills.server";
import { DEFAULT_LANGUAGES, languageName } from "@/lib/languages";

/** The rules every answer follows, used when the database has none. */
export const FALLBACK_AGENT_RULES = [
  "Keep replies short — under 60 words for a normal answer. When listing products, one short line per product is fine.",
  "Only state something you found in the material provided or by looking it up.",
  "Never invent an order number, a price, a date or a policy.",
  "When a product lookup returns results, show them: name and price, up to five items. Never answer a product question by asking the customer to narrow down first.",
  "If more products matched than you listed, say so, for example \"and 9 more — tell me what you're after and I'll narrow it down\".",
  "Only ask a clarifying question when a lookup genuinely returned nothing.",
  "Product pictures are attached for you automatically — name each product plainly and never paste an image link.",
  "If you cannot answer from a source or a lookup, say a colleague will follow up.",
].join("\n");

export type PromptRules = { content: string; version: number | null; fromDatabase: boolean };

/** The platform's rules. A missing or empty row must never strip them. */
export async function promptRules(supabase: SupabaseClient): Promise<PromptRules> {
  try {
    const { data } = await supabase
      .from("ai_prompt_blocks")
      .select("content, version")
      .eq("key", "agent_rules")
      .maybeSingle();
    const row = data as { content?: string; version?: number } | null;
    const content = (row?.content ?? "").trim();
    if (content) return { content, version: row?.version ?? null, fromDatabase: true };
  } catch {
    // fall through to the constant
  }
  return { content: FALLBACK_AGENT_RULES, version: null, fromDatabase: false };
}

export type Instructions = {
  personaName: string;
  tone: string;
  instructions: string;
  escalationRules: string;
  languages: string[];
  workingHours: string;
};

export async function currentInstructions(
  supabase: SupabaseClient,
  agentId: string | null,
): Promise<Instructions> {
  const empty: Instructions = {
    personaName: "",
    tone: "",
    instructions: "",
    escalationRules: "",
    languages: [...DEFAULT_LANGUAGES],
    workingHours: "always",
  };
  if (!agentId) return empty;
  const { data } = await supabase
    .from("ai_instructions")
    .select("persona_name, tone, instructions, escalation_rules, languages, working_hours_behaviour")
    .eq("agent_id", agentId)
    .eq("is_current", true)
    .maybeSingle();
  const i = data as Record<string, unknown> | null;
  if (!i) return empty;
  const languages = Array.isArray(i["languages"]) ? (i["languages"] as string[]) : [];
  return {
    personaName: String(i["persona_name"] ?? ""),
    tone: String(i["tone"] ?? ""),
    instructions: String(i["instructions"] ?? ""),
    escalationRules: String(i["escalation_rules"] ?? ""),
    languages: languages.length ? languages : [...DEFAULT_LANGUAGES],
    workingHours: String(i["working_hours_behaviour"] ?? "always"),
  };
}

/** How the employee handles the languages a customer might write in. */
export function languageBlock(languages: string[]): string {
  const codes = languages.length ? languages : [...DEFAULT_LANGUAGES];
  const names = codes.map(languageName);
  const first = names[0] ?? "English";
  return [
    `You work in these languages: ${names.join(", ")}.`,
    "Reply in the language the customer wrote in, including Hinglish written in Latin script — if they write Hinglish, reply in Hinglish, not formal Hindi.",
    `If they write in a language not on that list, reply in ${first}.`,
  ].join(" ");
}

export type BriefSection = { key: string; label: string; text: string; note?: string };

export type AssembledBrief = {
  sections: BriefSection[];
  text: string;
  rulesVersion: number | null;
  rulesFromDatabase: boolean;
  characters: number;
  skills: SkillState[];
  taughtCount: number;
  instructions: Instructions;
};

async function taughtCount(supabase: SupabaseClient, organizationId: string): Promise<number> {
  const { data } = await supabase
    .from("knowledge_sources")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("type", "manual_qa");
  const ids = ((data ?? []) as Array<{ id: string }>).map((s) => s.id);
  if (!ids.length) return 0;
  const { count } = await supabase
    .from("knowledge_documents")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .in("source_id", ids);
  return count ?? 0;
}

/**
 * Everything the employee is told for one workspace, in labelled sections.
 * `instructionsOverride` lets the playground try unsaved wording.
 */
export async function assembleBrief(
  supabase: SupabaseClient,
  organizationId: string,
  agentId: string | null,
  options: { instructionsOverride?: string | null } = {},
): Promise<AssembledBrief> {
  const [rules, instructions, skills, taught] = await Promise.all([
    promptRules(supabase),
    currentInstructions(supabase, agentId),
    listSkills(supabase, organizationId).catch(() => [] as SkillState[]),
    taughtCount(supabase, organizationId).catch(() => 0),
  ]);

  const merchantInstructions = (options.instructionsOverride ?? instructions.instructions ?? "").trim();

  const who = [
    instructions.personaName
      ? `You are ${instructions.personaName}, answering on behalf of this business.`
      : "You answer on behalf of this business.",
    instructions.tone ? `Tone: ${instructions.tone}.` : "",
    languageBlock(instructions.languages),
  ]
    .filter(Boolean)
    .join(" ");

  const jobs = skillsBlock(skills);
  const escalation = instructions.escalationRules.trim();

  const sections: BriefSection[] = [
    { key: "rules", label: "Platform rules", text: rules.content },
    { key: "who", label: "Who he is", text: who },
    {
      key: "jobs",
      label: "His jobs",
      text: jobs,
      ...(jobs ? {} : { note: "No job is both switched on and ready yet, so he hands everything to a person." }),
    },
    {
      key: "instructions",
      label: "Your instructions",
      text: merchantInstructions,
      ...(merchantInstructions ? {} : { note: "You haven't written any yet." }),
    },
    {
      key: "escalation",
      label: "When to fetch a person",
      text: escalation ? `Hand these to a person instead of answering: ${escalation}` : "",
      ...(escalation
        ? {}
        : { note: "You haven't set any. Brian only escalates when the system decides to." }),
    },
    {
      key: "taught",
      label: "What he's been taught",
      text: taught
        ? `You have been corrected ${taught} time${taught === 1 ? "" : "s"} by this team. Those written answers are treated as the truth when they match.`
        : "",
      ...(taught ? {} : { note: "Nothing yet. Correct an answer in the inbox and he will remember it." }),
    },
    {
      key: "knowledge",
      label: "Knowledge",
      text: "",
      note: "Matched material from your website, files and corrections is added here at answer time.",
    },
  ];

  const text = sections
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join("\n\n");

  return {
    sections,
    text,
    rulesVersion: rules.version,
    rulesFromDatabase: rules.fromDatabase,
    characters: text.length,
    skills,
    taughtCount: taught,
    instructions,
  };
}

/**
 * What carrying this brief costs on every single message. Input tokens only —
 * roughly four characters per token — priced at what the merchant pays.
 */
export async function estimateBriefCost(
  supabase: SupabaseClient,
  organizationId: string,
  agentId: string | null,
  characters: number,
): Promise<{ amount: number | null; currency: string; tokens: number }> {
  const tokens = Math.ceil(characters / 4);
  try {
    const { resolveBrain, resolveMarkup } = await import("@/lib/ai-run.server");
    const [brain, markup] = await Promise.all([
      resolveBrain(supabase, organizationId, "agent_reply", agentId, null),
      resolveMarkup(supabase, organizationId),
    ]);
    const { data } = await supabase
      .from("ai_rates")
      .select("input_rate, currency")
      .eq("provider", brain.provider)
      .eq("model", brain.model_id)
      .lte("effective_from", new Date().toISOString().slice(0, 10))
      .order("effective_from", { ascending: false })
      .limit(1)
      .maybeSingle();
    const rate = data as { input_rate: number; currency: string } | null;
    if (!rate) return { amount: null, currency: "INR", tokens };
    const amount = (tokens * Number(rate.input_rate) * markup) / 1_000_000;
    return { amount: Number(amount.toFixed(6)), currency: rate.currency, tokens };
  } catch {
    return { amount: null, currency: "INR", tokens };
  }
}
