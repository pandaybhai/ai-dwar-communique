/**
 * Real product proof for the public /demo page.
 *
 * An ISOLATED internal fixture workspace holding only fictional business data
 * is set up here, and the same retrieval + answer + uncertainty code path that
 * serves real customers is run against it. Nothing is ever sent: this module
 * calls `agentAnswer` directly and never touches messaging transport.
 *
 * Guarantees, by construction:
 *   - the fixture organization has no members, no real WhatsApp credentials
 *     and no billing enabled, so no wallet is debited and no person can see it;
 *   - no existing organization's knowledge, agent mode, number or messages are
 *     read or written here;
 *   - only an allowlist of sanitized fields is ever exposed publicly.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const FIXTURE_SLUG = "aidwar-internal-demo-fixture";
export const FIXTURE_BUSINESS = "Kaira Home Candles (fictional demo business)";

/** The whole world the fixture agent knows. Written by us, entirely fictional. */
const FIXTURE_DOCS = [
  {
    ref: "fixture://catalogue/lavender-soy-candle-200g",
    title: "Lavender Soy Candle 200g",
    kind: "product",
    content: [
      "Product: Lavender Soy Candle 200g.",
      "Price: 649 rupees.",
      "Burn time: about 40 hours.",
      "Wax: 100% soy wax with a cotton wick.",
      "Availability: in stock.",
    ].join("\n"),
  },
  {
    ref: "fixture://catalogue/sandalwood-jar-candle-300g",
    title: "Sandalwood Jar Candle 300g",
    kind: "product",
    content: [
      "Product: Sandalwood Jar Candle 300g.",
      "Price: 899 rupees.",
      "Burn time: about 55 hours.",
      "Wax: 100% soy wax in a reusable glass jar.",
      "Availability: in stock.",
    ].join("\n"),
  },
  {
    ref: "fixture://policies/delivery-and-returns",
    title: "Delivery and returns",
    kind: "policy",
    content: [
      "Delivery: orders ship across India and usually arrive in 3 to 5 working days.",
      "Returns: unused candles can be returned within 7 days of delivery.",
      "Note: this fixture deliberately contains NO wholesale or bulk discount policy.",
    ].join("\n"),
  },
] as const;

export const SOURCE_FACTS = FIXTURE_DOCS.map((d) => ({ title: d.title, content: d.content }));

export const SCENARIOS = {
  grounded: {
    question: "Lavender soy candle 200g ka price aur burn time kya hai?",
    label: "A question the fixture catalogue can answer",
  },
  handoff: {
    question: "Bulk order pe kitna discount milega? 50 pieces chahiye.",
    label: "A question the fixture catalogue deliberately cannot answer",
  },
} as const;

export type Scenario = keyof typeof SCENARIOS;

type Ids = {
  organizationId: string;
  agentId: string;
  conversationId: string;
  sourceId: string;
};

async function one<T>(
  supabase: SupabaseClient,
  table: string,
  match: Record<string, unknown>,
  insert: Record<string, unknown>,
): Promise<T> {
  let query = supabase.from(table).select("*");
  for (const [key, value] of Object.entries(match)) query = query.eq(key, value as never);
  const { data: found } = await query.limit(1).maybeSingle();
  if (found) return found as T;
  const { data, error } = await supabase.from(table).insert(insert).select("*").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data as T;
}

/** Creates (or reuses) the isolated fixture workspace and its fictional knowledge. */
export async function ensureFixture(supabase: SupabaseClient): Promise<Ids> {
  const org = await one<{ id: string }>(
    supabase,
    "organizations",
    { slug: FIXTURE_SLUG },
    { slug: FIXTURE_SLUG, name: FIXTURE_BUSINESS, status: "active", plan_status: "trial" },
  );
  const organizationId = org.id;

  // AI on, a valid cap, and billing deliberately never enabled for this org.
  await supabase
    .from("organization_ai_settings")
    .upsert(
      { organization_id: organizationId, ai_enabled: true, ai_monthly_cap_amount: 50 },
      { onConflict: "organization_id" },
    );

  const agent = await one<{ id: string }>(
    supabase,
    "ai_agents",
    { organization_id: organizationId, is_default: true },
    { organization_id: organizationId, name: "Aiden", is_default: true, mode: "off" },
  );

  // A placeholder number row: no waba_id, no token, never used to send.
  const account = await one<{ id: string }>(
    supabase,
    "whatsapp_accounts",
    { organization_id: organizationId },
    {
      organization_id: organizationId,
      phone_number_id: `fixture-${organizationId.slice(0, 8)}`,
      display_phone_number: "+00 0000 000000",
      verified_name: FIXTURE_BUSINESS,
      status: "pending",
      is_default: true,
    },
  );

  const contact = await one<{ id: string }>(
    supabase,
    "contacts",
    { organization_id: organizationId, phone: "+910000000000" },
    {
      organization_id: organizationId,
      phone: "+910000000000",
      wa_id: "910000000000",
      name: "Demo customer (fictional)",
      source: "direct",
    },
  );

  const conversation = await one<{ id: string }>(
    supabase,
    "conversations",
    { organization_id: organizationId, contact_id: contact.id },
    {
      organization_id: organizationId,
      contact_id: contact.id,
      whatsapp_account_id: account.id,
      status: "open",
      last_customer_message_at: new Date().toISOString(),
    },
  );

  const source = await one<{ id: string }>(
    supabase,
    "knowledge_sources",
    { organization_id: organizationId, name: "Fictional demo catalogue" },
    {
      organization_id: organizationId,
      agent_id: agent.id,
      type: "manual_qa",
      name: "Fictional demo catalogue",
      status: "ready",
      config: { fixture: true },
    },
  );

  await ensureKnowledge(supabase, organizationId, source.id);

  return {
    organizationId,
    agentId: agent.id,
    conversationId: conversation.id,
    sourceId: source.id,
  };
}

async function ensureKnowledge(
  supabase: SupabaseClient,
  organizationId: string,
  sourceId: string,
): Promise<void> {
  const { embedTexts, EMBEDDING_MODEL } = await import("@/lib/ai-run.server");

  for (const doc of FIXTURE_DOCS) {
    const { data: existing } = await supabase
      .from("knowledge_documents")
      .select("id, content")
      .eq("source_id", sourceId)
      .eq("source_ref", doc.ref)
      .maybeSingle();

    let documentId = (existing as { id?: string } | null)?.id ?? null;
    if (!documentId) {
      const { data, error } = await supabase
        .from("knowledge_documents")
        .insert({
          organization_id: organizationId,
          source_id: sourceId,
          source_ref: doc.ref,
          title: doc.title,
          content: doc.content,
          metadata: { kind: doc.kind, fixture: true },
        })
        .select("id")
        .single();
      if (error) throw new Error(`knowledge_documents: ${error.message}`);
      documentId = (data as { id: string }).id;
    }

    const { count } = await supabase
      .from("knowledge_chunks")
      .select("id", { count: "exact", head: true })
      .eq("document_id", documentId)
      .eq("embedding_model", EMBEDDING_MODEL);
    if ((count ?? 0) > 0) continue;

    const text = `${doc.title}\n${doc.content}`;
    const [vector] = await embedTexts([text]);
    if (!vector) throw new Error("Embedding unavailable — cannot build the fixture.");
    const { error } = await supabase.from("knowledge_chunks").insert({
      organization_id: organizationId,
      source_id: sourceId,
      document_id: documentId,
      source_ref: doc.ref,
      chunk_index: 0,
      text,
      embedding: JSON.stringify(vector),
      embedding_model: EMBEDDING_MODEL,
    });
    if (error) throw new Error(`knowledge_chunks: ${error.message}`);
  }

  await supabase
    .from("knowledge_sources")
    .update({ status: "ready", item_count: FIXTURE_DOCS.length, last_synced_at: new Date().toISOString() })
    .eq("id", sourceId);
}

/**
 * Runs one scenario through the real customer-answer path and records what
 * actually came back. Returns the stored row id.
 */
export async function captureScenario(
  supabase: SupabaseClient,
  scenario: Scenario,
): Promise<Record<string, unknown>> {
  const ids = await ensureFixture(supabase);
  const { agentAnswer } = await import("@/lib/ai-tasks.server");

  // Every capture starts a fresh fixture conversation, so an earlier capture's
  // run history can never make the next one look like a repeated question.
  const conversationId = await freshConversation(supabase, ids);

  const question = SCENARIOS[scenario].question;
  const run = await agentAnswer(
    supabase,
    { organizationId: ids.organizationId, actorUserId: null, actingRole: null },
    conversationId,
    question,
  );

  // What the product would do next with this run, stated plainly.
  // The fixture agent is in Draft mode, so an answer is a DRAFT for the owner —
  // never an automatic send. No message was transmitted in either case.
  const workflow =
    run.status === "ok" && !run.escalationSignal
      ? "Answered from the catalogue and saved as a draft for the owner to review. Nothing was sent: this fixture has no connected number."
      : `Held for the owner instead of answering — signal "${run.escalationSignal ?? run.status}". In the product this marks the conversation Needs you. Nothing was sent.`;

  const { data, error } = await supabase
    .from("demo_proof_runs")
    .insert({
      scenario,
      question,
      answer: run.output ?? "",
      status: run.status,
      escalation_signal: run.escalationSignal,
      workflow_state: workflow,
      run_id: run.runId,
      provider: run.provider,
      model: run.model,
      model_display: run.brainName,
      tier: run.tier,
      latency_ms: run.latencyMs,
      source_facts: SOURCE_FACTS,
      fixture_note:
        "Recorded from an isolated internal AiDwar workspace containing only fictional business data. No customer data, no messages sent.",
    })
    .select("*")
    .single();
  if (error) throw new Error(`demo_proof_runs: ${error.message}`);
  return data as Record<string, unknown>;
}

/** A brand-new fixture conversation for one capture. */
async function freshConversation(supabase: SupabaseClient, ids: Ids): Promise<string> {
  const { data: conversation } = await supabase
    .from("conversations")
    .select("contact_id, whatsapp_account_id")
    .eq("id", ids.conversationId)
    .single();
  const row = conversation as { contact_id: string; whatsapp_account_id: string | null };
  // Only one live conversation per fixture number, so close the previous one.
  await supabase
    .from("conversations")
    .update({ status: "closed" })
    .eq("organization_id", ids.organizationId)
    .eq("contact_id", row.contact_id)
    .neq("status", "closed");
  const { data, error } = await supabase
    .from("conversations")
    .insert({
      organization_id: ids.organizationId,
      contact_id: row.contact_id,
      whatsapp_account_id: row.whatsapp_account_id,
      status: "open",
      last_customer_message_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw new Error(`conversations: ${error.message}`);
  return (data as { id: string }).id;
}

/* ------------------------------------------------------------- public read */

export type PublicProof = {
  scenario: Scenario;
  question: string;
  answer: string;
  status: string;
  escalation_signal: string | null;
  workflow_state: string;
  model_display: string | null;
  captured_at: string;
  source_facts: Array<{ title: string; content: string }>;
};

/** Strict allowlist: nothing else from the table may reach the public page. */
export async function listPublishedProof(supabase: SupabaseClient): Promise<PublicProof[]> {
  const { data } = await supabase
    .from("demo_proof_runs")
    .select(
      "scenario, question, answer, status, escalation_signal, workflow_state, model_display, captured_at, source_facts",
    )
    .eq("is_published", true)
    .order("captured_at", { ascending: false })
    .limit(20);

  const seen = new Set<string>();
  const out: PublicProof[] = [];
  for (const row of (data ?? []) as PublicProof[]) {
    if (seen.has(row.scenario)) continue;
    seen.add(row.scenario);
    out.push(row);
  }
  return out.sort((a, b) => (a.scenario === "grounded" ? -1 : b.scenario === "grounded" ? 1 : 0));
}
