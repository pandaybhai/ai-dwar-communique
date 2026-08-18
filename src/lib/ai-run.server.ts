/**
 * The single place in this codebase that calls a model.
 *
 * Everything else — inbox suggestions, the agent, the playground, comparison,
 * embedding — comes through here or through /api/internal/ai-run, which is a
 * thin HTTP wrapper around it. That is what makes cost, tool use and refusals
 * countable: there is one door.
 *
 * Two rules hold throughout:
 *  1. Tools are loaded with brokerTools() and executed with invokeTool(). This
 *     file never touches workspace data directly, so a model can never reach
 *     past the permissions of the person it is acting for.
 *  2. Spend is checked against real recorded cost before the call and recorded
 *     after it. Over the cap a run refuses (status 'capped') instead of quietly
 *     degrading to a worse answer.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { brokerTools, invokeTool, type BrokeredTool } from "@/lib/ai-tools.server";

const GATEWAY = "https://ai.gateway.lovable.dev/v1";

export type AiTask = "suggest_reply" | "summarise" | "auto_tag" | "agent_reply" | "embedding";

export type ResolvedBrain = {
  provider: string;
  model_id: string;
  display_name: string;
  supports_tools: boolean;
  /** Where the choice came from, for the "why this brain" line. */
  origin: "task" | "agent" | "workspace" | "platform";
};

export type RunSource = {
  kind: "knowledge" | "tool";
  label: string;
  ref?: string;
  similarity?: number;
};

export type RunOptions = {
  organizationId: string;
  task: AiTask;
  /** Plain user-visible question or instruction. */
  input: string;
  system?: string;
  agentId?: string | null;
  conversationId?: string | null;
  contactId?: string | null;
  actorUserId?: string | null;
  actingRole?: string | null;
  /** Force a brain instead of resolving one (comparison, playground). */
  brain?: { provider: string; model_id: string } | null;
  /** Let the model call brokered tools. */
  useTools?: boolean;
  /** Retrieve from the knowledge base before answering. */
  useKnowledge?: boolean;
  comparisonId?: string | null;
  /** Prior turns, oldest first. */
  history?: { role: "user" | "assistant"; content: string }[];
  maxSteps?: number;
  /** Skip writing an ai_runs row (never used by product surfaces). */
  dryRun?: boolean;
};

export type RunResult = {
  runId: string | null;
  status: "ok" | "refused" | "escalated" | "capped" | "error";
  output: string;
  sources: RunSource[];
  toolCalls: {
    tool: string;
    ok: boolean;
    error?: string;
    latencyMs?: number;
    activityLogId?: string | null;
  }[];
  escalationSignal: string | null;
  costAmount: number | null;
  costCurrency: string | null;
  costKnown: boolean;
  latencyMs: number;
  provider: string;
  model: string;
  brainName: string;
  inputTokens: number | null;
  outputTokens: number | null;
  error?: string;
};

// ------------------------------------------------------------------ brains

const PLATFORM_DEFAULTS: Record<AiTask, { provider: string; model_id: string }> = {
  auto_tag: { provider: "lovable", model_id: "google/gemini-3.1-flash-lite" },
  summarise: { provider: "lovable", model_id: "google/gemini-3.6-flash" },
  suggest_reply: { provider: "lovable", model_id: "google/gemini-3.6-flash" },
  agent_reply: { provider: "lovable", model_id: "openai/gpt-5.4" },
  embedding: { provider: "lovable", model_id: "openai/text-embedding-3-small" },
};

export const EMBEDDING_MODEL = PLATFORM_DEFAULTS.embedding.model_id;

/** per-task -> per-agent -> workspace default -> platform default. */
export async function resolveBrain(
  supabase: SupabaseClient,
  organizationId: string,
  task: AiTask,
  agentId?: string | null,
): Promise<ResolvedBrain> {
  const { data: settings } = await supabase
    .from("organization_ai_settings")
    .select("brain_choice")
    .eq("organization_id", organizationId)
    .maybeSingle();
  const manual = (settings as { brain_choice?: string } | null)?.brain_choice === "manual";

  let picked: { provider: string; model_id: string } | null = null;
  let origin: ResolvedBrain["origin"] = "platform";

  if (manual) {
    const { data: rows } = await supabase
      .from("ai_task_models")
      .select("provider, model_id, agent_id")
      .eq("organization_id", organizationId)
      .eq("task", task);
    const list = (rows ?? []) as Array<{ provider: string; model_id: string; agent_id: string | null }>;
    const forAgent = agentId ? list.find((r) => r.agent_id === agentId) : undefined;
    const forOrg = list.find((r) => r.agent_id === null);
    if (forAgent) {
      picked = forAgent;
      origin = "task";
    } else if (forOrg) {
      picked = forOrg;
      origin = "agent";
    }
  }

  if (!picked) {
    const { data: provider } = await supabase
      .from("ai_providers")
      .select("provider, model")
      .eq("organization_id", organizationId)
      .eq("is_default", true)
      .eq("status", "active")
      .maybeSingle();
    const p = provider as { provider: string; model: string | null } | null;
    if (p?.model) {
      picked = { provider: p.provider, model_id: p.model };
      origin = "workspace";
    }
  }

  if (!picked) {
    picked = PLATFORM_DEFAULTS[task];
    origin = "platform";
  }

  const { data: model } = await supabase
    .from("ai_models")
    .select("display_name, supports_tools, is_available, is_deprecated")
    .eq("provider", picked.provider)
    .eq("model_id", picked.model_id)
    .maybeSingle();
  const m = model as
    | { display_name: string; supports_tools: boolean; is_available: boolean; is_deprecated: boolean }
    | null;

  // A retired or unknown brain never reaches the gateway.
  if (!m || !m.is_available || m.is_deprecated) {
    const fallback = PLATFORM_DEFAULTS[task];
    return {
      provider: fallback.provider,
      model_id: fallback.model_id,
      display_name: "Everyday",
      supports_tools: true,
      origin: "platform",
    };
  }

  return {
    provider: picked.provider,
    model_id: picked.model_id,
    display_name: m.display_name,
    supports_tools: m.supports_tools,
    origin,
  };
}

// -------------------------------------------------------------------- keys

/**
 * The gateway key for a provider. Workspace-supplied keys live in Supabase
 * Vault and are read here, server side, by name only — the name is all that is
 * ever stored in a readable table.
 */
async function resolveApiKey(
  supabase: SupabaseClient,
  organizationId: string,
  provider: string,
): Promise<{ key: string | null; base: string }> {
  if (provider === "lovable") {
    return { key: process.env["LOVABLE_API_KEY"] ?? null, base: GATEWAY };
  }
  const { data } = await supabase
    .from("ai_providers")
    .select("vault_secret_name")
    .eq("organization_id", organizationId)
    .eq("provider", provider)
    .maybeSingle();
  const name = (data as { vault_secret_name?: string } | null)?.vault_secret_name;
  if (!name) return { key: null, base: GATEWAY };
  const { data: secret } = await supabase
    .schema("vault")
    .from("decrypted_secrets")
    .select("decrypted_secret")
    .eq("name", name)
    .maybeSingle();
  const key = (secret as { decrypted_secret?: string } | null)?.decrypted_secret ?? null;
  return { key, base: GATEWAY };
}

// ----------------------------------------------------------------- pricing

async function priceRun(
  supabase: SupabaseClient,
  provider: string,
  model: string,
  inputTokens: number | null,
  outputTokens: number | null,
): Promise<{ amount: number | null; currency: string | null; source: "rate_card" | "unknown" }> {
  if (inputTokens === null && outputTokens === null) {
    return { amount: null, currency: null, source: "unknown" };
  }
  const { data } = await supabase
    .from("ai_rates")
    .select("input_rate, output_rate, currency")
    .eq("provider", provider)
    .eq("model", model)
    .lte("effective_from", new Date().toISOString().slice(0, 10))
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  const rate = data as { input_rate: number; output_rate: number; currency: string } | null;
  if (!rate) return { amount: null, currency: null, source: "unknown" };
  const amount =
    ((inputTokens ?? 0) * Number(rate.input_rate) + (outputTokens ?? 0) * Number(rate.output_rate)) /
    1_000_000;
  return { amount: Number(amount.toFixed(6)), currency: rate.currency, source: "rate_card" };
}

async function overCap(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<{ over: boolean; cap: number; spent: number; currency: string }> {
  const { data: settings } = await supabase
    .from("organization_ai_settings")
    .select("ai_monthly_cap_amount, currency")
    .eq("organization_id", organizationId)
    .maybeSingle();
  const s = settings as { ai_monthly_cap_amount: number; currency: string } | null;
  const cap = Number(s?.ai_monthly_cap_amount ?? 0);
  const { data: spend } = await supabase.rpc("ai_month_spend", { p_org: organizationId });
  const spent = Number(spend ?? 0);
  return { over: cap > 0 && spent >= cap, cap, spent, currency: s?.currency ?? "INR" };
}

// -------------------------------------------------------------- gateway I/O

type ChatMessage = { role: string; content: unknown; [k: string]: unknown };

type GatewayCall = {
  text: string;
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
  inputTokens: number | null;
  outputTokens: number | null;
  raw: unknown;
};

function gatewayHeaders(key: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Lovable-API-Key": key,
    "X-Lovable-AIG-SDK": "fetch",
  };
}

/** Human words for a gateway failure. Only 429/5xx are worth retrying. */
export function gatewayErrorMessage(status: number, body: string): string {
  if (status === 402) return "This workspace has run out of AI credit.";
  if (status === 403) return "AI is switched off for this workspace.";
  if (status === 401) return "The AI connection isn't set up correctly.";
  if (status === 429) return "Too many AI requests right now. Try again in a moment.";
  if (status >= 500) return "The AI service is having trouble. Try again in a moment.";
  return body.slice(0, 200) || "The AI couldn't complete that.";
}

/** Chat-completions path — everything that is not an OpenAI model. */
async function callChatCompletions(
  base: string,
  key: string,
  model: string,
  messages: ChatMessage[],
  tools: BrokeredTool[],
): Promise<GatewayCall> {
  const body: Record<string, unknown> = { model, messages };
  if (tools.length > 0) {
    body["tools"] = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: gatewayHeaders(key),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(gatewayErrorMessage(res.status, await res.text()));
  }
  const json = (await res.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const message = json.choices?.[0]?.message;
  return {
    text: message?.content ?? "",
    toolCalls: (message?.tool_calls ?? []).map((c) => ({
      id: c.id,
      name: c.function.name,
      args: safeJson(c.function.arguments),
    })),
    inputTokens: json.usage?.prompt_tokens ?? null,
    outputTokens: json.usage?.completion_tokens ?? null,
    raw: message ?? null,
  };
}

/**
 * Responses path — OpenAI models. Always streamed: these models think for
 * minutes and a buffered request is severed by the platform long before it
 * finishes, while still being billed.
 */
async function callResponses(
  base: string,
  key: string,
  model: string,
  input: unknown[],
  tools: BrokeredTool[],
): Promise<GatewayCall & { items: unknown[] }> {
  const body: Record<string, unknown> = { model, input, stream: true, store: false };
  if (tools.length > 0) {
    body["tools"] = tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: strictSchema(t.parameters),
      strict: false,
    }));
  }
  const res = await fetch(`${base}/responses`, {
    method: "POST",
    headers: gatewayHeaders(key),
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    throw new Error(gatewayErrorMessage(res.status, res.ok ? "" : await res.text()));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: Record<string, unknown> | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      for (const line of part.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const evt = JSON.parse(payload) as Record<string, unknown>;
          if (evt["type"] === "response.completed") {
            completed = evt["response"] as Record<string, unknown>;
          }
        } catch {
          // a partial frame — the next chunk completes it
        }
      }
    }
  }

  if (!completed) throw new Error("The AI stopped before it finished answering.");

  const output = (completed["output"] ?? []) as Array<Record<string, unknown>>;
  const text = output
    .filter((i) => i["type"] === "message")
    .flatMap((i) => ((i["content"] ?? []) as Array<Record<string, unknown>>))
    .filter((c) => c["type"] === "output_text")
    .map((c) => String(c["text"] ?? ""))
    .join("")
    .trim();
  const toolCalls = output
    .filter((i) => i["type"] === "function_call")
    .map((i) => ({
      id: String(i["call_id"] ?? i["id"] ?? ""),
      name: String(i["name"] ?? ""),
      args: safeJson(String(i["arguments"] ?? "{}")),
    }));
  const usage = (completed["usage"] ?? {}) as Record<string, number>;

  return {
    text,
    toolCalls,
    inputTokens: usage["input_tokens"] ?? null,
    outputTokens: usage["output_tokens"] ?? null,
    raw: completed,
    items: output,
  };
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The Responses API prefers strict-shaped schemas. */
function strictSchema(schema: BrokeredTool["parameters"]): Record<string, unknown> {
  return {
    type: "object",
    properties: schema.properties ?? {},
    required: Object.keys(schema.properties ?? {}),
    additionalProperties: false,
  };
}

const isOpenAiModel = (model: string) => model.startsWith("openai/");

// -------------------------------------------------------------- embeddings

/** The only embedding call in the codebase. Returns one vector per input. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const key = process.env["LOVABLE_API_KEY"];
  if (!key) throw new Error("AI isn't connected on this deployment.");
  const out: number[][] = [];
  // The gateway caps batch size; 64 keeps every request comfortably inside it.
  for (let i = 0; i < texts.length; i += 64) {
    const batch = texts.slice(i, i + 64);
    const res = await fetch(`${GATEWAY}/embeddings`, {
      method: "POST",
      headers: gatewayHeaders(key),
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch }),
    });
    if (!res.ok) throw new Error(gatewayErrorMessage(res.status, await res.text()));
    const json = (await res.json()) as { data?: Array<{ embedding: number[] }> };
    for (const row of json.data ?? []) out.push(row.embedding);
  }
  return out;
}

// --------------------------------------------------------------- the run

const ESCALATION_TOPICS = [
  "refund",
  "return money",
  "chargeback",
  "complaint",
  "cancel my order",
  "cancel order",
  "legal",
  "police",
  "fraud",
];

function topicNeedsHuman(question: string, extraRules: string): string | null {
  const q = question.toLowerCase();
  for (const topic of ESCALATION_TOPICS) {
    if (q.includes(topic)) return "sensitive_topic";
  }
  const rules = extraRules
    .toLowerCase()
    .split(/[\n,]/)
    .map((r) => r.trim())
    .filter((r) => r.length > 2);
  for (const rule of rules) {
    if (q.includes(rule)) return "merchant_rule";
  }
  return null;
}

export async function executeRun(
  supabase: SupabaseClient,
  options: RunOptions,
): Promise<RunResult> {
  const started = Date.now();
  const {
    organizationId,
    task,
    input,
    agentId = null,
    conversationId = null,
    contactId = null,
    actorUserId = null,
    actingRole = null,
    comparisonId = null,
    useTools = false,
    useKnowledge = false,
    history = [],
    maxSteps = 4,
  } = options;

  const brain = options.brain
    ? {
        ...(await resolveBrain(supabase, organizationId, task, agentId)),
        provider: options.brain.provider,
        model_id: options.brain.model_id,
      }
    : await resolveBrain(supabase, organizationId, task, agentId);

  const base: RunResult = {
    runId: null,
    status: "ok",
    output: "",
    sources: [],
    toolCalls: [],
    escalationSignal: null,
    costAmount: null,
    costCurrency: null,
    costKnown: false,
    latencyMs: 0,
    provider: brain.provider,
    model: brain.model_id,
    brainName: brain.display_name,
    inputTokens: null,
    outputTokens: null,
  };

  const finish = async (result: RunResult): Promise<RunResult> => {
    result.latencyMs = Date.now() - started;
    if (options.dryRun) return result;
    const { data } = await supabase
      .from("ai_runs")
      .insert({
        organization_id: organizationId,
        agent_id: agentId,
        conversation_id: conversationId,
        contact_id: contactId,
        user_id: actorUserId,
        acting_role: actingRole,
        provider: result.provider,
        model: result.model,
        task,
        input_summary: input.slice(0, 500),
        output: result.output.slice(0, 8000),
        escalation_signal: result.escalationSignal,
        sources: result.sources,
        tool_call_count: result.toolCalls.length,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        cost_amount: result.costAmount,
        cost_currency: result.costCurrency,
        cost_source: result.costKnown ? "rate_card" : "unknown",
        latency_ms: result.latencyMs,
        status: result.status,
        error: result.error ?? null,
        comparison_id: comparisonId,
      })
      .select("id")
      .maybeSingle();
    result.runId = (data as { id?: string } | null)?.id ?? null;
    if (result.runId) {
      // One row per tool invocation, written only now because run_id is NOT NULL.
      if (result.toolCalls.length) {
        const { error: traceError } = await supabase.from("ai_tool_calls").insert(
          result.toolCalls.map((call) => ({
            organization_id: organizationId,
            run_id: result.runId,
            tool_name: call.tool,
            ok: call.ok,
            error: call.error ?? null,
            latency_ms: call.latencyMs ?? null,
            activity_log_id: call.activityLogId ?? null,
          })),
        );
        if (traceError) {
          console.error("[ai-run] tool call trace not written", traceError.message);
        }
      }
      await rollUpUsage(supabase, organizationId, task, result);
    }
    return result;
  };

  // ------------------------------------------------------------ kill switch
  const { data: settings } = await supabase
    .from("organization_ai_settings")
    .select("ai_enabled")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!(settings as { ai_enabled?: boolean } | null)?.ai_enabled) {
    return finish({
      ...base,
      status: "refused",
      output: "",
      error: "AI is switched off for this workspace.",
    });
  }

  const cap = await overCap(supabase, organizationId);
  if (cap.over) {
    return finish({
      ...base,
      status: "capped",
      output: "",
      error: `This month's AI spending limit (${cap.currency} ${cap.cap}) has been reached.`,
    });
  }

  const { key } = await resolveApiKey(supabase, organizationId, brain.provider);
  if (!key) {
    return finish({ ...base, status: "error", error: "No AI connection is set up." });
  }

  // ------------------------------------------------------------- knowledge
  const sources: RunSource[] = [];
  let knowledgeBlock = "";
  if (useKnowledge) {
    try {
      const [vector] = await embedTexts([input]);
      if (vector) {
        const { data: matches } = await supabase.rpc("match_knowledge_chunks", {
          p_org: organizationId,
          p_embedding: JSON.stringify(vector),
          p_embedding_model: EMBEDDING_MODEL,
          p_agent: agentId,
          p_limit: 6,
          p_min_similarity: 0.35,
        });
        const rows = (matches ?? []) as Array<{
          source_name: string;
          source_ref: string;
          title: string;
          text: string;
          similarity: number;
        }>;
        for (const row of rows) {
          sources.push({
            kind: "knowledge",
            label: row.title || row.source_name,
            ref: row.source_ref,
            similarity: Number(row.similarity),
          });
        }
        knowledgeBlock = rows
          .map((r, i) => `[${i + 1}] ${r.title || r.source_name}\n${r.text}`)
          .join("\n\n");
      }
    } catch {
      // Retrieval failing is itself a reason to hand over, handled below.
    }
  }

  // -------------------------------------------------------------- messages
  const systemParts = [options.system ?? ""];
  if (knowledgeBlock) {
    systemParts.push(
      `Use only the following material to answer. Cite the number of the item you used. If it does not answer the question, say you don't know.\n\n${knowledgeBlock}`,
    );
  }
  const system = systemParts.filter(Boolean).join("\n\n");

  const tools = useTools
    ? await brokerTools(supabase, organizationId, actorUserId)
    : ([] as BrokeredTool[]);

  const toolCalls: RunResult["toolCalls"] = [];
  let anyToolFailed = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let answer = "";

  try {
    if (isOpenAiModel(brain.model_id)) {
      const items: unknown[] = [];
      if (system) items.push({ role: "system", content: [{ type: "input_text", text: system }] });
      for (const turn of history) {
        items.push({
          role: turn.role,
          content: [
            turn.role === "assistant"
              ? { type: "output_text", text: turn.content }
              : { type: "input_text", text: turn.content },
          ],
        });
      }
      items.push({ role: "user", content: [{ type: "input_text", text: input }] });

      for (let step = 0; step < maxSteps; step += 1) {
        const call = await callResponses(GATEWAY, key, brain.model_id, items, tools);
        inputTokens += call.inputTokens ?? 0;
        outputTokens += call.outputTokens ?? 0;
        answer = call.text || answer;
        if (call.toolCalls.length === 0) break;
        // The function_call items must travel with their outputs.
        items.push(...call.items);
        for (const tc of call.toolCalls) {
          const result = await runTool(supabase, organizationId, actorUserId, tc.name, tc.args);
          if (!result.ok) anyToolFailed = true;
          toolCalls.push({
            tool: tc.name,
            ok: result.ok,
            ...(result.error ? { error: result.error } : {}),
            ...(typeof result.latencyMs === "number" ? { latencyMs: result.latencyMs } : {}),
            activityLogId: result.activityLogId ?? null,
          });
          sources.push({ kind: "tool", label: tc.name });
          items.push({
            type: "function_call_output",
            call_id: tc.id,
            output: JSON.stringify(modelView(result)).slice(0, 6000),
          });
        }
      }
    } else {
      const messages: ChatMessage[] = [];
      if (system) messages.push({ role: "system", content: system });
      for (const turn of history) messages.push({ role: turn.role, content: turn.content });
      messages.push({ role: "user", content: input });

      for (let step = 0; step < maxSteps; step += 1) {
        const call = await callChatCompletions(GATEWAY, key, brain.model_id, messages, tools);
        inputTokens += call.inputTokens ?? 0;
        outputTokens += call.outputTokens ?? 0;
        answer = call.text || answer;
        if (call.toolCalls.length === 0) break;
        messages.push(call.raw as ChatMessage);
        for (const tc of call.toolCalls) {
          const result = await runTool(supabase, organizationId, actorUserId, tc.name, tc.args);
          if (!result.ok) anyToolFailed = true;
          toolCalls.push({
            tool: tc.name,
            ok: result.ok,
            ...(result.error ? { error: result.error } : {}),
            ...(typeof result.latencyMs === "number" ? { latencyMs: result.latencyMs } : {}),
            activityLogId: result.activityLogId ?? null,
          });
          sources.push({ kind: "tool", label: tc.name });
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify(modelView(result)).slice(0, 6000),
          });
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "The AI couldn't complete that.";
    const priced = await priceRun(supabase, brain.provider, brain.model_id, inputTokens, outputTokens);
    return finish({
      ...base,
      status: "error",
      error: message,
      sources,
      toolCalls,
      inputTokens: inputTokens || null,
      outputTokens: outputTokens || null,
      costAmount: priced.amount,
      costCurrency: priced.currency,
      costKnown: priced.source === "rate_card",
    });
  }

  const priced = await priceRun(supabase, brain.provider, brain.model_id, inputTokens, outputTokens);

  const result: RunResult = {
    ...base,
    output: answer.trim(),
    sources,
    toolCalls,
    inputTokens: inputTokens || null,
    outputTokens: outputTokens || null,
    costAmount: priced.amount,
    costCurrency: priced.currency,
    costKnown: priced.source === "rate_card",
  };

  // ------------------------------------------------- signal-based hand-over
  // Only for conversation work. A summary or a tag never escalates.
  if (task === "agent_reply") {
    const signal = decideEscalation({
      question: input,
      answer: result.output,
      knowledgeMatched: sources.some((s) => s.kind === "knowledge"),
      toolUsed: toolCalls.length > 0,
      anyToolFailed,
      history,
      merchantRules: options.system ?? "",
    });
    if (signal) {
      result.status = "escalated";
      result.escalationSignal = signal;
    }
  }

  if (!result.output && result.status === "ok") {
    result.status = "refused";
    result.error = "The AI had nothing to say.";
  }

  return finish(result);
}

/** Observable signals only — never the model's own opinion of its certainty. */
export function decideEscalation(input: {
  question: string;
  answer: string;
  knowledgeMatched: boolean;
  toolUsed: boolean;
  anyToolFailed: boolean;
  history: { role: "user" | "assistant"; content: string }[];
  merchantRules: string;
}): string | null {
  if (input.anyToolFailed) return "tool_failed";

  const topic = topicNeedsHuman(input.question, input.merchantRules);
  if (topic) return topic;

  const asked = input.history.filter((h) => h.role === "user").map((h) => h.content.toLowerCase().trim());
  const now = input.question.toLowerCase().trim();
  if (asked.includes(now)) return "question_repeated";

  const frustration = ["not helpful", "useless", "speak to a human", "agent please", "this is ridiculous", "worst"];
  if (frustration.some((f) => now.includes(f))) return "customer_frustrated";

  if (!input.knowledgeMatched && !input.toolUsed) return "no_source";

  return null;
}

/** Trace fields are ours, not the model's — keep them out of the prompt. */
function modelView(result: { ok: boolean; data?: unknown; error?: string }) {
  return { ok: result.ok, ...(result.data !== undefined ? { data: result.data } : {}), ...(result.error ? { error: result.error } : {}) };
}

async function runTool(
  supabase: SupabaseClient,
  organizationId: string,
  actorUserId: string | null,
  name: string,
  args: Record<string, unknown>,
) {
  return invokeTool(
    { supabase, organizationId, actorUserId, initiatedBy: "ai" },
    name,
    args,
  );
}

async function rollUpUsage(
  supabase: SupabaseClient,
  organizationId: string,
  task: string,
  result: RunResult,
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const { data: existing } = await supabase
    .from("ai_usage")
    .select("id, runs, input_tokens, output_tokens, cost_amount")
    .eq("organization_id", organizationId)
    .eq("usage_date", today)
    .eq("task", task)
    .maybeSingle();
  const row = existing as
    | { id: string; runs: number; input_tokens: number; output_tokens: number; cost_amount: number }
    | null;
  if (row) {
    await supabase
      .from("ai_usage")
      .update({
        runs: row.runs + 1,
        input_tokens: Number(row.input_tokens) + (result.inputTokens ?? 0),
        output_tokens: Number(row.output_tokens) + (result.outputTokens ?? 0),
        cost_amount: Number(row.cost_amount) + (result.costAmount ?? 0),
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
  } else {
    await supabase.from("ai_usage").insert({
      organization_id: organizationId,
      usage_date: today,
      task,
      runs: 1,
      input_tokens: result.inputTokens ?? 0,
      output_tokens: result.outputTokens ?? 0,
      cost_amount: result.costAmount ?? 0,
      currency: result.costCurrency ?? "INR",
    });
  }
}
