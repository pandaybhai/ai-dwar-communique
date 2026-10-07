/**
 * Which Aiden answer (an ai_runs row) an Inbox message came from, so the
 * merchant can improve the exact reply they are looking at. Browser-safe.
 *
 * A reply goes out as one text, or — when Aiden sends products — as several
 * messages: its words in parts and each product picture with its caption
 * (metadata.kind "ai_product"). Every one of them belongs to the run.
 */

export type AiRunRow = { output: string | null; input_summary: string | null; sources: unknown; created_at: string };

/** What the Inbox can say about an AI-written message. */
export type AiRunNote = {
  /** The customer question the run answered. */
  question: string;
  /** The whole reply the run wrote (every part's words). */
  reply: string;
  /** Set when the answer used something the merchant taught. */
  taughtOn: string | null;
};

type Msg = {
  direction: "inbound" | "outbound";
  body: string | null;
  sent_by?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at: string;
};

/** A part of a reply is matched only when it says something (not "Ok."). */
const MIN_PART = 8;
/** A reply's messages go out within moments of its run; allow slow sends. */
const RUN_TO_SEND_MS = 10 * 60_000;
/** Clocks of the database and the send can disagree slightly. */
const SKEW_MS = 5_000;

function noteOf(run: AiRunRow): AiRunNote {
  const sources = Array.isArray(run.sources) ? (run.sources as Array<{ sourceType?: string }>) : [];
  const taught = sources.some((s) => s?.sourceType === "manual_qa");
  return {
    question: run.input_summary ?? "",
    reply: (run.output ?? "").trim(),
    taughtOn: taught ? new Date(run.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "long" }) : null,
  };
}

/**
 * The run behind a message, or null when a person, a flow, a campaign or any
 * other automation sent it. `runs` newest first (as the Inbox reads them).
 */
export function aiRunFor(message: Msg, runs: AiRunRow[]): AiRunNote | null {
  if (message.direction !== "outbound" || message.sent_by) return null;
  const kind = typeof message.metadata?.["kind"] === "string" ? (message.metadata["kind"] as string) : null;
  if (kind && kind !== "ai_product") return null;
  const body = (message.body ?? "").trim();

  // The whole reply in one message: the run whose answer it is word for word.
  if (body && kind === null) {
    const exact = runs.find((r) => (r.output ?? "").trim() === body);
    if (exact) return noteOf(exact);
  }

  // A part of a reply, or one of its product pictures: the latest run that
  // finished just before it was sent (and, for words, whose answer has them).
  const sent = new Date(message.created_at).getTime();
  for (const run of runs) {
    const at = new Date(run.created_at).getTime();
    if (at > sent + SKEW_MS) continue;
    if (sent - at > RUN_TO_SEND_MS) break;
    if (kind === "ai_product") return noteOf(run);
    if (body.length >= MIN_PART && (run.output ?? "").includes(body)) return noteOf(run);
  }
  return null;
}

/** The customer's message just before `index`: the question when the run didn't record one. */
export function questionBefore(messages: Msg[], index: number): string {
  for (let i = index - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.direction === "inbound" && (m.body ?? "").trim()) return (m.body ?? "").trim();
  }
  return "";
}
