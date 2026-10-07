import { callApi } from "@/lib/whatsapp-client";
import type { SendStep } from "@/lib/reply-order";

/** Admin Test → Compare: one question run with the saved instructions and with a draft. */

/** One side of one question: what aiden_test returned (never sent, never billed). */
export type SideRun = {
  status: string;
  reply: string;
  error: string | null;
  needs_owner: boolean;
  escalation: string | null;
  sequence?: SendStep[];
  latency_ms: number;
};
export type CompareRow = { question: string; current: SideRun | null; draft: SideRun | null; failed?: string };

const adminApi = (body: Record<string, unknown>) => callApi<Record<string, unknown>>("/api/admin/ai", { body });

/**
 * The two runs for one question, through the Test tab's own path (aiden_test):
 * the saved brief, and the same with the draft's instructions in its place.
 */
export async function runBothSides(
  orgId: string,
  question: string,
  draft: string,
  call: (body: Record<string, unknown>) => Promise<{ data: Record<string, unknown> | null; error: string | null }> = adminApi,
): Promise<CompareRow> {
  const one = (override: string | null) =>
    call({ action: "aiden_test", organization_id: orgId, question, history: [], ...(override ? { instructions_override: override } : {}) });
  const [a, b] = await Promise.all([one(null), one(draft)]);
  return {
    question,
    current: (a.data as unknown as SideRun | null) ?? null,
    draft: (b.data as unknown as SideRun | null) ?? null,
    ...(a.error || b.error ? { failed: a.error ?? b.error ?? "Test failed." } : {}),
  };
}

