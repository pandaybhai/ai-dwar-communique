import type { SupabaseClient } from "@supabase/supabase-js";
import { validateGraph, type FlowEdge, type FlowGraph, type FlowNode, type NodeType } from "@/lib/flow-graph";

const ALLOWED: NodeType[] = [
  "start", "text", "buttons", "list", "ask", "branch", "tag", "set_field", "assign", "needs_you", "end",
  "cta_url", "set_variable", "business_hours", "internal_note", "wait",
];

/** AI is "on" only when the agent replies/drafts, AI features are enabled and the workspace hasn't switched AI off. */
export async function workspaceAiOn(supabase: SupabaseClient, organizationId: string): Promise<boolean> {
  const [{ data: agent }, { data: settings }, { data: ov }, { data: flag }] = await Promise.all([
    supabase.from("ai_agents").select("mode").eq("organization_id", organizationId).eq("is_default", true).maybeSingle(),
    supabase.from("organization_ai_settings").select("ai_enabled").eq("organization_id", organizationId).maybeSingle(),
    supabase.from("organization_feature_overrides").select("enabled").eq("organization_id", organizationId).eq("flag_key", "ai_features").maybeSingle(),
    supabase.from("feature_flags").select("default_enabled").eq("key", "ai_features").maybeSingle(),
  ]);
  const mode = (agent as { mode?: string } | null)?.mode ?? "off";
  const featureOn = ov ? Boolean((ov as { enabled: boolean }).enabled) : Boolean((flag as { default_enabled?: boolean } | null)?.default_enabled);
  return (mode === "draft" || mode === "replying") && featureOn && (settings as { ai_enabled?: boolean } | null)?.ai_enabled !== false;
}

const SYSTEM = `You design WhatsApp chat flows for this business, using what you know about it from its own knowledge.
Return ONLY JSON: {"nodes":[{"id":"...","type":"...","data":{...}}],"edges":[{"source":"id","target":"id","sourceHandle":"next"}]}.
Node types and data:
- start {} (exactly one)
- text {"text"}
- buttons {"text","variable","buttons":[{"id":"b1","title":"max 20 chars"}]} (1-3 buttons; each button id is an output handle)
- list {"text","button_text","variable","rows":[{"id":"r1","title":"max 24 chars"}]} (1-10 rows; each row id is an output)
- ask {"text","variable","validation":"text|number|email|phone|pincode|date"} (output "next")
- branch {"branches":[{"id":"x1","label","match":"all","conditions":[{"subject":"var:<name>","op":"eq|contains|gt|lt","value"}]}]} (outputs: each branch id + "else")
- cta_url {"text","button_text","url"}
- tag {"tag","action":"add"}
- assign {} ; needs_you {"note"} ; internal_note {"text"} ; set_variable {"variable","mode":"value","expression"}
- business_hours {} (outputs "open","closed") ; wait {"minutes"}
- end {}
Every output must connect to a node; use {{name}} or {{variable}} placeholders. Only use facts from the business's knowledge; never invent prices, policies or links. Keep it under 25 nodes. Reply in the language the description is written in.`;

export async function generateFlowDraft(
  supabase: SupabaseClient,
  args: { organizationId: string; userId: string; description: string },
): Promise<{ graph: FlowGraph | null; error?: string; status?: number }> {
  if (!(await workspaceAiOn(supabase, args.organizationId)))
    return { graph: null, error: "Switch on your AI employee first to generate flows.", status: 403 };
  const { executeRun } = await import("@/lib/ai-run.server");
  const run = await executeRun(supabase, {
    organizationId: args.organizationId,
    task: "summarise",
    input: args.description,
    system: SYSTEM,
    useKnowledge: true,
    actorUserId: args.userId,
  });
  if (run.status !== "ok" || !run.output) return { graph: null, error: "I couldn't draft that right now — please try again in a minute." };
  const raw = run.output.replace(/^```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  let parsed: { nodes?: unknown; edges?: unknown };
  try {
    parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch {
    return { graph: null, error: "I couldn't turn that into a flow — try describing the steps a bit more clearly." };
  }
  const nodes = (Array.isArray(parsed.nodes) ? parsed.nodes : [])
    .filter((n): n is { id: string; type: NodeType; data?: Record<string, unknown> } => !!n && typeof (n as FlowNode).id === "string" && ALLOWED.includes((n as FlowNode).type))
    .slice(0, 60)
    .map((n): FlowNode => ({ id: n.id, type: n.type, data: n.data && typeof n.data === "object" ? n.data : {} }));
  const ids = new Set(nodes.map((n) => n.id));
  const edges = (Array.isArray(parsed.edges) ? parsed.edges : [])
    .filter((e): e is FlowEdge => !!e && ids.has((e as FlowEdge).source) && ids.has((e as FlowEdge).target))
    .map((e, i): FlowEdge => ({ id: `g${i}`, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? "next" }));
  if (!nodes.some((n) => n.type === "start")) return { graph: null, error: "The draft had no starting point — please try again." };
  const graph: FlowGraph = { nodes, edges };
  // Returned as a draft even with problems; the editor shows them on the steps.
  void validateGraph(graph);
  return { graph };
}
