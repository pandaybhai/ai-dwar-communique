import { callApi } from "@/lib/whatsapp-client";

/** Shapes the /app/employee screen works with. Mirrors the API routes. */

export type EmployeeAgent = {
  id: string;
  name: string;
  avatar: string | null;
  mode: "off" | "draft" | "replying" | string;
};

export type EmployeeSettings = {
  ai_enabled: boolean;
  ai_monthly_cap_amount: number | null;
  currency: string | null;
  brain_choice: "recommended" | "manual" | string;
};

export type BrainModel = {
  provider: string;
  model_id: string;
  display_name: string;
  plain_description: string | null;
  supports_tools: boolean;
  recommended_for: string[] | null;
};

export type TaskModel = {
  task: string;
  provider: string;
  model_id: string;
  agent_id: string | null;
};

export type InstructionVersion = {
  id: string;
  persona_name: string;
  tone: string;
  instructions: string;
  escalation_rules: string;
  languages: string[];
  working_hours_behaviour: string;
  version: number;
  is_current: boolean;
  updated_at: string;
};

export type KnowledgeSource = {
  id: string;
  type: "website" | "pdf" | "spreadsheet" | "manual_qa" | string;
  name: string;
  status: "pending" | "syncing" | "ready" | "error" | string;
  item_count: number;
  last_synced_at: string | null;
  last_error: string | null;
  refresh_days?: number;
  config?: Record<string, unknown>;
};

export type KnowledgeItem = {
  id: string;
  source_ref: string;
  title: string;
  content: string;
  updated_at: string;
};

export type ToolRow = {
  name: string;
  description: string;
  access: "read" | "write";
  feature: string;
  available: boolean;
  reason: string | null;
};

export type EmployeeOverview = {
  agent: EmployeeAgent | null;
  settings: EmployeeSettings | null;
  spend_this_month: number;
  models: BrainModel[];
  task_models: TaskModel[];
  instructions: InstructionVersion[];
  sources: KnowledgeSource[];
  tools: ToolRow[];
  week: { answered: number; passed: number; refused: number };
  tested_recently: boolean;
  can_configure: boolean;
};

export type RunSource = {
  kind: "knowledge" | "tool";
  label: string;
  ref?: string;
  similarity?: number;
};

export type EmployeeRun = {
  id: string;
  task: string;
  status: string;
  escalation_signal: string | null;
  cost_amount: number | null;
  cost_source: string | null;
  latency_ms: number | null;
  input_summary: string | null;
  output: string | null;
  sources: RunSource[] | null;
  tool_calls?: EmployeeToolCall[] | null;
  created_at: string;
};

export type WeeklyReport = {
  since: string;
  answered: number;
  passed: number;
  cost: number;
  learn: { question: string; times: number; last_at: string }[];
};

export type EmployeeToolCall = {
  tool_name: string;
  ok: boolean;
  error: string | null;
  latency_ms: number | null;
};

export type PlaygroundRun = {
  runId: string | null;
  status: string;
  error?: string | null;
  output: string;
  sources: RunSource[];
  toolCalls: { tool: string; ok: boolean; error?: string }[];
  escalationSignal: string | null;
  costAmount: number | null;
  costCurrency: string | null;
  costKnown: boolean;
  latencyMs: number;
  provider: string;
  model: string;
  brainName: string;
};

export type CompareSide = {
  answer: string;
  answered: boolean;
  passedToYou: boolean;
  sources: RunSource[];
  tools: string[];
  costAmount: number | null;
  costKnown: boolean;
  latencyMs: number;
  brainName: string;
  provider: string;
  model: string;
  runId: string | null;
};

export type CompareResult = {
  comparisonId: string | null;
  pairs: { question: string; a: CompareSide; b: CompareSide }[];
  summaryA: { answered: number; passed: number; totalCost: number | null; costKnown: boolean; averageMs: number };
  summaryB: { answered: number; passed: number; totalCost: number | null; costKnown: boolean; averageMs: number };
};

export const employeeApi = <T,>(body: Record<string, unknown>) =>
  callApi<T>("/api/ai/employee", { body });

export const knowledgeApi = <T,>(body: Record<string, unknown>) =>
  callApi<T>("/api/ai/knowledge", { body });

export const aiRunApi = <T,>(body: Record<string, unknown>) =>
  callApi<T>("/api/internal/ai-run", { body });

/** "2 days ago", "just now" — dates a person reads without doing arithmetic. */
export function whenText(iso: string | null | undefined): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

/** Money the way a merchant expects to see it, or an honest blank. */
export function moneyText(amount: number | null | undefined, currency = "INR"): string {
  if (amount === null || amount === undefined) return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    maximumFractionDigits: amount < 100 ? 2 : 0,
  }).format(amount);
}

export const TASK_LABELS: Record<string, { title: string; blurb: string }> = {
  agent_reply: {
    title: "Answering customers",
    blurb: "The hardest job. This one talks to your customers, so give it your best brain.",
  },
  suggest_reply: {
    title: "Drafting replies for your team",
    blurb: "Writes a reply your team reads before sending.",
  },
  summarise: {
    title: "Summarising conversations",
    blurb: "Catches a teammate up on a long chat in three lines.",
  },
  auto_tag: {
    title: "Tagging conversations",
    blurb: "Quiet background work. A small, cheap brain is plenty.",
  },
};
