/**
 * The one way Aiden's mode changes from the web (Off / Draft / Replying):
 * the Employee page's switch and the first-run journey's Go live step both
 * come here (Batch 40 moved it out of /api/ai/employee unchanged). The
 * database refuses Replying/Draft without a plan or credits and says why;
 * Replying first needs one test answer from the last week, unless skipped.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export const AGENT_MODES = ["off", "draft", "replying"] as const;

export type SetModeResult =
  { ok: true; mode: string } | { ok: false; status: number; body: Record<string, unknown> };

export async function setAgentMode(
  supabase: SupabaseClient,
  args: { organizationId: string; userId: string | null; mode: string; skipTest?: boolean },
): Promise<SetModeResult> {
  const org = args.organizationId;
  const { data: agentRow } = await supabase
    .from("ai_agents")
    .select("id, name, avatar, mode")
    .eq("organization_id", org)
    .eq("is_default", true)
    .maybeSingle();
  const agent = agentRow as { id: string } | null;
  if (!agent)
    return { ok: false, status: 400, body: { error: "No AI employee in this workspace yet." } };
  const mode = args.mode;
  if (!(AGENT_MODES as readonly string[]).includes(mode))
    return { ok: false, status: 400, body: { error: "Unknown mode." } };

  if (mode === "replying" && args.skipTest !== true) {
    const { data: tested } = await supabase
      .from("ai_runs")
      .select("id")
      .eq("organization_id", org)
      .eq("task", "agent_reply")
      .is("conversation_id", null)
      .gte("created_at", new Date(Date.now() - 7 * 864e5).toISOString())
      .limit(1);
    if (!tested || tested.length === 0) {
      return {
        ok: false,
        status: 409,
        body: {
          needs_test: true,
          message:
            "You haven't tested this yet. Want to see how it would have answered your last 20 customer questions first?",
        },
      };
    }
  }

  const { error: modeError } = await supabase.from("ai_agents").update({ mode }).eq("id", agent.id);
  if (modeError) {
    // The database refuses to switch Aiden on without a plan or
    // credits, and says why. Pass its words straight through.
    const message = String(modeError.message ?? "");
    if (message.includes("AI_GUARD:")) {
      return {
        ok: false,
        status: 402,
        body: { error: message.split("AI_GUARD:")[1]?.trim() || message, billing: true },
      };
    }
    return {
      ok: false,
      status: 400,
      body: { error: "We couldn't change that. Please try again." },
    };
  }
  // One switch: ai_enabled follows the mode on every save.
  const { syncAiSwitch } = await import("@/lib/ai-agent.server");
  await syncAiSwitch(supabase, org, mode);
  const { logServerActivity } = await import("@/lib/whatsapp-api.server");
  await logServerActivity(supabase, org, args.userId, "ai_mode_changed", { mode });
  // Batch 53: the first Aiden-on unlocks Aiden Workspace (a stamp only; never throws).
  const { stampAidenWorkspaceUnlock } = await import("@/lib/aiden-workspace.server");
  await stampAidenWorkspaceUnlock(supabase, org, mode);
  return { ok: true, mode };
}
