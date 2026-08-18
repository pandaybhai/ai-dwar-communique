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

/**
 * Where each vendor is called directly, when the platform holds that vendor's
 * own key instead of routing through the resale gateway. Every entry speaks
 * the OpenAI-compatible chat-completions shape, so one code path serves all.
 * Adding a future vendor is one line here plus a row in `ai_models`.
 */
const DIRECT_ENDPOINTS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
};

/** The model name a vendor expects when called directly, without its prefix. */
function wireModel(provider: string, modelId: string): string {
  const prefix = `${provider}/`;
  return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
}


export type AiTask = "suggest_reply" | "summarise" | "auto_tag" | "agent_reply" | "embedding";

export type ResolvedBrain = {
  /** Platform-internal. Never travels to a merchant surface. */
  provider: string;
  /** Platform-internal. Never travels to a merchant surface. */
  model_id: string;
  /** The merchant-facing tier key: "everyday", "careful". */
  tier: string;
  /** The words a merchant sees: "Everyday", "Careful". */
  display_name: string;
  supports_tools: boolean;
  /** Where the choice came from, for the "why this tier" line. */
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
  /** Force a tier instead of resolving one (comparison, playground). */
  tier?: string | null;
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
  /** What the provider charges the platform. Platform-internal, never shown. */
  costAmount: number | null;
  costCurrency: string | null;
  /** What the merchant pays: cost x markup. The only money a merchant sees. */
  billedAmount: number | null;
  billedCurrency: string | null;
  markupMultiplier: number | null;
  costKnown: boolean;
  latencyMs: number;
  /** Platform-internal. */
  provider: string;
  /** Platform-internal. */
  model: string;
  tier: string;
  brainName: string;
  inputTokens: number | null;
  outputTokens: number | null;
  error?: string;
};

// ------------------------------------------------------------------- tiers

/**
 * Merchants pick a tier; the platform decides which model sits behind it.
 * Embeddings are never merchant-visible, so they keep a fixed model.
 */
const DEFAULT_TIER: Record<AiTask, string> = {
  auto_tag: "everyday",
  summarise: "everyday",
  suggest_reply: "everyday",
  agent_reply: "careful",
  embedding: "everyday",
};

const EMBEDDING_FALLBACK = { provider: "lovable", model_id: "openai/text-embedding-3-small" };
const TIER_FALLBACK: Record<string, { provider: string; model_id: string; display_name: string }> = {
  everyday: { provider: "lovable", model_id: "google/gemini-3.6-flash", display_name: "Everyday" },
  careful: { provider: "lovable", model_id: "openai/gpt-5.4", display_name: "Careful" },
};

export const EMBEDDING_MODEL = EMBEDDING_FALLBACK.model_id;

type TierRow = {
  key: string;
  display_name: string;
  provider: string;
  model_id: string;
  is_active: boolean;
};

async function loadTier(supabase: SupabaseClient, key: string): Promise<TierRow | null> {
  const { data } = await supabase
    .from("ai_tiers")
    .select("key, display_name, provider, model_id, is_active")
    .eq("key", key)
    .maybeSingle();
  const row = data as TierRow | null;
  return row && row.is_active ? row : null;
}

/** per-task tier -> per-agent tier -> platform default tier, then BYOA override. */
export async function resolveBrain(
  supabase: SupabaseClient,
  organizationId: string,
  task: AiTask,
  agentId?: string | null,
  forcedTier?: string | null,
): Promise<ResolvedBrain> {
  if (task === "embedding") {
    return {
      ...EMBEDDING_FALLBACK,
      tier: "everyday",
      display_name: "Everyday",
      supports_tools: false,
      origin: "platform",
    };
  }

  let tierKey = forcedTier ?? null;
  let origin: ResolvedBrain["origin"] = forcedTier ? "task" : "platform";

  if (!tierKey) {
    const { data: settings } = await supabase
      .from("organization_ai_settings")
      .select("brain_choice")
      .eq("organization_id", organizationId)
      .maybeSingle();
    const manual = (settings as { brain_choice?: string } | null)?.brain_choice === "manual";

    if (manual) {
      const { data: rows } = await supabase
        .from("ai_task_models")
        .select("tier, agent_id")
        .eq("organization_id", organizationId)
        .eq("task", task);
      const list = (rows ?? []) as Array<{ tier: string; agent_id: string | null }>;
      const forAgent = agentId ? list.find((r) => r.agent_id === agentId) : undefined;
      const forOrg = list.find((r) => r.agent_id === null);
      if (forAgent) {
        tierKey = forAgent.tier;
        origin = "task";
      } else if (forOrg) {
        tierKey = forOrg.tier;
        origin = "agent";
      }
    }
  }

  if (!tierKey) {
    tierKey = DEFAULT_TIER[task];
    origin = "platform";
  }

  const tier = (await loadTier(supabase, tierKey)) ?? (await loadTier(supabase, DEFAULT_TIER[task]));
  const resolvedKey = tier?.key ?? DEFAULT_TIER[task];
  const fallback = TIER_FALLBACK[resolvedKey] ?? TIER_FALLBACK["everyday"]!;

  let provider = tier?.provider ?? fallback.provider;
  let modelId = tier?.model_id ?? fallback.model_id;

  // Enterprise bring-your-own-account: an active org provider wins over the
  // platform's model for that vendor. Invisible to ordinary merchants.
  const { data: byoa } = await supabase
    .from("ai_providers")
    .select("provider, model")
    .eq("organization_id", organizationId)
    .eq("is_default", true)
    .eq("status", "active")
    .maybeSingle();
  const own = byoa as { provider: string; model: string | null } | null;
  if (own?.model) {
    provider = own.provider;
    modelId = own.model;
    origin = "workspace";
  }

  const { data: model } = await supabase
    .from("ai_models")
    .select("supports_tools, is_available, is_deprecated")
    .eq("provider", provider)
    .eq("model_id", modelId)
    .maybeSingle();
  const m = model as
    | { supports_tools: boolean; is_available: boolean; is_deprecated: boolean }
    | null;

  // A retired or unknown model never reaches the gateway.
  if (!m || !m.is_available || m.is_deprecated) {
    return {
      provider: fallback.provider,
      model_id: fallback.model_id,
      tier: resolvedKey,
      display_name: tier?.display_name ?? fallback.display_name,
      supports_tools: true,
      origin: "platform",
    };
  }

  return {
    provider,
    model_id: modelId,
    tier: resolvedKey,
    display_name: tier?.display_name ?? fallback.display_name,
    supports_tools: m.supports_tools,
    origin,
  };
}

// ------------------------------------------------------------------- money

/** The multiplier this workspace's bills are computed with. */
export async function resolveMarkup(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<number> {
  const { data: org } = await supabase
    .from("organization_ai_settings")
    .select("ai_markup_multiplier")
    .eq("organization_id", organizationId)
    .maybeSingle();
  const negotiated = (org as { ai_markup_multiplier?: number | null } | null)?.ai_markup_multiplier;
  if (typeof negotiated === "number" && negotiated >= 1) return negotiated;

  const { data: platform } = await supabase
    .from("platform_settings")
    .select("ai_markup_multiplier")
    .eq("id", true)
    .maybeSingle();
  const rate = (platform as { ai_markup_multiplier?: number } | null)?.ai_markup_multiplier;
  return typeof rate === "number" && rate >= 1 ? rate : 3;
}

/** What the merchant pays for a run that cost the platform `cost`. */
export function billedFromCost(cost: number | null, markup: number): number | null {
  if (cost === null || Number.isNaN(cost)) return null;
  return Math.round(cost * markup * 1e6) / 1e6;
}

// -------------------------------------------------------------------- keys

/**
 * The gateway key for a provider. Workspace-supplied keys live in Supabase
 * Vault and are read here, server side, by name only — the name is all that is
 * ever stored in a readable table.
 */
async function readVaultSecret(
  supabase: SupabaseClient,
  name: string | null | undefined,
): Promise<string | null> {
  if (!name) return null;
  // The vault schema is not exposed over the data API, so the read goes
  // through a security-definer function in public rather than a table select.
  const { data, error } = await supabase.rpc("read_vault_secret", { p_name: name });
  if (error) {
    console.error("[ai] vault read failed", name, error.message);
    return null;
  }
  return typeof data === "string" && data.length > 0 ? data : null;
}

/**
 * Keys belong to the platform. An organisation only supplies its own when it
 * is on an enterprise bring-your-own-account deal, and that override wins.
 */
async function resolveApiKey(
  supabase: SupabaseClient,
  organizationId: string,
  provider: string,
): Promise<{ key: string | null; base: string; direct: boolean }> {
  const directBase = DIRECT_ENDPOINTS[provider];
  const vendor = (key: string) =>
    directBase ? { key, base: directBase, direct: true } : { key, base: GATEWAY, direct: false };

  // 1. Organisation override, if this workspace brought its own account.
  const { data: own } = await supabase
    .from("ai_providers")
    .select("vault_secret_name")
    .eq("organization_id", organizationId)
    .eq("provider", provider)
    .eq("status", "active")
    .maybeSingle();
  const ownKey = await readVaultSecret(
    supabase,
    (own as { vault_secret_name?: string } | null)?.vault_secret_name,
  );
  if (ownKey) return vendor(ownKey);

  // 2. Platform credentials, held once for everyone.
  const { data: platform } = await supabase
    .from("platform_ai_providers")
    .select("vault_secret_name, is_active")
    .eq("provider", provider)
    .maybeSingle();
  const row = platform as { vault_secret_name?: string; is_active?: boolean } | null;
  if (row?.is_active !== false) {
    const platformKey = await readVaultSecret(supabase, row?.vault_secret_name);
    if (platformKey) return vendor(platformKey);
  }

  // 3. The platform's own gateway credential.
  if (provider === "lovable") {
    return { key: process.env["LOVABLE_API_KEY"] ?? null, base: GATEWAY, direct: false };
  }
  return { key: null, base: GATEWAY, direct: false };
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

/**
 * A ceiling that is missing, zero or negative is a misconfiguration, not
 * permission to spend without limit. Both caps below fail closed on it.
 */
export function capIsValid(cap: unknown): boolean {
  const value = Number(cap);
  return Number.isFinite(value) && value > 0;
}

async function overCap(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<{ over: boolean; cap: number; spent: number; currency: string; misconfigured: boolean }> {
  const { data: settings } = await supabase
    .from("organization_ai_settings")
    .select("ai_monthly_cap_amount, currency")
    .eq("organization_id", organizationId)
    .maybeSingle();
  const s = settings as { ai_monthly_cap_amount: number; currency: string } | null;
  const cap = Number(s?.ai_monthly_cap_amount ?? 0);
  const currency = s?.currency ?? "INR";
  if (!capIsValid(cap)) {
    return { over: true, cap: 0, spent: 0, currency, misconfigured: true };
  }
  const { data: spend } = await supabase.rpc("ai_month_spend", { p_org: organizationId });
  const spent = Number(spend ?? 0);
  return { over: spent >= cap, cap, spent, currency, misconfigured: false };
}

/**
 * Total platform exposure. Per-merchant caps bound each workspace; this bounds
 * the sum of them. There is no "unlimited" setting: an unset or invalid
 * ceiling stops every run until a Super Admin sets a real one.
 */
export async function platformCapState(
  supabase: SupabaseClient,
): Promise<{
  over: boolean;
  warn: boolean;
  cap: number;
  spent: number;
  currency: string;
  misconfigured: boolean;
}> {
  const { data: settings } = await supabase
    .from("platform_settings")
    .select("ai_monthly_cap_amount, ai_cap_currency")
    .eq("id", true)
    .maybeSingle();
  const s = settings as { ai_monthly_cap_amount: number; ai_cap_currency: string } | null;
  const cap = Number(s?.ai_monthly_cap_amount ?? 0);
  const currency = s?.ai_cap_currency ?? "INR";
  const { data: spend } = await supabase.rpc("platform_ai_month_spend");
  const spent = Number(spend ?? 0);
  if (!capIsValid(cap)) {
    return { over: true, warn: true, cap: 0, spent, currency, misconfigured: true };
  }
  return {
    over: spent >= cap,
    warn: spent >= cap * 0.8,
    cap,
    spent,
    currency,
    misconfigured: false,
  };
}

/** Whether a provider is called on the platform's own key or via the gateway. */
export function providerRoute(provider: string): "direct" | "gateway" {
  return DIRECT_ENDPOINTS[provider] ? "direct" : "gateway";
}

const overPlatformCap = platformCapState;

// -------------------------------------------------------------- gateway I/O

type ChatMessage = { role: string; content: unknown; [k: string]: unknown };

type GatewayCall = {
  text: string;
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
  inputTokens: number | null;
  outputTokens: number | null;
  raw: unknown;
};

/**
 * Auth headers. The resale gateway wants its own header; a vendor called
 * directly with the platform's own key wants a bearer token.
 */
function gatewayHeaders(key: string, direct = false): Record<string, string> {
  if (direct) {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      // Anthropic's OpenAI-compatible endpoint also accepts its native header.
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    };
  }
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

/** Chat-completions path — every vendor, gateway or direct. */
async function callChatCompletions(
  base: string,
  key: string,
  model: string,
  messages: ChatMessage[],
  tools: BrokeredTool[],
  direct = false,
): Promise<GatewayCall> {
  const body: Record<string, unknown> = { model, messages };
  // Anthropic's compatible endpoint insists on an explicit output cap.
  if (direct && base.includes("anthropic")) body["max_tokens"] = 4096;
  if (tools.length > 0) {
    body["tools"] = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: gatewayHeaders(key, direct),
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
  direct = false,
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
    headers: gatewayHeaders(key, direct),
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

  const brain = await resolveBrain(
    supabase,
    organizationId,
    task,
    agentId,
    options.tier ?? null,
  );
  const markup = await resolveMarkup(supabase, organizationId);

  const base: RunResult = {
    runId: null,
    status: "ok",
    output: "",
    sources: [],
    toolCalls: [],
    escalationSignal: null,
    costAmount: null,
    costCurrency: null,
    billedAmount: null,
    billedCurrency: null,
    markupMultiplier: markup,
    costKnown: false,
    latencyMs: 0,
    provider: brain.provider,
    model: brain.model_id,
    tier: brain.tier,
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
        tier: result.tier,
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
        billed_amount: result.billedAmount,
        billed_currency: result.billedCurrency,
        markup_multiplier: result.markupMultiplier,
        latency_ms: result.latencyMs,
        status: result.status,
        error: result.error ?? null,
        comparison_id: comparisonId,
      })
      .select("id")
      .maybeSingle();
    result.runId = (data as { id?: string } | null)?.id ?? null;
    if (result.runId) {
      // One row per tool invocation, written through a strict database function.
      // A run must never claim tool usage without the matching trace rows.
      if (result.toolCalls.length) {
        const traces = result.toolCalls.map((call) => ({
          tool_name: call.tool,
          ok: call.ok,
          error: call.error ?? null,
          latency_ms: call.latencyMs ?? null,
          activity_log_id: call.activityLogId ?? null,
        }));
        const { data: written, error: traceError } = await supabase.rpc("record_ai_tool_calls", {
          p_run_id: result.runId,
          p_organization_id: organizationId,
          p_calls: traces,
        });
        if (traceError || Number(written) !== traces.length) {
          throw new Error(
            `I used ${traces.length} tool${traces.length === 1 ? "" : "s"}, but I couldn't save the work record. Please retry this request.`,
          );
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
      error: cap.misconfigured
        ? "This workspace has no valid monthly spending limit set, so I've stopped rather than spend without one. Set a limit above zero and I'll carry on."
        : `This month's AI spending limit (${cap.currency} ${cap.cap}) has been reached.`,
    });
  }

  // Every workspace can be inside its own limit while the platform as a whole
  // is not. The ceiling below is the platform's, set by the Super Admin.
  const platformCap = await overPlatformCap(supabase);
  if (platformCap.over) {
    return finish({
      ...base,
      status: "capped",
      output: "",
      error: `This month's AI spending limit (${platformCap.currency} ${platformCap.cap}) has been reached.`,
    });
  }

  const { key, base: apiBase, direct } = await resolveApiKey(supabase, organizationId, brain.provider);
  const wire = direct ? wireModel(brain.provider, brain.model_id) : brain.model_id;

  if (!key) {
    return finish({
      ...base,
      status: "error",
      error: `My "${brain.display_name}" setup has no working connection behind it, so I couldn't think at all. This isn't a bad answer — it's a broken connection. Ask the platform team to check the key for this setup.`,
    });
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
    if (isOpenAiModel(brain.model_id) || (direct && brain.provider === "openai")) {
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
        const call = await callResponses(apiBase, key, wire, items, tools, direct);
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
        const call = await callChatCompletions(apiBase, key, wire, messages, tools, direct);
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
      billedAmount: billedFromCost(priced.amount, markup),
      billedCurrency: priced.currency,
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
    billedAmount: billedFromCost(priced.amount, markup),
    billedCurrency: priced.currency,
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
function modelView(result: { ok: boolean; found?: boolean; data?: unknown; error?: string }) {
  return {
    ok: result.ok,
    ...(result.found === false
      ? { found: false, note: "This ran fine and found nothing. Say so plainly; do not treat it as a failure." }
      : {}),
    ...(result.data !== undefined ? { data: result.data } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
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
    .select("id, runs, input_tokens, output_tokens, cost_amount, billed_amount")
    .eq("organization_id", organizationId)
    .eq("usage_date", today)
    .eq("task", task)
    .maybeSingle();
  const row = existing as
    | {
        id: string;
        runs: number;
        input_tokens: number;
        output_tokens: number;
        cost_amount: number;
        billed_amount: number;
      }
    | null;
  if (row) {
    await supabase
      .from("ai_usage")
      .update({
        runs: row.runs + 1,
        input_tokens: Number(row.input_tokens) + (result.inputTokens ?? 0),
        output_tokens: Number(row.output_tokens) + (result.outputTokens ?? 0),
        cost_amount: Number(row.cost_amount) + (result.costAmount ?? 0),
        billed_amount: Number(row.billed_amount ?? 0) + (result.billedAmount ?? 0),
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
      billed_amount: result.billedAmount ?? 0,
      currency: result.costCurrency ?? "INR",
    });
  }
}
