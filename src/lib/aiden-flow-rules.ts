/**
 * Batch 21 item 2: a flow's "Hand to Aiden" can carry the merchant's own
 * Behaviour and Rules for that one chat. They live on the conversation
 * (conversations.aiden_flow_rules) until they expire, and are added to Aiden's
 * prompt right after the workspace's instructions. Code never writes reply
 * text: these are the business's words, passed through as instructions, and
 * every answer guard (figures, times, policy) still applies to what Aiden says.
 * Shared by the engine, the answer and the inbox header.
 */

export type AidenFlowRules = {
  flow_id: string | null;
  flow_name: string | null;
  run_id: string | null;
  behaviour: string;
  rules: string;
  set_at: string;
  expires_at: string;
};

export const DEFAULT_RULES_HOURS = 24;
export const MAX_RULES_HOURS = 168;
export const MAX_RULES_CHARS = 2000;

/** The expiry the merchant picked, in hours (default 24 h, 1 h – 7 days). */
export function rulesHours(value: unknown): number {
  const n = Math.round(Number(value));
  if (value === undefined || value === null || value === "" || !Number.isFinite(n)) return DEFAULT_RULES_HOURS;
  return Math.min(Math.max(n, 1), MAX_RULES_HOURS);
}

/** What a Hand-to-Aiden step stores; null when it carries no Behaviour or Rules. */
export function buildFlowRules(
  data: Record<string, unknown>,
  at: { flowId: string | null; flowName: string | null; runId: string | null; now: Date },
): AidenFlowRules | null {
  const behaviour = String(data["behaviour"] ?? "").trim().slice(0, MAX_RULES_CHARS);
  const rules = String(data["rules"] ?? "").trim().slice(0, MAX_RULES_CHARS);
  if (!behaviour && !rules) return null;
  return {
    flow_id: at.flowId,
    flow_name: at.flowName?.trim() || null,
    run_id: at.runId,
    behaviour,
    rules,
    set_at: at.now.toISOString(),
    expires_at: new Date(at.now.getTime() + rulesHours(data["rules_hours"]) * 3_600_000).toISOString(),
  };
}

/** The chat's rules while they are still in force; null otherwise (or when unreadable). */
export function activeFlowRules(raw: unknown, now: Date = new Date()): AidenFlowRules | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<AidenFlowRules>;
  const expires = Date.parse(String(r.expires_at ?? ""));
  if (!Number.isFinite(expires) || expires <= now.getTime()) return null;
  const behaviour = String(r.behaviour ?? "").trim();
  const rules = String(r.rules ?? "").trim();
  if (!behaviour && !rules) return null;
  return {
    flow_id: r.flow_id ?? null,
    flow_name: r.flow_name ?? null,
    run_id: r.run_id ?? null,
    behaviour,
    rules,
    set_at: String(r.set_at ?? ""),
    expires_at: String(r.expires_at),
  };
}

/** The prompt block: the business's own instructions for this chat. */
export function flowRulesBlock(rules: AidenFlowRules | null): string {
  if (!rules) return "";
  const from = rules.flow_name ? ` (set by its flow "${rules.flow_name}")` : "";
  return [
    `This business's own instructions for this chat${from}. Follow them together with the instructions above; where they differ, these win for this chat.`,
    rules.behaviour ? `Behaviour: ${rules.behaviour}` : "",
    rules.rules ? `Rules: ${rules.rules}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The assembled brief's text with the chat's block placed right after the
 * workspace's instructions. With no block it is the brief's own text, unchanged.
 */
export function briefTextWithFlowRules(brief: { text: string; sections: Array<{ key: string; text: string }> }, block: string): string {
  if (!block) return brief.text;
  return brief.sections
    .flatMap((s) => (s.key === "instructions" ? [s.text, block] : [s.text]))
    .map((t) => t.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Inbox header line: "Aiden is following: <flow name> rules". */
export function followingLabel(rules: AidenFlowRules): string {
  return `Aiden is following: ${rules.flow_name || "a flow's"} rules`;
}
