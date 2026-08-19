/**
 * The jobs the AI employee does, expressed as prompts plus the run options
 * each one needs. Nothing here calls a model — that is executeRun's job.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { executeRun, type RunOptions, type RunResult } from "@/lib/ai-run.server";

export type Turn = { role: "user" | "assistant"; content: string };

/** The last N messages of a conversation as plain turns, oldest first. */
export async function conversationTurns(
  supabase: SupabaseClient,
  organizationId: string,
  conversationId: string,
  limit = 30,
): Promise<{ turns: Turn[]; contactId: string | null; contactName: string | null }> {
  const { data: convo } = await supabase
    .from("conversations")
    .select("id, contact_id, contacts(name)")
    .eq("id", conversationId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const c = convo as
    | { contact_id: string | null; contacts?: { name?: string | null } | null }
    | null;

  const { data: rows } = await supabase
    .from("messages")
    .select("direction, body, created_at")
    .eq("organization_id", organizationId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit);

  const turns = ((rows ?? []) as Array<{ direction: string; body: string | null }>)
    .filter((m) => (m.body ?? "").trim().length > 0)
    .reverse()
    .map<Turn>((m) => ({
      role: m.direction === "inbound" ? "user" : "assistant",
      content: String(m.body),
    }));

  return { turns, contactId: c?.contact_id ?? null, contactName: c?.contacts?.name ?? null };
}

/** Current persona and rules for an agent, as a system brief. */
export async function agentBrief(
  supabase: SupabaseClient,
  agentId: string | null,
): Promise<{ brief: string; escalationRules: string; personaName: string }> {
  if (!agentId) return { brief: "", escalationRules: "", personaName: "" };
  const { data } = await supabase
    .from("ai_instructions")
    .select("persona_name, tone, instructions, escalation_rules, languages, working_hours_behaviour")
    .eq("agent_id", agentId)
    .eq("is_current", true)
    .maybeSingle();
  const i = data as
    | {
        persona_name: string;
        tone: string;
        instructions: string;
        escalation_rules: string;
        languages: string[];
      }
    | null;
  if (!i) return { brief: "", escalationRules: "", personaName: "" };
  const brief = [
    i.persona_name ? `You are ${i.persona_name}, answering on behalf of this business.` : "",
    i.tone ? `Tone: ${i.tone}.` : "",
    i.languages?.length ? `Reply in the customer's language where possible (${i.languages.join(", ")}).` : "",
    i.instructions,
    i.escalation_rules ? `Hand these to a person instead of answering: ${i.escalation_rules}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { brief, escalationRules: i.escalation_rules ?? "", personaName: i.persona_name ?? "" };
}

export async function defaultAgentId(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("ai_agents")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("is_default", true)
    .maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}

type Common = {
  organizationId: string;
  actorUserId: string | null;
  actingRole?: string | null;
};

export async function suggestReply(
  supabase: SupabaseClient,
  common: Common,
  conversationId: string,
): Promise<RunResult> {
  const agentId = await defaultAgentId(supabase, common.organizationId);
  const { turns, contactId } = await conversationTurns(supabase, common.organizationId, conversationId);
  const { brief } = await agentBrief(supabase, agentId);
  const last = [...turns].reverse().find((t) => t.role === "user")?.content ?? "";

  return executeRun(supabase, {
    organizationId: common.organizationId,
    task: "suggest_reply",
    agentId,
    conversationId,
    contactId,
    actorUserId: common.actorUserId,
    actingRole: common.actingRole ?? null,
    history: turns.slice(0, -1),
    input: last || "Write the next reply in this conversation.",
    system: [
      brief,
      "Draft the next reply for a human teammate to check and send.",
      "Keep it under 60 words, plain and specific. No greetings padding, no emoji unless the customer used one.",
      "If you do not know something, say what you would need to find out instead of guessing.",
    ]
      .filter(Boolean)
      .join("\n"),
    useKnowledge: true,
    useTools: true,
  } satisfies RunOptions);
}

export async function summariseConversation(
  supabase: SupabaseClient,
  common: Common,
  conversationId: string,
): Promise<RunResult> {
  const agentId = await defaultAgentId(supabase, common.organizationId);
  const { turns, contactId } = await conversationTurns(supabase, common.organizationId, conversationId, 60);
  const transcript = turns
    .map((t) => `${t.role === "user" ? "Customer" : "Us"}: ${t.content}`)
    .join("\n")
    .slice(0, 12000);

  return executeRun(supabase, {
    organizationId: common.organizationId,
    task: "summarise",
    agentId,
    conversationId,
    contactId,
    actorUserId: common.actorUserId,
    actingRole: common.actingRole ?? null,
    input: transcript || "No messages yet.",
    system:
      "Summarise this customer conversation in exactly three short lines: what they want, what has happened, what is still open. No preamble.",
  });
}

export async function autoTag(
  supabase: SupabaseClient,
  common: Common,
  conversationId: string,
): Promise<{ run: RunResult; tags: string[] }> {
  const agentId = await defaultAgentId(supabase, common.organizationId);
  const { turns, contactId } = await conversationTurns(supabase, common.organizationId, conversationId, 40);
  const { data: existing } = await supabase
    .from("tags")
    .select("name")
    .eq("organization_id", common.organizationId)
    .limit(80);
  const names = ((existing ?? []) as Array<{ name: string }>).map((t) => t.name);

  const transcript = turns
    .map((t) => `${t.role === "user" ? "Customer" : "Us"}: ${t.content}`)
    .join("\n")
    .slice(0, 8000);

  const run = await executeRun(supabase, {
    organizationId: common.organizationId,
    task: "auto_tag",
    agentId,
    conversationId,
    contactId,
    actorUserId: common.actorUserId,
    actingRole: common.actingRole ?? null,
    input: transcript || "No messages yet.",
    system: [
      "Propose up to three short labels describing this customer, for the team's own filing.",
      names.length ? `Prefer labels already in use: ${names.join(", ")}.` : "",
      "Answer with the labels only, comma separated, lower case. No sentences.",
    ]
      .filter(Boolean)
      .join("\n"),
  });

  const tags = run.output
    .split(/[,\n]/)
    .map((t) => t.trim().replace(/^[-*\d.\s]+/, "").toLowerCase())
    .filter((t) => t.length > 1 && t.length <= 30)
    .slice(0, 3);

  return { run, tags };
}

/** A test answer. Touches no customer and sends nothing. */
export async function playgroundAnswer(
  supabase: SupabaseClient,
  common: Common,
  question: string,
  tier?: string | null,
  instructionsOverride?: string | null,
  comparisonId?: string | null,
): Promise<RunResult> {
  const agentId = await defaultAgentId(supabase, common.organizationId);
  const { assembleBrief } = await import("@/lib/ai-brief.server");
  const brief = await assembleBrief(supabase, common.organizationId, agentId, {
    instructionsOverride: instructionsOverride ?? null,
  });

  return executeRun(supabase, {
    organizationId: common.organizationId,
    task: "agent_reply",
    agentId,
    actorUserId: common.actorUserId,
    actingRole: common.actingRole ?? null,
    input: question,
    system: brief.text,
    promptRulesVersion: brief.rulesVersion,
    tier: tier ?? null,
    comparisonId: comparisonId ?? null,
    useKnowledge: true,
    useTools: true,
  });
}

/**
 * Kept only as the last line of defence: the live rules live in
 * ai_prompt_blocks and are read through assembleBrief.
 */
export { FALLBACK_AGENT_RULES as AGENT_RULES } from "@/lib/ai-brief.server";

/** The real answer the agent would give a customer. */
export async function agentAnswer(
  supabase: SupabaseClient,
  common: Common,
  conversationId: string,
  question: string,
): Promise<RunResult> {
  const agentId = await defaultAgentId(supabase, common.organizationId);
  const { turns, contactId } = await conversationTurns(supabase, common.organizationId, conversationId);
  const { assembleBrief } = await import("@/lib/ai-brief.server");
  const brief = await assembleBrief(supabase, common.organizationId, agentId);

  return executeRun(supabase, {
    organizationId: common.organizationId,
    task: "agent_reply",
    agentId,
    conversationId,
    contactId,
    actorUserId: common.actorUserId,
    actingRole: common.actingRole ?? null,
    history: turns.slice(0, -1),
    input: question,
    // Escalation rules are part of the assembled brief — exactly once.
    system: brief.text,
    promptRulesVersion: brief.rulesVersion,
    useKnowledge: true,
    useTools: true,
  });
}

