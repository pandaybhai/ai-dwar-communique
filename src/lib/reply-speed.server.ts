import type { SupabaseClient } from "@supabase/supabase-js";
import { SLOW_REPLY_MS } from "@/lib/reply-timing";

/**
 * Batch 29: the /admin/ai "Reply speed" card. One aggregate in the database
 * (public.reply_speed_stats, service role only, 20261090) over Aiden's
 * replies' ai_runs.metadata.reply_speed: per workspace p50 / p90 / slowest
 * (received → WhatsApp accepted the first message) for the last 24 hours and
 * 7 days, and every reply over 30 s with its reason. Never throws: a failed
 * call (PGRST202 until 20261090 is applied) comes back with its reason.
 */

export type SpeedWindow = {
  replies: number;
  p50_ms: number | null;
  p90_ms: number | null;
  slowest_ms: number | null;
  over_slow: number;
};
export type WorkspaceSpeed = {
  organization_id: string;
  name: string | null;
  last_24h: SpeedWindow;
  last_7d: SpeedWindow;
};
export type SlowReply = {
  run_id: string;
  organization_id: string;
  name: string | null;
  conversation_id: string | null;
  at: string;
  ms: number;
  reason: string | null;
  pickup: string | null;
  parts: Record<string, number> | null;
};
export type ReplySpeedStats = { slow_ms: number; workspaces: WorkspaceSpeed[]; slow: SlowReply[] };
export type ReplySpeedResult =
  { ok: true; stats: ReplySpeedStats } | { ok: false; error: string; code: string | null };

const num = (v: unknown): number | null =>
  v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);

function speedWindow(raw: unknown): SpeedWindow {
  const w = (raw ?? {}) as Record<string, unknown>;
  return {
    replies: num(w["replies"]) ?? 0,
    p50_ms: num(w["p50_ms"]),
    p90_ms: num(w["p90_ms"]),
    slowest_ms: num(w["slowest_ms"]),
    over_slow: num(w["over_slow"]) ?? 0,
  };
}

export async function replySpeedStats(
  supabase: SupabaseClient,
  input: { nowIso?: string; slowMs?: number; slowLimit?: number } = {},
): Promise<ReplySpeedResult> {
  try {
    const { data, error } = await supabase.rpc("reply_speed_stats", {
      p_now: input.nowIso ?? new Date().toISOString(),
      p_slow_ms: input.slowMs ?? SLOW_REPLY_MS,
      p_slow_limit: input.slowLimit ?? 50,
    });
    if (error)
      return { ok: false, error: error.message, code: (error as { code?: string }).code ?? null };
    const row = (data ?? {}) as Record<string, unknown>;
    const workspaces = Array.isArray(row["workspaces"])
      ? (row["workspaces"] as Record<string, unknown>[])
      : [];
    const slow = Array.isArray(row["slow"]) ? (row["slow"] as Record<string, unknown>[]) : [];
    return {
      ok: true,
      stats: {
        slow_ms: num(row["slow_ms"]) ?? SLOW_REPLY_MS,
        workspaces: workspaces.map((w) => ({
          organization_id: String(w["organization_id"]),
          name: (w["name"] as string | null) ?? null,
          last_24h: speedWindow(w["last_24h"]),
          last_7d: speedWindow(w["last_7d"]),
        })),
        slow: slow.map((s) => ({
          run_id: String(s["run_id"]),
          organization_id: String(s["organization_id"]),
          name: (s["name"] as string | null) ?? null,
          conversation_id: (s["conversation_id"] as string | null) ?? null,
          at: String(s["at"]),
          ms: num(s["ms"]) ?? 0,
          reason: (s["reason"] as string | null) ?? null,
          pickup: (s["pickup"] as string | null) ?? null,
          parts: (s["parts"] as Record<string, number> | null) ?? null,
        })),
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), code: null };
  }
}
