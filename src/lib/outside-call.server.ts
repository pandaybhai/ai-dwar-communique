/**
 * Every call to an outside service (AI providers, Meta, Razorpay, Google,
 * Shopify, Resend, media downloads) gives up after a set time instead of hanging a
 * worker until pg_net or the platform cuts it.
 *
 * A timeout throws OutsideCallTimeout, a TypeError like the one fetch()
 * itself throws when a host is unreachable — so every caller's existing
 * "couldn't reach it" handling applies unchanged, and for AI calls
 * outageOf() counts it as an outage and the backup model takes over.
 *
 * The time covers the whole exchange (headers and body) unless the caller
 * streams the body on (headersOnly), or reads a long stream (idle: the clock
 * restarts with every chunk).
 */

/** Per-target limits, ms. Generous: a healthy call never comes near them. */
export const OUTSIDE_CALL_TIMEOUT_MS = {
  /** One non-streamed model answer (the Anthropic backup client allows 120 s too). */
  ai: 120_000,
  /** A streamed model answer: silence this long, not total time. */
  ai_stream: 180_000,
  embeddings: 30_000,
  transcription: 60_000,
  meta: 20_000,
  meta_media: 60_000,
  razorpay: 15_000,
  google: 15_000,
  shopify: 20_000,
  /** One Resend send, or fetching the file it attaches. */
  email: 15_000,
} as const;

export type OutsideTarget = keyof typeof OUTSIDE_CALL_TIMEOUT_MS;

export class OutsideCallTimeout extends TypeError {
  constructor(
    readonly target: OutsideTarget,
    readonly timeoutMs: number,
  ) {
    super(`The ${target} call timed out after ${Math.round(timeoutMs / 1000)} s.`);
    this.name = "OutsideCallTimeout";
  }
}

export type OutsideCallOptions = {
  /** Overrides the target's default. */
  timeoutMs?: number;
  /** Only until the response headers arrive (the body is streamed on as is). */
  headersOnly?: boolean;
  /** The clock restarts with every body chunk (long streamed answers). */
  idle?: boolean;
};

function hostOf(input: string | URL): string {
  try {
    return new URL(String(input)).host;
  } catch {
    return "";
  }
}

export async function outsideFetch(
  target: OutsideTarget,
  input: string | URL,
  init: RequestInit = {},
  options: OutsideCallOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? OUTSIDE_CALL_TIMEOUT_MS[target];
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timedOut = () => {
    console.warn("[outside-call] timeout", JSON.stringify({ target, host: hostOf(input), timeout_ms: timeoutMs }));
    return new OutsideCallTimeout(target, timeoutMs);
  };
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), timeoutMs);
    // Never keeps a Node process alive on its own (a body nobody reads).
    (timer as { unref?: () => void }).unref?.();
  };
  const disarm = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;

  arm();
  let res: Response;
  try {
    res = await fetch(input, { ...init, signal });
  } catch (error) {
    disarm();
    if (controller.signal.aborted) throw timedOut();
    throw error;
  }
  if (options.headersOnly || !res.body) {
    disarm();
    return res;
  }
  if (options.idle) arm();

  // The body is read through here, so a stalled body also times out — as
  // OutsideCallTimeout, not a bare AbortError.
  const reader = res.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(stream) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          disarm();
          stream.close();
          return;
        }
        if (options.idle) arm();
        stream.enqueue(value);
      } catch (error) {
        disarm();
        stream.error(controller.signal.aborted ? timedOut() : error);
      }
    },
    cancel(reason) {
      disarm();
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}
