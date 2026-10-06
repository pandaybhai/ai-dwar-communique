/**
 * The backup brain. When the platform's primary AI route (the Lovable
 * gateway) runs out of credit, is rate-limited past its quota, errors or can't
 * be reached, a chat/completion run carries on with a second provider —
 * Anthropic (ANTHROPIC_API_KEY) and/or OpenAI (OPENAI_API_KEY) — with the same
 * system prompt, history, tools and guards. ai-run.server.ts decides when;
 * this file says who, how, at what price, and tells the platform owner.
 *
 * Nothing here runs unless a backup key is set: with neither key every run
 * behaves exactly as it did before (the error is returned as before).
 *
 * Embeddings are NOT routed here: stored vectors only match vectors from the
 * same model, so embeddings fall back only to OpenAI's own
 * text-embedding-3-small (the model the gateway serves) — see embedTexts.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BrokeredTool } from "@/lib/ai-tools.server";

// --------------------------------------------------------------- errors

/** An HTTP failure from a model provider. The message is the merchant-safe wording. */
export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

/** The streamed answer ended before the provider said it was complete. */
export class ProviderStreamCut extends Error {
  constructor(message = "The AI stopped before it finished answering.") {
    super(message);
    this.name = "ProviderStreamCut";
  }
}

export type OutageKind = "credit" | "rate_limit" | "server" | "network" | "no_key";
export type Outage = { kind: OutageKind; status: number | null };

const QUOTA_WORDS = /credit|quota|insufficient|billing|balance|payment required|exceeded your/i;

/**
 * Whether a failed call is the provider's trouble (worth another provider)
 * rather than ours (a bad request, a refused prompt). 402, a credit-limit 403,
 * 429, 5xx, a cut stream and an unreachable host qualify; nothing else does.
 */
export function outageOf(error: unknown): Outage | null {
  if (error instanceof ProviderStreamCut) return { kind: "server", status: null };
  let status: number | null = null;
  let body = "";
  if (error instanceof ProviderHttpError) {
    status = error.status;
    body = error.body;
  } else if (error instanceof Anthropic.APIConnectionError) {
    return { kind: "network", status: null };
  } else if (error instanceof Anthropic.APIError) {
    status = typeof error.status === "number" ? error.status : null;
    body = error.message;
    if (status === null) return { kind: "network", status: null };
  } else if (error instanceof TypeError) {
    // fetch() itself failed: DNS, TLS, connection reset.
    return { kind: "network", status: null };
  } else {
    return null;
  }
  if (status === 402) return { kind: "credit", status };
  if (status === 403 && /credit_limit|credit limit/i.test(body)) return { kind: "credit", status };
  if (status === 429) return { kind: QUOTA_WORDS.test(body) ? "credit" : "rate_limit", status };
  if (status >= 500) return { kind: "server", status };
  return null;
}

// --------------------------------------------------------------- routes

export type BackupProvider = "anthropic" | "openai";
export type BackupRoute = { provider: BackupProvider; model: string; key: string };

type Env = Record<string, string | undefined>;

/**
 * The backups configured on this deployment, in the order they are tried.
 * AI_BACKUP_ORDER ("anthropic,openai" by default) picks the order; a provider
 * without its key is skipped. Model choice per provider can be overridden.
 */
export function backupRoutes(tier: string, env: Env = process.env): BackupRoute[] {
  const order = (env["AI_BACKUP_ORDER"] ?? "anthropic,openai")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is BackupProvider => s === "anthropic" || s === "openai");
  const routes: BackupRoute[] = [];
  for (const provider of Array.from(new Set(order))) {
    if (provider === "anthropic" && env["ANTHROPIC_API_KEY"]) {
      routes.push({
        provider,
        key: env["ANTHROPIC_API_KEY"],
        model: env["ANTHROPIC_BACKUP_MODEL"] || "claude-opus-5-5",
      });
    }
    if (provider === "openai" && env["OPENAI_API_KEY"]) {
      const model = env["OPENAI_BACKUP_MODEL"] || (tier === "careful" ? "gpt-5.4" : "gpt-5.4-mini");
      routes.push({ provider, key: env["OPENAI_API_KEY"], model });
    }
  }
  return routes;
}

/**
 * List prices (INR per million tokens, at the same ₹88/$ the ai_rates card
 * uses) for the backup models that have no ai_rates row yet. A rate-card row
 * for the same provider+model always wins over these.
 */
export const BACKUP_RATES_INR: Record<string, { input: number; output: number }> = {
  "anthropic:claude-opus-5-5": { input: 352, output: 1760 },
  "anthropic:claude-sonnet-5-5": { input: 176, output: 880 },
  "anthropic:claude-haiku-4-5": { input: 88, output: 440 },
  "openai:gpt-5.4": { input: 110, output: 880 },
  "openai:gpt-5.4-mini": { input: 22, output: 176 },
};

// ------------------------------------------------- neutral conversation

/** One finished model turn from before the switch: what it said, called and got back. */
export type NeutralTurn = {
  text: string;
  calls: { id: string; name: string; args: Record<string, unknown> }[];
  outputs: { id: string; output: string }[];
};

export type BackupRequest = {
  system: string;
  history: { role: "user" | "assistant"; content: string }[];
  input: string;
  imageDataUrl?: string | null;
  /** Turns already taken on the primary before it failed (tool calls included). */
  turns: NeutralTurn[];
  tools: BrokeredTool[];
  /** The merchant-facing tier: "careful" thinks a little harder. */
  tier: string;
};

export type BackupStep = {
  text: string;
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
  inputTokens: number | null;
  outputTokens: number | null;
  /** The model that actually answered (a server-side fallback may change it). */
  model: string;
};

export type BackupConversation = {
  step(): Promise<BackupStep>;
  addToolResults(outputs: { id: string; output: string }[]): void;
};

/** Anthropic tool ids must match ^[a-zA-Z0-9_-]+$; other vendors' ids may not. */
export function safeToolId(id: string, index: number): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned || `call_${index}`;
}

function dataUrlImage(url: string): Anthropic.Beta.BetaImageBlockParam | null {
  const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/i.exec(url);
  if (!match) return null;
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: match[1]!.toLowerCase() as
        "image/jpeg" | "image/png" | "image/gif" | "image/webp",
      data: match[2]!,
    },
  };
}

/** Models that take the server-side refusal fallback ("default" routing). */
const SERVER_FALLBACK_MODELS = new Set([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-fable-5-1",
  "claude-sonnet-5-5",
]);

/**
 * The same conversation on Anthropic's Messages API. Prior turns (from the
 * primary) are replayed as text + tool_use / tool_result blocks; turns taken
 * here are appended exactly as returned (thinking blocks included).
 */
export function anthropicConversation(route: BackupRoute, req: BackupRequest): BackupConversation {
  const client = new Anthropic({
    apiKey: route.key,
    // Read at call time, so the platform's fetch (and tests' stubs) apply.
    fetch: (input, init) => globalThis.fetch(input, init),
    maxRetries: 1,
    timeout: 120_000,
  });
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  for (const turn of req.history) {
    if (!turn.content.trim()) continue;
    // The first message must be the customer's.
    if (messages.length === 0 && turn.role === "assistant") {
      messages.push({ role: "user", content: "(earlier in this chat)" });
    }
    messages.push({ role: turn.role, content: turn.content });
  }
  const image = req.imageDataUrl ? dataUrlImage(req.imageDataUrl) : null;
  messages.push({
    role: "user",
    content: image ? [image, { type: "text", text: req.input || "." }] : req.input || ".",
  });
  req.turns.forEach((turn, t) => {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    if (turn.text.trim()) content.push({ type: "text", text: turn.text });
    turn.calls.forEach((c, i) =>
      content.push({
        type: "tool_use",
        id: safeToolId(c.id, t * 100 + i),
        name: c.name,
        input: c.args,
      }),
    );
    if (content.length) messages.push({ role: "assistant", content });
    if (turn.outputs.length) {
      messages.push({
        role: "user",
        content: turn.outputs.map((o) => {
          const i = turn.calls.findIndex((c) => c.id === o.id);
          return {
            type: "tool_result",
            tool_use_id: safeToolId(o.id, t * 100 + Math.max(i, 0)),
            content: o.output,
          };
        }),
      });
    }
  });
  const tools: Anthropic.Beta.BetaTool[] = req.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: { ...t.parameters, type: "object" },
  }));

  return {
    async step() {
      const serverFallback = SERVER_FALLBACK_MODELS.has(route.model);
      const response = await client.beta.messages.create({
        model: route.model,
        max_tokens: 16000,
        ...(req.system ? { system: req.system } : {}),
        messages,
        ...(tools.length ? { tools } : {}),
        // Customer chat: quick and short beats deep deliberation. (Haiku 4.5,
        // if chosen via ANTHROPIC_BACKUP_MODEL, takes no effort setting.)
        ...(route.model.startsWith("claude-haiku")
          ? {}
          : {
              output_config: {
                effort: req.tier === "careful" ? ("medium" as const) : ("low" as const),
              },
            }),
        ...(serverFallback
          ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
          : {}),
      });
      messages.push({
        role: "assistant",
        content: response.content as Anthropic.Beta.BetaContentBlockParam[],
      });
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      const toolCalls = response.content
        .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, args: (b.input ?? {}) as Record<string, unknown> }));
      return {
        // A declined request carries no answer; the run treats that as nothing to say.
        text: response.stop_reason === "refusal" ? "" : text,
        toolCalls: response.stop_reason === "refusal" ? [] : toolCalls,
        inputTokens: response.usage?.input_tokens ?? null,
        outputTokens: response.usage?.output_tokens ?? null,
        model: response.model || route.model,
      };
    },
    addToolResults(outputs) {
      if (!outputs.length) return;
      messages.push({
        role: "user",
        content: outputs.map((o) => ({
          type: "tool_result",
          tool_use_id: o.id,
          content: o.output,
        })),
      });
    },
  };
}

// --------------------------------------------------------------- alerts

const ALERT_ACTION = "ai_provider_alert";
const ALERT_EVERY_MS = 60 * 60_000;
let lastAlertAt = 0;

export type ProviderTrouble = {
  /** The route that failed ("lovable" = the Lovable AI gateway). */
  provider: string;
  model: string;
  outage: Outage;
  /** Who answered instead, or null when no backup did. */
  servedBy: string | null;
  backupConfigured: boolean;
  task: string;
  organizationId: string | null;
  error: string;
};

/** Only for tests. */
export function resetProviderAlertThrottle(): void {
  lastAlertAt = 0;
}

function alertWords(t: ProviderTrouble): { headline: string; detail: string } {
  const who = t.provider === "lovable" ? "Lovable AI gateway" : t.provider;
  const what =
    t.outage.kind === "credit"
      ? "is out of credit or quota"
      : t.outage.kind === "rate_limit"
        ? "is rate-limiting requests"
        : t.outage.kind === "no_key"
          ? "has no key configured"
          : t.outage.kind === "network"
            ? "can't be reached"
            : "is failing";
  return {
    headline: `${who} ${what}`,
    detail: t.servedBy
      ? `Aiden is answering on the ${t.servedBy} backup`
      : t.backupConfigured
        ? "the backup also failed, so Aiden replies are failing"
        : "no backup key is set, so Aiden replies are failing",
  };
}

/**
 * Tells the platform owner, at most once an hour: an activity_log row (shown
 * as a banner across /admin) and a WhatsApp notice to the billing admin
 * number through the existing billing_notifications queue. Raised when the
 * primary reports a credit/quota error, and whenever a backup had to answer.
 * Never throws and never delays the run it is called from beyond two writes.
 */
export async function reportProviderTrouble(
  supabase: SupabaseClient,
  trouble: ProviderTrouble,
): Promise<boolean> {
  const worth = trouble.outage.kind === "credit" || trouble.servedBy !== null;
  if (!worth) return false;
  const now = Date.now();
  if (now - lastAlertAt < ALERT_EVERY_MS) return false;
  lastAlertAt = now;
  try {
    // Another server may have raised it in the last hour.
    const { data: recent } = await supabase
      .from("activity_log")
      .select("id")
      .eq("action", ALERT_ACTION)
      .gte("created_at", new Date(now - ALERT_EVERY_MS).toISOString())
      .limit(1);
    if (Array.isArray(recent) && recent.length > 0) return false;

    const words = alertWords(trouble);
    const details = {
      provider: trouble.provider,
      model: trouble.model,
      kind: trouble.outage.kind,
      status: trouble.outage.status,
      served_by: trouble.servedBy,
      backup_configured: trouble.backupConfigured,
      task: trouble.task,
      organization_id: trouble.organizationId,
      error: trouble.error.slice(0, 300),
      headline: words.headline,
      detail: words.detail,
    };
    await supabase
      .from("activity_log")
      .insert({ organization_id: null, action: ALERT_ACTION, details });
    await supabase.from("billing_notifications").insert({
      organization_id: null,
      audience: "admin",
      kind: ALERT_ACTION,
      channel: "whatsapp",
      payload: {
        headline: words.headline,
        detail: words.detail,
        link: "https://aidwar.in/admin/ai",
      },
    });
    console.error("[ai-fallback] alert raised", JSON.stringify(details));
    return true;
  } catch (error) {
    console.error(
      "[ai-fallback] alert failed",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

// ------------------------------------------------------- admin: status/test

/** What /admin shows about the backups: configured or not, and which model — never a key. */
export type BackupStatus = {
  order: BackupProvider[];
  anthropic: { configured: boolean; model: string };
  openai: { configured: boolean; model: string; careful_model: string };
};

export function backupStatus(env: Env = process.env): BackupStatus {
  const order = (env["AI_BACKUP_ORDER"] ?? "anthropic,openai")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is BackupProvider => s === "anthropic" || s === "openai");
  // The same model choice backupRoutes makes (the key itself never leaves).
  const withKeys = { ...env, ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "x" };
  const everyday = backupRoutes("everyday", withKeys);
  const careful = backupRoutes("careful", withKeys);
  const modelOf = (routes: BackupRoute[], p: BackupProvider) => routes.find((r) => r.provider === p)?.model ?? "";
  return {
    order: Array.from(new Set(order)),
    anthropic: { configured: Boolean(env["ANTHROPIC_API_KEY"]), model: modelOf(everyday, "anthropic") || env["ANTHROPIC_BACKUP_MODEL"] || "claude-opus-5-5" },
    openai: {
      configured: Boolean(env["OPENAI_API_KEY"]),
      model: modelOf(everyday, "openai") || "gpt-5.4-mini",
      careful_model: modelOf(careful, "openai") || "gpt-5.4",
    },
  };
}

export type BackupTestReason = "bad_key" | "no_credit" | "wrong_model" | "rate_limited" | "unreachable" | "other";
export type BackupTestResult = {
  provider: BackupProvider;
  model: string;
  ok: boolean;
  /** Seconds from request to answer (also set on a failure: how long until it failed). */
  seconds: number;
  reason: BackupTestReason | null;
  /** The provider's own error text, exactly (trimmed to 300 characters). */
  error: string | null;
};

const TEST_PROMPT = "Reply with the single word OK.";

/** Plain words for a failure, from the status and the provider's own text. */
export function backupFailureReason(status: number | null, text: string): BackupTestReason {
  if (status === null) return "unreachable";
  if (status === 401 || status === 403) {
    return QUOTA_WORDS.test(text) ? "no_credit" : "bad_key";
  }
  if (status === 402) return "no_credit";
  if (status === 404 || /model_not_found|not_found_error|does not exist|unknown model|invalid model/i.test(text)) return "wrong_model";
  if (/credit balance|insufficient_quota|quota|billing/i.test(text)) return "no_credit";
  if (status === 429) return "rate_limited";
  return "other";
}

async function testAnthropic(model: string, key: string): Promise<Omit<BackupTestResult, "provider" | "model">> {
  const client = new Anthropic({
    apiKey: key,
    fetch: (input, init) => globalThis.fetch(input, init),
    maxRetries: 0,
    timeout: 30_000,
  });
  const at = Date.now();
  const seconds = () => Math.round((Date.now() - at) / 100) / 10;
  try {
    await client.messages.create({
      model,
      max_tokens: 256,
      messages: [{ role: "user", content: TEST_PROMPT }],
      // Haiku 4.5 takes no effort setting.
      ...(model.startsWith("claude-haiku") ? {} : { output_config: { effort: "low" as const } }),
    });
    return { ok: true, seconds: seconds(), reason: null, error: null };
  } catch (error) {
    if (error instanceof Anthropic.APIConnectionError) {
      return { ok: false, seconds: seconds(), reason: "unreachable", error: error.message.slice(0, 300) };
    }
    if (error instanceof Anthropic.APIError) {
      const status = typeof error.status === "number" ? error.status : null;
      return { ok: false, seconds: seconds(), reason: backupFailureReason(status, error.message), error: error.message.slice(0, 300) };
    }
    return { ok: false, seconds: seconds(), reason: "other", error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
  }
}

async function testOpenAi(model: string, key: string): Promise<Omit<BackupTestResult, "provider" | "model">> {
  const at = Date.now();
  const seconds = () => Math.round((Date.now() - at) / 100) / 10;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model, input: TEST_PROMPT, max_output_tokens: 64, store: false }),
      signal: controller.signal,
    });
    if (res.ok) return { ok: true, seconds: seconds(), reason: null, error: null };
    const text = await res.text().catch(() => "");
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string; code?: string; type?: string } };
      if (parsed.error?.message) message = `${parsed.error.code ?? parsed.error.type ?? res.status}: ${parsed.error.message}`;
    } catch {
      // not JSON: the raw text is the error
    }
    return { ok: false, seconds: seconds(), reason: backupFailureReason(res.status, text), error: (message || `HTTP ${res.status}`).slice(0, 300) };
  } catch (error) {
    return { ok: false, seconds: seconds(), reason: "unreachable", error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends one tiny prompt to every configured backup model (each provider's
 * everyday model, plus OpenAI's careful model when it differs), in parallel.
 * Nothing is recorded on ai_runs or billed to a workspace. A provider with no
 * key is not called.
 */
export async function testBackupProviders(env: Env = process.env): Promise<BackupTestResult[]> {
  const targets: Array<{ provider: BackupProvider; model: string; key: string }> = [];
  for (const tier of ["everyday", "careful"]) {
    for (const route of backupRoutes(tier, env)) {
      if (!targets.some((t) => t.provider === route.provider && t.model === route.model)) targets.push(route);
    }
  }
  return Promise.all(
    targets.map(async (t) => ({
      provider: t.provider,
      model: t.model,
      ...(t.provider === "anthropic" ? await testAnthropic(t.model, t.key) : await testOpenAi(t.model, t.key)),
    })),
  );
}
