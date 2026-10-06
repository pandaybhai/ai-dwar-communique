/**
 * Per-message reply timings. Marks are ms since this message started
 * processing (first occurrence wins); spans are measured durations (send API
 * call, post-send writes). Stored on webhook_events.timing with the update
 * that marks the event processed, so reading them costs nothing extra.
 */
export type ReplyTimer = {
  mark(stage: string): void;
  /** Adds ms to a named span (several sends add up). */
  span(name: string, ms: number): void;
};

/** Marks in the order a reply passes them; durations are taken between neighbours. */
export const STAGE_ORDER = [
  "account", // number → workspace, lead markers, opt-out words
  "contact", // contact upsert
  "conversation", // open conversation found or created
  "message_stored", // message upsert = dedupe
  "guards_done", // catalogue order, opt-out, cash-on-delivery
  "trigger_matched", // no run took it; a trigger matched and is starting its flow
  "flow_routed", // the run claimed, or a trigger's run inserted
  "run_created", // a trigger's run row written (starts only)
  "flow_env", // the run's contact, window and number ready
  "first_node", // the first step after Start begins (or the step the run waited on)
  "send_start", // the first WhatsApp send API call starts
  "flows", // flow engine returned (bookkeeping included)
  "automations",
  "burst",
  "ai_done",
] as const;

export type MessageTiming = {
  message_id: string;
  route: string;
  /** ms since this message started processing. */
  marks: Record<string, number>;
  /** ms spent in each stage (between neighbouring marks) plus measured spans. */
  ms: Record<string, number>;
  /** ms from webhook_events.received_at to the first send API call, when both are known. */
  received_to_send_ms: number | null;
  total_ms: number;
};

export function replyTimer(receivedLagMs: number | null, now: () => number = Date.now) {
  const start = now();
  const marks: Record<string, number> = {};
  const spans: Record<string, number> = {};
  const timer: ReplyTimer = {
    mark(stage) {
      if (!(stage in marks)) marks[stage] = now() - start;
    },
    span(name, ms) {
      spans[name] = (spans[name] ?? 0) + Math.max(0, Math.round(ms));
    },
  };
  const result = (messageId: string, route: string): MessageTiming => {
    const ms: Record<string, number> = {};
    let prev = 0;
    for (const stage of STAGE_ORDER) {
      const at = marks[stage];
      if (at === undefined) continue;
      ms[stage] = at - prev;
      prev = at;
    }
    for (const [k, v] of Object.entries(spans)) ms[k] = v;
    const send = marks["send_start"];
    return {
      message_id: messageId,
      route,
      marks: { ...marks },
      ms,
      received_to_send_ms: send !== undefined && receivedLagMs !== null ? receivedLagMs + send : null,
      total_ms: now() - start,
    };
  };
  return { timer, result };
}

/** Times one call and adds it to `name` on the timer, when there is one. */
export async function timed<T>(timer: ReplyTimer | undefined, name: string, work: () => Promise<T>): Promise<T> {
  if (!timer) return work();
  const at = Date.now();
  try {
    return await work();
  } finally {
    timer.span(name, Date.now() - at);
  }
}
