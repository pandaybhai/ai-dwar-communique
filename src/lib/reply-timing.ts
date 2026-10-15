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
  // Aiden's reply (Batch 15A): the gate passed, the answer run returned
  // (its own split is ai_runs.metadata.timing_ms), the first message and the
  // first picture accepted by WhatsApp, then everything after the sends.
  "ai_gates",
  "ai_run",
  "ai_first_send",
  "ai_first_photo",
  "ai_done",
] as const;

export type MessageTiming = {
  message_id: string;
  route: string;
  /** ms since this message started processing. */
  marks: Record<string, number>;
  /** ms spent in each stage (between neighbouring marks) plus measured spans. */
  ms: Record<string, number>;
  /**
   * Batch 29: ms from the moment we received the customer's message
   * (webhook_events.received_at; else the message's own WhatsApp time) to the
   * first send WhatsApp ACCEPTED ("send_ok"). Null only when nothing was
   * accepted in this pass.
   */
  received_to_send_ms: number | null;
  /** The same start to the first send API call (what received_to_send_ms measured before Batch 29). */
  received_to_send_start_ms: number | null;
  /** Why Aiden did or didn't answer in this pass (runAgentOnInbound's outcome), when it was asked. */
  ai_outcome?: string;
  total_ms: number;
};

/**
 * Marks kept outside STAGE_ORDER (they are moments, not stages, so the
 * per-stage durations don't change): the first send WhatsApp accepted.
 */
export const SEND_OK_MARK = "send_ok";

export function replyTimer(receivedLagMs: number | null, now: () => number = Date.now) {
  const start = now();
  const marks: Record<string, number> = {};
  const spans: Record<string, number> = {};
  const notes: { ai_outcome?: string } = {};
  // Unknown received time (a catch-up pass used to pass none): the message's
  // own WhatsApp timestamp, set once it is parsed (startedAt below).
  let lag = receivedLagMs;
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
    // A flow's first send, else Aiden's first message.
    const send = marks["send_start"] ?? marks["ai_first_send"];
    const accepted = marks[SEND_OK_MARK];
    return {
      message_id: messageId,
      route,
      marks: { ...marks },
      ms,
      received_to_send_ms: accepted !== undefined && lag !== null ? lag + accepted : null,
      received_to_send_start_ms: send !== undefined && lag !== null ? lag + send : null,
      ...(notes.ai_outcome ? { ai_outcome: notes.ai_outcome } : {}),
      total_ms: now() - start,
    };
  };
  /** The message's own time (ms epoch): used as "received" only when the event's received_at is unknown. */
  const fallbackStart = (atMs: number) => {
    if (lag === null && Number.isFinite(atMs)) lag = Math.max(0, start - atMs);
  };
  /** How far past "received" this pass is right now (ms), when known. */
  const sinceReceived = (): number | null => (lag === null ? null : lag + (now() - start));
  const note = (key: "ai_outcome", value: string) => {
    notes[key] = value;
  };
  return { timer, result, fallbackStart, sinceReceived, note };
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

/** A reply slower than this is listed on /admin/ai (Reply speed) with its reason. */
export const SLOW_REPLY_MS = 30_000;

export type ReplySpeed = {
  /** Received → first send WhatsApp accepted; null when nothing was accepted. */
  received_to_send_ms: number | null;
  /** "live" (the webhook's own pass) or how a safety-net pass picked the message up. */
  pickup: string;
  /**
   * Where most of the time went: the pickup when it wasn't live, else the
   * largest part — "waiting" (received → Aiden starting: storing, flows,
   * automations, the burst), "burst", or one of the run's own stages
   * (prelude, early_search, retrieval, model, checks), or "send".
   */
  reason: string | null;
  parts: Record<string, number>;
};

/**
 * Batch 29: one reply's speed, as stored on ai_runs.metadata.reply_speed and
 * read by reply_speed_stats (20261090). Pure: the caller measures.
 */
export function replySpeed(input: {
  receivedToSendMs: number | null;
  pickup: string;
  /** Received → Aiden's pass starting (includes the burst). */
  beforeAidenMs: number | null;
  burstMs: number | null;
  /** ai_runs.metadata.timing_ms (prelude, early_search, retrieval, model, checks). */
  runTiming: Record<string, number>;
  /** Run finished → first send accepted. */
  sendMs: number | null;
}): ReplySpeed {
  const parts: Record<string, number> = {};
  const put = (k: string, v: number | null | undefined) => {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) parts[k] = Math.round(v);
  };
  const burst = input.burstMs ?? null;
  put("waiting", input.beforeAidenMs !== null ? input.beforeAidenMs - (burst ?? 0) : null);
  put("burst", burst);
  for (const k of ["prelude", "early_search", "retrieval", "model", "checks"]) put(k, input.runTiming[k]);
  put("send", input.sendMs);
  const largest = Object.entries(parts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    received_to_send_ms: input.receivedToSendMs === null ? null : Math.round(input.receivedToSendMs),
    pickup: input.pickup,
    reason: input.pickup !== "live" ? input.pickup : largest,
    parts,
  };
}
