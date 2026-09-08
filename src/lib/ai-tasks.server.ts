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
): Promise<{
  turns: Turn[];
  contactId: string | null;
  contactName: string | null;
  /** The language of the customer's most recent message, when we could tell. */
  customerLanguage: string | null;
}> {
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
    .select("direction, body, detected_language, created_at")
    .eq("organization_id", organizationId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit);

  const all = (rows ?? []) as Array<{
    direction: string;
    body: string | null;
    detected_language?: string | null;
  }>;
  const customerLanguage =
    all.find((m) => m.direction === "inbound" && m.detected_language)?.detected_language ?? null;

  const turns = all
    .filter((m) => (m.body ?? "").trim().length > 0)
    .reverse()
    .map<Turn>((m) => ({
      role: m.direction === "inbound" ? "user" : "assistant",
      content: String(m.body),
    }));

  return {
    turns,
    contactId: c?.contact_id ?? null,
    contactName: c?.contacts?.name ?? null,
    customerLanguage,
  };
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
  const { turns, contactId, customerLanguage } = await conversationTurns(
    supabase,
    common.organizationId,
    conversationId,
  );
  const { brief } = await agentBrief(supabase, agentId);
  const { customerLanguageBlock } = await import("@/lib/ai-brief.server");
  const spoken = customerLanguageBlock(customerLanguage, []);
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
      spoken,
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

export const DEFAULT_HANDOVER_MESSAGE =
  "Let me get someone from the team to help — they'll reply here shortly.";

/** The exact words the customer gets when the employee steps back. */
export async function handoverMessage(
  supabase: SupabaseClient,
  agentId: string | null,
): Promise<string> {
  if (!agentId) return DEFAULT_HANDOVER_MESSAGE;
  const { data } = await supabase
    .from("ai_instructions")
    .select("handover_message")
    .eq("agent_id", agentId)
    .eq("is_current", true)
    .maybeSingle();
  const text = (data as { handover_message?: string | null } | null)?.handover_message ?? "";
  return text.trim() || DEFAULT_HANDOVER_MESSAGE;
}

/** The real answer the agent would give a customer. */
export async function agentAnswer(
  supabase: SupabaseClient,
  common: Common,
  conversationId: string,
  question: string,
): Promise<RunResult> {
  const agentId = await defaultAgentId(supabase, common.organizationId);
  const { turns, contactId, customerLanguage } = await conversationTurns(
    supabase,
    common.organizationId,
    conversationId,
  );
  const { assembleBrief } = await import("@/lib/ai-brief.server");
  const brief = await assembleBrief(supabase, common.organizationId, agentId, { customerLanguage });

  // A repeat only matters when the first attempt actually failed.
  const { data: pastRuns } = await supabase
    .from("ai_runs")
    .select("input_summary, status")
    .eq("organization_id", common.organizationId)
    .eq("conversation_id", conversationId)
    .eq("task", "agent_reply")
    .neq("status", "ok")
    .order("created_at", { ascending: false })
    .limit(20);
  const priorFailedQuestions = ((pastRuns ?? []) as Array<{ input_summary: string | null }>)
    .map((r) => (r.input_summary ?? "").trim())
    .filter(Boolean);

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
    customerLanguage,
    priorFailedQuestions,
    useKnowledge: true,
    useTools: true,
  });
}

/**
 * The answer the owner gets while Aiden is being set up on WhatsApp.
 *
 * The chat itself lives in the platform organization's inbox (that is the
 * number the owner writes to), but everything that matters — retrieval, the
 * ai_runs row, the cost — belongs to the owner's own workspace. So
 * `conversation_id` on the run points at a conversation in the platform org.
 * That is deliberate.
 */
export async function merchantAnswer(
  supabase: SupabaseClient,
  common: Common,
  args: {
    /** The platform-org conversation the owner is writing in. */
    conversationId: string;
    question: string;
    session: {
      id: string;
      organization_id: string;
      user_id: string;
      business_name?: string | null;
      owner_name?: string | null;
    };
  },
): Promise<RunResult> {
  const organizationId = args.session.organization_id;
  const agentId = await defaultAgentId(supabase, organizationId);

  // History comes from the platform-org thread, labelled for the owner.
  const { data: rows } = await supabase
    .from("messages")
    .select("direction, body, created_at")
    .eq("conversation_id", args.conversationId)
    .order("created_at", { ascending: false })
    .limit(20);
  const turns = ((rows ?? []) as Array<{ direction: string; body: string | null }>)
    .filter((m) => (m.body ?? "").trim().length > 0)
    .reverse()
    .map<Turn>((m) => ({
      role: m.direction === "inbound" ? "user" : "assistant",
      // The assistant's own turns are labelled "You" so the model doesn't learn
      // to prefix its replies with its own name.
      content: `${m.direction === "inbound" ? "Owner" : "You"}: ${String(m.body)}`,
    }));

  const { assembleBrief } = await import("@/lib/ai-brief.server");
  const { userPrincipal } = await import("@/lib/ai-tools.server");

  // The brief and the retrieval probe don't need each other, so the owner
  // waits for the slower of the two rather than for both in turn. The probe
  // also decides how hard we think: nothing found means there is nothing to be
  // careful with, so the quick brain answers.
  const [brief, hasSources] = await Promise.all([
    assembleBrief(supabase, organizationId, agentId, {
      audience: "merchant",
      businessName: args.session.business_name ?? null,
      ownerName: args.session.owner_name ?? null,
    }),
    hasKnowledgeMatch(supabase, organizationId, agentId, args.question),
  ]);

  return executeRun(supabase, {
    organizationId,
    task: "agent_reply",
    agentId,
    conversationId: args.conversationId,
    actorUserId: args.session.user_id,
    actingRole: common.actingRole ?? null,
    principal: userPrincipal(args.session.user_id),
    history: turns.slice(0, -1),
    input: args.question,
    system: brief.text,
    promptRulesVersion: brief.rulesVersion,
    tier: hasSources ? "careful" : "everyday",
    useKnowledge: true,
    useTools: true,
    metadata: { channel: "onboarding", session_id: args.session.id },
    billingExempt: true,
    channel: "onboarding",
  });
}

/** Is there anything in the knowledge base worth being careful about here? */
async function hasKnowledgeMatch(
  supabase: SupabaseClient,
  organizationId: string,
  agentId: string | null,
  question: string,
): Promise<boolean> {
  try {
    const { embedTexts, EMBEDDING_MODEL } = await import("@/lib/ai-run.server");
    const [vector] = await embedTexts([question]);
    if (!vector) return false;
    const { data } = await supabase.rpc("match_knowledge_chunks", {
      p_org: organizationId,
      p_embedding: JSON.stringify(vector),
      p_embedding_model: EMBEDDING_MODEL,
      p_agent: agentId,
      p_limit: 1,
      p_min_similarity: 0.35,
    });
    return ((data ?? []) as unknown[]).length > 0;
  } catch {
    return false;
  }
}

/**
 * Straight after the crawl: three plain facts about the business and three
 * questions a customer might actually ask, taken only from what was read.
 * Used for the "here's what I learned" card on day one.
 */
export async function merchantFirstBrief(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    userId: string;
    sourceId: string;
    businessName: string;
  },
): Promise<{ facts: string[]; questions: string[] }> {
  const fallback = {
    facts: [] as string[],
    questions: ["What do you sell?", "What does it cost?", "Delivery kitna time?"],
  };

  try {
    const { data } = await supabase
      .from("knowledge_chunks")
      .select("text")
      .eq("organization_id", args.organizationId)
      .eq("source_id", args.sourceId)
      .order("chunk_index", { ascending: true })
      .limit(12);
    const material = ((data ?? []) as Array<{ text: string }>)
      .map((r) => r.text)
      .join("\n\n")
      .slice(0, 12000);
    if (!material.trim()) return fallback;

    const run = await executeRun(supabase, {
      organizationId: args.organizationId,
      task: "agent_reply",
      actorUserId: args.userId,
      tier: "everyday",
      input: `Material read from the website of ${args.businessName || "this business"}:\n\n${material}`,
      system:
        'Reply with JSON only, no prose, in this exact shape: {"facts":["...","...","..."],"questions":["...","...","..."]}. ' +
        "facts: three one-sentence facts about this business, each at most 110 characters, taken only from the material — never invented. " +
        "questions: three short questions a customer of this business might ask, each at most 20 characters, and write the third one in Hinglish.",
      metadata: { channel: "onboarding", purpose: "first_brief" },
      billingExempt: true,
      channel: "onboarding",
    });

    const raw = (run.output ?? "").replace(/```json|```/g, "").trim();
    const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json) as { facts?: unknown; questions?: unknown };
    const clean = (value: unknown, max: number): string[] =>
      Array.isArray(value)
        ? value
            .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
            .map((v) => v.trim().slice(0, max))
            .slice(0, 3)
        : [];

    const facts = clean(parsed.facts, 110);
    const questions = clean(parsed.questions, 20);
    return {
      facts,
      questions: questions.length === 3 ? questions : fallback.questions,
    };
  } catch {
    return fallback;
  }
}


/**
 * Owners teach without being asked: "Starter is ₹2,499 a month." That is a
 * fact about the business, not a question, and it must become a saved answer
 * rather than a friendly "got it" the model forgets a minute later.
 */
export async function classifyBusinessFact(
  supabase: SupabaseClient,
  common: Common,
  args: { conversationId: string; message: string; businessName?: string | null },
): Promise<{ isFact: boolean; question: string }> {
  const agentId = await defaultAgentId(supabase, common.organizationId);
  const run = await executeRun(supabase, {
    organizationId: common.organizationId,
    task: "summarise",
    agentId,
    conversationId: args.conversationId,
    actorUserId: common.actorUserId,
    actingRole: common.actingRole ?? null,
    input: args.message,
    tier: "everyday",
    useKnowledge: false,
    useTools: false,
    billingExempt: true,
    channel: "onboarding",
    system: [
      `The owner of ${args.businessName || "a business"} sent the message below on their own chat.`,
      "Decide whether it states a fact about their business that a customer might one day ask about — a price, a delivery time, an opening hour, a policy, what they sell.",
      "A question, a greeting, a thank-you, an instruction or small talk is NOT a fact.",
      'Answer with JSON only: {"is_fact_about_business": true|false, "question_it_answers": "the customer question this fact answers, in plain words"}',
      'If it is not a fact, answer {"is_fact_about_business": false, "question_it_answers": ""}.',
    ].join("\n"),
  });

  try {
    const raw = run.output.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(raw) as {
      is_fact_about_business?: boolean;
      question_it_answers?: string;
    };
    const question = String(parsed.question_it_answers ?? "").trim();
    return { isFact: parsed.is_fact_about_business === true && question.length > 0, question };
  } catch {
    return { isFact: false, question: "" };
  }
}
