import type { SupabaseClient } from "@supabase/supabase-js";
import type { SenderContext, SendCampaignContext } from "@/lib/campaigns.server";
import { campaignCallbackData } from "@/lib/campaign-callback";

/**
 * Campaign sending at scale (Batch 12).
 *
 * One worker run ("lane") keeps claiming and sending until a time budget runs
 * out, instead of 30 recipients of 5 campaigns per minute:
 *
 *  - Fair: every running campaign is served, workspace by workspace in turn
 *    and campaign by campaign within a workspace, so one 10,000-message
 *    campaign never starves a 50-message one. No campaign cap.
 *  - Bounded: at most `concurrency` Graph sends in flight per run (a
 *    Cloudflare Worker keeps six outgoing requests open; more only queue),
 *    and per phone number a token bucket just under Meta's throughput,
 *    divided across lanes so all lanes together stay under it. Meta's
 *    throughput errors (130429 and friends) back the number off.
 *  - At most once: a recipient is sent only by the run that claimed it
 *    (claim_campaign_recipients, FOR UPDATE SKIP LOCKED), and only a handful
 *    are claimed at a time, just before they go. A live run puts every
 *    claimed-but-unsent recipient back ('queued'). A run that died leaves
 *    'sending' rows behind; after `staleMs` they are settled from what was
 *    recorded — a message row means it went, no message row means we can't
 *    know, so it is marked failed and never sent again.
 *  - Cheap: database writes are batched (one insert for many message rows,
 *    one update per outcome, one counter bump per campaign per flush), so a
 *    send costs one Graph call plus a fraction of a database round trip.
 *
 * Unchanged from before: opt-out re-checked right before sending, wallet
 * hold before the first message (Batch 2), per-message charging by the
 * database when Meta prices it, completion once nothing is queued or
 * sending, campaign.completed emitted once, the reservation settled.
 */

// ---------------------------------------------------------------- config

export type DispatchConfig = {
  /** This run's lane and how many lanes the cron starts together. */
  lane: number;
  lanes: number;
  /** No new send starts after this many ms. In-flight sends then finish. */
  budgetMs: number;
  /** Graph sends in flight at once in this run. */
  concurrency: number;
  /** Messages per second per phone number, across all lanes together. */
  numberMps: number;
  /** Most recipients one campaign claims at once. */
  claimMax: number;
  /** A 'sending' recipient untouched this long has lost its run. */
  staleMs: number;
  /** How often pause / resume / cancel is re-read. */
  statusPollMs: number;
  /** Results are written at least this often, or every `flushSize` results. */
  flushMs: number;
  flushSize: number;
  /** A Graph send with no answer after this long is given up (never retried). */
  sendTimeoutMs: number;
  /** Tries of one recipient when Meta says "slow down" before it counts as failed. */
  maxAttempts: number;
};

export const DISPATCH_DEFAULTS: Omit<DispatchConfig, "lane" | "lanes"> = {
  budgetMs: 22_000,
  concurrency: 6,
  numberMps: 60,
  claimMax: 50,
  staleMs: 5 * 60_000,
  statusPollMs: 2_000,
  flushMs: 1_000,
  flushSize: 50,
  sendTimeoutMs: 6_000,
  maxAttempts: 4,
};

function intIn(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * The run's settings: lane from the cron body, the rest from the
 * environment (CAMPAIGN_*), each clamped to a safe range.
 */
export function dispatchConfig(
  input: { lane?: unknown; lanes?: unknown },
  env: Record<string, string | undefined> = process.env,
): DispatchConfig {
  const d = DISPATCH_DEFAULTS;
  const lanes = intIn(input.lanes, 1, 64, 1);
  return {
    lanes,
    lane: intIn(input.lane, 0, lanes - 1, 0),
    budgetMs: intIn(env["CAMPAIGN_WORKER_BUDGET_MS"], 1_000, 25_000, d.budgetMs),
    concurrency: intIn(env["CAMPAIGN_SEND_CONCURRENCY"], 1, 50, d.concurrency),
    numberMps: intIn(env["CAMPAIGN_NUMBER_MPS"], 1, 1_000, d.numberMps),
    claimMax: intIn(env["CAMPAIGN_CLAIM_MAX"], 1, 200, d.claimMax),
    staleMs: intIn(env["CAMPAIGN_STALE_MS"], 60_000, 3_600_000, d.staleMs),
    statusPollMs: intIn(env["CAMPAIGN_STATUS_POLL_MS"], 250, 10_000, d.statusPollMs),
    flushMs: intIn(env["CAMPAIGN_FLUSH_MS"], 10, 2_000, d.flushMs),
    flushSize: intIn(env["CAMPAIGN_FLUSH_SIZE"], 1, 200, d.flushSize),
    sendTimeoutMs: intIn(env["CAMPAIGN_SEND_TIMEOUT_MS"], 1_000, 20_000, d.sendTimeoutMs),
    maxAttempts: intIn(env["CAMPAIGN_MAX_ATTEMPTS"], 1, 10, d.maxAttempts),
  };
}

// ------------------------------------------------------- Meta's answers

export type SendVerdict =
  | { kind: "sent"; metaMessageId: string | null }
  /** Meta refused for throughput; nothing was sent, so it is safe to try again later. */
  | { kind: "throttled"; scope: "number" | "recipient"; code: string | null }
  /** A real rejection: recorded as failed, exactly as before. */
  | { kind: "failed"; code: string | null }
  /** No usable answer: it may or may not have gone, so it is never retried. */
  | { kind: "unknown"; reason: string; status: number | null };

/** Throughput / temporary-outage codes: the whole number slows down and retries. */
const NUMBER_THROTTLE_CODES = new Set([
  "130429", // Cloud API throughput reached
  "131048", // spam rate limit
  "80007", // WABA rate limit
  "4", // app: too many calls
  "17", // user: too many calls
  "32", // page: too many calls
  "613", // calls within one hour exceeded
  "1", // API unknown (temporary)
  "2", // API service temporarily unavailable
  "131016", // service unavailable
]);
/** Too many messages to this one customer: only this recipient waits. */
const RECIPIENT_THROTTLE_CODES = new Set(["131056"]);

export type GraphAnswer =
  | { kind: "response"; ok: boolean; status: number; body: Record<string, unknown> }
  | { kind: "no_response"; reason: string };

export function classifyGraphAnswer(answer: GraphAnswer): SendVerdict {
  if (answer.kind === "no_response")
    return { kind: "unknown", reason: answer.reason, status: null };
  const err = (answer.body["error"] ?? null) as Record<string, unknown> | null;
  const code = err?.["code"] != null ? String(err["code"]) : null;
  if (answer.ok) {
    const id =
      ((answer.body["messages"] as Array<Record<string, unknown>> | undefined)?.[0]?.["id"] as
        string | undefined) ?? null;
    return { kind: "sent", metaMessageId: id };
  }
  if (code && RECIPIENT_THROTTLE_CODES.has(code))
    return { kind: "throttled", scope: "recipient", code };
  if ((code && NUMBER_THROTTLE_CODES.has(code)) || answer.status === 429) {
    return { kind: "throttled", scope: "number", code };
  }
  // A 5xx without Meta's error body (a gateway in between): we can't tell
  // whether the message left, so it is never sent again.
  if (answer.status >= 500 && !err) {
    return { kind: "unknown", reason: `http_${answer.status}`, status: answer.status };
  }
  // Everything else — 131049 (marketing cap for this customer), 131047
  // (24-hour window), 132xxx (template), 131026, 100… — is a normal failure
  // for this one recipient, recorded with Meta's own message.
  return { kind: "failed", code };
}

// -------------------------------------------------------- rate limiter

const BURST_SECONDS = 0.25;

type Bucket = { tokens: number; rate: number; at: number; blockedUntil: number; strikes: number };

/**
 * Token bucket per phone number. `maxRate` is this run's share of the
 * number's throughput (numberMps / the lanes sending for that number). On a throttle answer the number
 * pauses (1 s, 2 s, 4 s … 30 s) and halves its speed; each success brings
 * 5 % of the speed back.
 */
export class NumberRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly max: (key: string) => number;
  constructor(
    maxRate: number | ((key: string) => number),
    private readonly clock: () => number = Date.now,
  ) {
    this.max = typeof maxRate === "number" ? () => maxRate : maxRate;
  }

  private bucket(key: string): Bucket {
    const now = this.clock();
    let b = this.buckets.get(key);
    if (!b) {
      // Start with one token, not a full second, so lanes don't burst together.
      b = { tokens: 1, rate: this.max(key), at: now, blockedUntil: 0, strikes: 0 };
      this.buckets.set(key, b);
      return b;
    }
    // At most a quarter-second of burst: lanes sharing a number can't stack
    // full seconds of tokens on top of each other.
    const capacity = Math.max(1, b.rate * BURST_SECONDS);
    b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * b.rate);
    b.at = now;
    return b;
  }

  /** ms until this number may send again (0 = now). */
  waitMs(key: string): number {
    const b = this.bucket(key);
    const now = this.clock();
    if (now < b.blockedUntil) return b.blockedUntil - now;
    if (b.tokens >= 1) return 0;
    return Math.max(1, Math.ceil(((1 - b.tokens) / b.rate) * 1000));
  }

  take(key: string): boolean {
    if (this.waitMs(key) > 0) return false;
    this.bucket(key).tokens -= 1;
    return true;
  }

  /** Meta said slow down. Returns how long the number now waits. */
  penalize(key: string): number {
    const b = this.bucket(key);
    b.strikes += 1;
    const backoff = Math.min(30_000, 1_000 * 2 ** (b.strikes - 1));
    b.blockedUntil = this.clock() + backoff;
    b.rate = Math.max(this.max(key) / 8, b.rate / 2);
    b.tokens = 0;
    return backoff;
  }

  reward(key: string): void {
    const b = this.bucket(key);
    b.strikes = 0;
    b.rate = Math.min(this.max(key), b.rate + this.max(key) * 0.05);
  }

  rate(key: string): number {
    return this.bucket(key).rate;
  }
}

// ---------------------------------------------------------------- lanes

/**
 * Which phone numbers this lane sends for, and how many lanes share each.
 * Numbers are spread over the lanes (sorted, so every lane works out the
 * same split): with more lanes than numbers each number gets one or more
 * whole lanes; with fewer, each lane takes several numbers. A lane then
 * claims big batches for few campaigns, and a number's speed is divided
 * only by the lanes that actually send for it.
 */
export function laneShare(numbers: string[], lane: number, lanes: number): Map<string, number> {
  const sorted = [...new Set(numbers)].sort();
  const out = new Map<string, number>();
  const n = sorted.length;
  if (!n) return out;
  if (lanes >= n) {
    const idx = lane % n;
    out.set(sorted[idx]!, Math.floor((lanes - 1 - idx) / n) + 1);
  } else {
    sorted.forEach((num, i) => {
      if (i % lanes === lane) out.set(num, 1);
    });
  }
  return out;
}

// ------------------------------------------------------------ fairness

/**
 * Round robin in two levels: workspace by workspace, then campaign by
 * campaign inside a workspace. A workspace with three campaigns gets the same
 * share as a workspace with one.
 */
export class FairRotation<T> {
  private readonly groups: string[] = [];
  private readonly members = new Map<string, T[]>();
  private readonly cursor = new Map<string, number>();
  private next = 0;

  constructor(items: T[], groupOf: (item: T) => string) {
    for (const item of items) {
      const g = groupOf(item);
      if (!this.members.has(g)) {
        this.members.set(g, []);
        this.cursor.set(g, 0);
        this.groups.push(g);
      }
      this.members.get(g)!.push(item);
    }
  }

  /** The next item that `ready` accepts, moving both cursors past it. */
  pick(ready: (item: T) => boolean): T | null {
    const n = this.groups.length;
    for (let i = 0; i < n; i++) {
      const gi = (this.next + i) % n;
      const g = this.groups[gi]!;
      const list = this.members.get(g)!;
      const start = this.cursor.get(g)!;
      for (let j = 0; j < list.length; j++) {
        const idx = (start + j) % list.length;
        const item = list[idx]!;
        if (!ready(item)) continue;
        this.cursor.set(g, (idx + 1) % list.length);
        this.next = (gi + 1) % n;
        return item;
      }
    }
    return null;
  }
}

// ------------------------------------------------------------ the run

type Recipient = {
  id: string;
  contactId: string | null;
  phone: string;
  variables: Record<string, string>;
  conversationId: string | null;
  attempts: number;
  notBefore: number;
};

type CardTools = typeof import("@/lib/customer-cards.server");

type Live = {
  /** The number this campaign sends from, as lanes split the work (account id). */
  laneKey: string;
  id: string;
  orgId: string;
  accountId: string | null;
  status: string;
  startedAt: string | null;
  totalRecipients: number;
  templateName: string;
  language: string;
  sender: SenderContext;
  template: {
    name: string;
    language: string;
    variableOrder: number[];
    components: import("@/lib/templates").TemplateComponent[] | null;
  };
  context: SendCampaignContext;
  card: { kind: string; vars: Record<string, string> } | null;
  cardTools: CardTools | null;
  formIds: Map<string, Promise<string | null>>;
  buffer: Recipient[];
  inflight: number;
  refilling: boolean;
  exhausted: boolean;
  stopped: string | null;
  sent: number;
  failed: number;
  skipped: number;
  retried: number;
  unknown: number;
  released: number;
};

export type DispatchReport = {
  lane: number;
  lanes: number;
  ms: number;
  processed: number;
  sent: number;
  failed: number;
  campaigns: Array<Record<string, unknown>>;
};

/** What a recipient whose run died mid-send is marked with. Never retried. */
export const STALE_SEND_ERROR =
  "Not sent: sending stopped unexpectedly before this message was confirmed. It is not retried, so nobody gets it twice.";
export const UNKNOWN_SEND_ERROR =
  "We couldn't confirm this message with WhatsApp. It is not retried, so nobody gets it twice.";

export type DispatchDeps = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The Graph send (tests and the load test point it elsewhere). */
  postMessage?: (
    sender: SenderContext,
    body: Record<string, unknown>,
    timeoutMs: number,
  ) => Promise<GraphAnswer>;
};

/** POST /{phone-number-id}/messages, with a timeout and no retries of its own. */
export async function postGraphMessage(
  sender: SenderContext,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<GraphAnswer> {
  const { GRAPH_VERSION } = await import("@/lib/whatsapp-api.server");
  let res: Response;
  try {
    res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${sender.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sender.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch (error) {
    return {
      kind: "no_response",
      reason: error instanceof Error ? error.name || error.message : "fetch_failed",
    };
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return { kind: "response", ok: res.ok, status: res.status, body: parsed };
}

const uuid = () => crypto.randomUUID();

/**
 * A recipient write, tried up to three times. A merchant's cancel updates
 * all of a campaign's queued/sending rows in one statement; meeting a
 * worker's write on the same rows, Postgres may pick one of them as a
 * deadlock victim — trying again then succeeds.
 */
async function withRetry(
  run: () => PromiseLike<{ error: { message: string } | null }>,
  tries = 3,
): Promise<{ error: { message: string } | null }> {
  let last: { error: { message: string } | null } = { error: null };
  for (let i = 0; i < tries; i++) {
    last = await run();
    if (!last.error) return last;
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 150 * (i + 1)));
  }
  console.error(
    JSON.stringify({ at: "campaign_recipient_write_failed", error: last.error?.message }),
  );
  return last;
}
const COUNTER_EVERY_MS = 2_000;

export async function runCampaignDispatch(
  supabase: SupabaseClient,
  cfg: DispatchConfig,
  deps: DispatchDeps = {},
): Promise<DispatchReport> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const postMessage = deps.postMessage ?? postGraphMessage;
  const started = now();
  const deadline = started + cfg.budgetMs;
  const report: DispatchReport = {
    lane: cfg.lane,
    lanes: cfg.lanes,
    ms: 0,
    processed: 0,
    sent: 0,
    failed: 0,
    campaigns: [],
  };

  const { live: campaigns, ids, share, readAt } = await loadActiveCampaigns(supabase, cfg, report);
  if (cfg.lane === 0) {
    await Promise.all(ids.map((id) => reclaimStale(supabase, id, cfg, now)));
  }
  report.processed = campaigns.length + report.campaigns.length;
  if (campaigns.length === 0) {
    report.ms = now() - started;
    return report;
  }

  // A number's speed is split across the lanes that send for it.
  const lanesFor = (c: Live) => share.get(c.laneKey) ?? cfg.lanes;
  const numberLanes = new Map(campaigns.map((c) => [c.sender.phoneNumberId, lanesFor(c)]));
  const limiter = new NumberRateLimiter(
    (number) => cfg.numberMps / (numberLanes.get(number) ?? cfg.lanes),
    now,
  );
  const recorder = new SendRecorder(supabase, cfg, now);
  const rotation = new FairRotation(campaigns, (c) => c.orgId);
  const tasks = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>): Promise<T> => {
    tasks.add(p);
    void p.finally(() => tasks.delete(p)).catch(() => {});
    return p;
  };

  let wake: (() => void) | null = null;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  const waitSignal = (ms: number) =>
    new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      wake = finish;
      void sleep(Math.max(1, ms)).then(finish);
    });

  let inflight = 0;
  const activeCount = () =>
    campaigns.filter((c) => !c.stopped && !(c.exhausted && !c.buffer.length)).length;

  const claimSize = (c: Live) => {
    const laneRate = cfg.numberMps / lanesFor(c);
    const share = (cfg.concurrency * 3) / Math.max(1, activeCount());
    // About five seconds of sending: few enough that a run dying leaves
    // little undecided, enough that claiming isn't a round trip per message.
    return Math.max(5, Math.min(cfg.claimMax, Math.ceil(Math.min(laneRate, share) * 5)));
  };

  const release = async (c: Live, rows: Recipient[]) => {
    if (!rows.length) return;
    c.released += rows.length;
    await withRetry(() =>
      supabase
        .from("campaign_recipients")
        .update({ status: "queued" })
        .in(
          "id",
          rows.map((r) => r.id),
        )
        .eq("status", "sending"),
    );
  };

  const stop = (c: Live, reason: string) => {
    if (c.stopped) return;
    c.stopped = reason;
    void track(release(c, c.buffer.splice(0)));
  };

  const refill = (c: Live) => {
    c.refilling = true;
    void track(
      (async () => {
        try {
          const fresh = await claimAndCheck(supabase, c, claimSize(c), recorder);
          if (c.stopped || now() >= deadline) await release(c, fresh);
          else c.buffer.push(...fresh);
        } catch (error) {
          console.error(
            JSON.stringify({
              at: "campaign_claim_failed",
              campaign_id: c.id,
              error: String(error),
            }),
          );
          c.exhausted = true;
        } finally {
          c.refilling = false;
          notify();
        }
      })(),
    );
  };

  // The statuses in hand are as old as the campaign read: if preparing took
  // longer than a poll interval, the first poll happens straight away.
  let lastPoll = now() - (Date.now() - readAt);
  let polling = false;
  const pollStatuses = () => {
    if (polling || now() - lastPoll < cfg.statusPollMs) return;
    polling = true;
    void track(
      (async () => {
        try {
          const ids = campaigns.filter((c) => !c.stopped).map((c) => c.id);
          if (!ids.length) return;
          const { data, error } = await supabase
            .from("campaigns")
            .select("id, status")
            .in("id", ids);
          if (error) return;
          for (const row of (data ?? []) as Array<{ id: string; status: string }>) {
            const c = campaigns.find((x) => x.id === row.id);
            if (c && row.status !== "sending") stop(c, row.status);
          }
        } finally {
          lastPoll = now();
          polling = false;
          notify();
        }
      })(),
    );
  };

  const ready = (c: Live, t: number) =>
    !c.stopped &&
    c.buffer.some((r) => r.notBefore <= t) &&
    limiter.waitMs(c.sender.phoneNumberId) === 0;

  const launch = (c: Live, r: Recipient) => {
    inflight += 1;
    c.inflight += 1;
    void track(
      sendOne(supabase, c, r, { cfg, limiter, recorder, postMessage, now }).finally(() => {
        inflight -= 1;
        c.inflight -= 1;
        notify();
      }),
    );
  };

  while (now() < deadline) {
    pollStatuses();
    for (const c of campaigns) {
      if (
        !c.stopped &&
        !c.refilling &&
        !c.exhausted &&
        c.buffer.length < Math.ceil(claimSize(c) / 2)
      ) {
        refill(c);
      }
    }
    const allDone = campaigns.every(
      (c) =>
        (c.stopped || (c.exhausted && c.buffer.length === 0)) && c.inflight === 0 && !c.refilling,
    );
    if (allDone) break;

    if (inflight >= cfg.concurrency) {
      await waitSignal(Math.max(1, Math.min(1_000, deadline - now())));
      continue;
    }
    const t = now();
    const c = rotation.pick((x) => ready(x, t));
    if (!c) {
      let wait = 100;
      for (const x of campaigns) {
        if (x.stopped || !x.buffer.length) continue;
        const earliest = Math.min(...x.buffer.map((r) => r.notBefore)) - t;
        wait = Math.min(wait, Math.max(limiter.waitMs(x.sender.phoneNumberId), earliest));
      }
      await waitSignal(Math.max(2, Math.min(wait, deadline - now())));
      continue;
    }
    const idx = c.buffer.findIndex((r) => r.notBefore <= t);
    const [r] = c.buffer.splice(idx, 1);
    limiter.take(c.sender.phoneNumberId);
    launch(c, r!);
  }

  // Budget spent (or nothing left): let what's in flight finish, then put
  // back whatever was claimed and not sent.
  while (tasks.size) await Promise.allSettled([...tasks]);
  for (const c of campaigns) await release(c, c.buffer.splice(0));
  await recorder.drain();

  for (const c of campaigns) {
    const line: Record<string, unknown> = {
      campaign_id: c.id,
      sent: c.sent,
      failed: c.failed,
      skipped: c.skipped,
      retried: c.retried,
      unknown: c.unknown,
      released: c.released,
    };
    if (c.stopped) line["stopped"] = c.stopped;
    else line["remaining"] = await completeIfDone(supabase, c, now);
    report.campaigns.push(line);
    report.sent += c.sent;
    report.failed += c.failed;
  }

  if (cfg.lane === 0) {
    // Bookkeeping only: never fails the run.
    await sweepCharged(supabase, now).catch((error) =>
      console.warn(JSON.stringify({ at: "campaign_charged_sweep_failed", error: String(error) })),
    );
    // Every five minutes: ended campaigns still holding credits (a settle
    // that failed, or a campaign that failed after its hold) are settled.
    if (Math.floor(now() / 60_000) % 5 === 0) {
      await import("@/lib/campaign-billing.server")
        .then((m) => m.settleEndedHolds(supabase))
        .catch((error) =>
          console.warn(JSON.stringify({ at: "campaign_hold_sweep_failed", error: String(error) })),
        );
    }
  }
  report.ms = now() - started;
  return report;
}

// ------------------------------------------------- campaigns for this run

const TEMPLATE_CACHE_MS = 30_000;
const senderCache = new Map<string, { at: number; value: Promise<SenderContext | null> }>();

function cachedSender(
  supabase: SupabaseClient,
  orgId: string,
  accountId: string | null,
): Promise<SenderContext | null> {
  const key = `${orgId}:${accountId ?? ""}`;
  const hit = senderCache.get(key);
  if (hit && Date.now() - hit.at < TEMPLATE_CACHE_MS) return hit.value;
  const value = import("@/lib/campaigns.server").then((m) =>
    m.loadSenderContext(supabase, orgId, accountId),
  );
  senderCache.set(key, { at: Date.now(), value });
  void value.catch(() => senderCache.delete(key));
  return value;
}

type TemplateRow = { components?: unknown; category?: string } | null;
const templateCache = new Map<string, { at: number; value: Promise<TemplateRow> }>();

/** The template's components and category, read at most every 30 s per isolate. */
function cachedTemplate(
  supabase: SupabaseClient,
  orgId: string,
  wabaId: string,
  name: string,
): Promise<TemplateRow> {
  const key = `${orgId}:${wabaId}:${name}`;
  const hit = templateCache.get(key);
  if (hit && Date.now() - hit.at < TEMPLATE_CACHE_MS) return hit.value;
  const value = Promise.resolve(
    supabase
      .from("message_templates")
      .select("components, category")
      .eq("organization_id", orgId)
      // Template libraries are per business account.
      .eq("waba_id", wabaId)
      .eq("name", name)
      .limit(1)
      .maybeSingle(),
  ).then(({ data, error }) => {
    if (error) templateCache.delete(key);
    return (data as TemplateRow) ?? null;
  });
  templateCache.set(key, { at: Date.now(), value });
  return value;
}

/** Test hook: forget cached senders and templates between scenarios. */
export function resetDispatchCaches(): void {
  senderCache.clear();
  templateCache.clear();
}

async function loadActiveCampaigns(
  supabase: SupabaseClient,
  cfg: DispatchConfig,
  report: DispatchReport,
): Promise<{ live: Live[]; ids: string[]; share: Map<string, number>; readAt: number }> {
  const nowIso = new Date().toISOString();
  const readAt = Date.now();
  const { data } = await supabase
    .from("campaigns")
    .select(
      "id, organization_id, whatsapp_account_id, status, template_name, template_language, scheduled_at, started_at, send_settings, held_amount, estimated_cost, total_recipients",
    )
    .or(`status.eq.sending,and(status.eq.scheduled,scheduled_at.lte.${nowIso})`)
    .order("created_at", { ascending: true })
    .limit(500);

  const billingByOrg = new Map<string, Promise<boolean>>();
  const billingOn = (orgId: string) => {
    let p = billingByOrg.get(orgId);
    if (!p) {
      p = import("@/lib/billing.server")
        .then((m) => m.billingEnabled(supabase, orgId))
        .catch(() => true);
      billingByOrg.set(orgId, p);
    }
    return p;
  };

  // 1. Which campaigns may send now (every campaign; lane 0 starts them).
  const eligible = (
    await Promise.all(
      ((data ?? []) as Array<Record<string, unknown>>).map(async (row) => {
        const campaignId = row["id"] as string;
        const orgId = row["organization_id"] as string;
        let status = String(row["status"] ?? "");

        if (cfg.lane === 0) {
          // Reserve the credits before the first message leaves, then start.
          const { holdCampaign } = await import("@/lib/campaign-billing.server");
          const hold = await holdCampaign(supabase, orgId, campaignId);
          if (!hold.ok) {
            await supabase.from("campaigns").update({ status: "paused" }).eq("id", campaignId);
            report.campaigns.push({ campaign_id: campaignId, paused: "insufficient_credits" });
            return null;
          }
          if (status === "scheduled") {
            await supabase
              .from("campaigns")
              .update({ status: "sending", started_at: row["started_at"] ?? nowIso })
              .eq("id", campaignId)
              .eq("status", "scheduled");
            status = "sending";
          }
        } else {
          // Only lane 0 starts campaigns and reserves credits; the other lanes
          // join once the reservation is in place.
          if (status !== "sending") return null;
          const held = Number(row["held_amount"] ?? 0) > 0;
          const needsHold = Number(row["estimated_cost"] ?? 0) > 0;
          if (needsHold && !held && (await billingOn(orgId))) return null;
        }
        return { row, status };
      }),
    )
  ).filter((x): x is { row: Record<string, unknown>; status: string } => x !== null);

  // 2. This lane's numbers: decided from the campaign rows alone, so only
  //    the campaigns this lane sends for are prepared.
  const keyOf = (row: Record<string, unknown>) =>
    (row["whatsapp_account_id"] as string | null) ?? `org:${String(row["organization_id"])}`;
  const share = laneShare(
    eligible.map((e) => keyOf(e.row)),
    cfg.lane,
    cfg.lanes,
  );
  const mine = eligible.filter((e) => share.has(keyOf(e.row)));

  // 3. Prepare them, side by side.
  const out = (
    await Promise.all(
      mine.map(async ({ row, status }): Promise<Live | null> => {
        const campaignId = row["id"] as string;
        const orgId = row["organization_id"] as string;

        const templateName = (row["template_name"] as string | null) ?? "";
        if (!templateName) {
          await supabase.from("campaigns").update({ status: "failed" }).eq("id", campaignId);
          return null;
        }

        // The campaign carries the number it was created for.
        const accountId = (row["whatsapp_account_id"] as string | null) ?? null;
        const sender = await cachedSender(supabase, orgId, accountId);
        if (!sender) {
          await supabase.from("campaigns").update({ status: "paused" }).eq("id", campaignId);
          report.campaigns.push({ campaign_id: campaignId, paused: "no_active_whatsapp_account" });
          return null;
        }

        const template = await cachedTemplate(supabase, orgId, sender.wabaId, templateName);
        const { extractVariables, templateBodyText } = await import("@/lib/templates");
        const category = String(
          (template as { category?: string } | null)?.category ?? "marketing",
        ).toLowerCase();
        const components = ((template as { components?: unknown } | null)?.components ?? null) as
          import("@/lib/templates").TemplateComponent[] | null;

        // Media and offer details chosen when the campaign was created.
        const settings = (row["send_settings"] ?? {}) as Record<string, unknown>;
        const headerMediaUrl = (settings["header_media_url"] as string | null) ?? null;
        const settingCards = Array.isArray(settings["cards"])
          ? (
              settings["cards"] as Array<{ media_url?: string | null; coupon_code?: string | null }>
            ).map((c) => ({
              mediaUrl: c?.media_url ?? null,
              couponCode: c?.coupon_code ?? null,
            }))
          : [];
        const couponCode = (settings["coupon_code"] as string | null) ?? null;
        const offerExpiresAt = (settings["offer_expires_at"] as string | null) ?? null;

        // A branded picture card attached at creation time, sent after each
        // template — only when the workspace has cards on.
        const cardCfg = (settings["card"] ?? null) as {
          kind?: string;
          vars?: Record<string, string>;
        } | null;
        const cardTools = cardCfg?.kind
          ? await import("@/lib/customer-cards.server").catch(() => null)
          : null;
        const cardsOn = cardTools
          ? await cardTools.cardsEnabled(supabase, orgId).catch(() => false)
          : false;

        return {
          laneKey: keyOf(row),
          id: campaignId,
          orgId,
          accountId,
          status,
          startedAt: (row["started_at"] as string | null) ?? nowIso,
          totalRecipients: Number(row["total_recipients"] ?? 0),
          templateName,
          language: (row["template_language"] as string) ?? "en_US",
          sender,
          template: {
            name: templateName,
            language: (row["template_language"] as string) ?? "en_US",
            variableOrder: extractVariables(templateBodyText((components ?? []) as never)),
            components,
          },
          context: {
            campaignId,
            category,
            ...(headerMediaUrl ? { headerMediaUrl } : {}),
            ...(settingCards.length ? { cards: settingCards } : {}),
            ...(couponCode ? { couponCode } : {}),
            ...(offerExpiresAt ? { offerExpiresAt } : {}),
          },
          card:
            cardsOn && cardTools && cardCfg?.kind
              ? { kind: cardCfg.kind, vars: cardCfg.vars ?? {} }
              : null,
          cardTools: cardsOn ? cardTools : null,
          formIds: new Map(),
          buffer: [],
          inflight: 0,
          refilling: false,
          exhausted: false,
          stopped: null,
          sent: 0,
          failed: 0,
          skipped: 0,
          retried: 0,
          unknown: 0,
          released: 0,
        };
      }),
    )
  ).filter((x): x is Live => x !== null);
  return { live: out, ids: eligible.map((e) => e.row["id"] as string), share, readAt };
}

// ----------------------------------------------------------- claiming

/**
 * Claims up to `limit` queued recipients and re-checks opt-out for all of
 * them in one read, right before they are sent. Opted-out → skipped; a
 * failed check → failed (never sent). Returns the ones that may go, with
 * their conversation already found or opened.
 */
async function claimAndCheck(
  supabase: SupabaseClient,
  c: Live,
  limit: number,
  recorder: SendRecorder,
): Promise<Recipient[]> {
  const { data: claimed, error } = await supabase.rpc("claim_campaign_recipients", {
    p_campaign_id: c.id,
    p_limit: limit,
  });
  if (error) throw new Error(error.message);
  const rows = (claimed ?? []) as Array<{
    id: string;
    contact_id: string | null;
    phone: string;
    resolved_variables: Record<string, string> | null;
  }>;
  if (rows.length < limit) c.exhausted = true;
  if (!rows.length) return [];

  // Opt-out is checked at send time, not only when the list was built.
  const optedOut = new Set<string>();
  const checkFailed = new Set<string>();
  const contactIds = rows.map((r) => r.contact_id).filter((x): x is string => Boolean(x));
  // The contacts' threads come embedded in the same read (one round trip);
  // if the embed can't be read, the plain read and a separate lookup follow.
  let threads: Map<string, string> | undefined;
  if (contactIds.length) {
    let { data, error: readError }: { data: unknown[] | null; error: unknown } = await supabase
      .from("contacts")
      .select("id, opt_in_status, conversations(id, whatsapp_account_id, status)")
      .eq("organization_id", c.orgId)
      .in("id", contactIds);
    if (readError) {
      ({ data, error: readError } = await supabase
        .from("contacts")
        .select("id, opt_in_status")
        .eq("organization_id", c.orgId)
        .in("id", contactIds));
    } else {
      threads = new Map();
      for (const contact of (data ?? []) as Array<{
        id: string;
        conversations?: Array<{
          id: string;
          whatsapp_account_id: string | null;
          status: string | null;
        }> | null;
      }>) {
        // One open thread per contact per number (a unique index says so).
        const open = (contact.conversations ?? []).find(
          (cv) => cv.whatsapp_account_id === c.sender.accountId && cv.status !== "closed",
        );
        if (open) threads.set(contact.id, open.id);
      }
    }
    const { isOptedOut } = await import("@/lib/opt-out.server");
    for (const r of rows) {
      if (!r.contact_id) continue;
      if (readError) checkFailed.add(r.id);
      else {
        const hit = ((data ?? []) as Array<{ id: string; opt_in_status: string | null }>).find(
          (x) => x.id === r.contact_id,
        );
        if (isOptedOut(hit?.opt_in_status)) optedOut.add(r.id);
      }
    }
  }
  const phoneOnly = rows.filter((r) => !r.contact_id);
  if (phoneOnly.length) {
    const { contactOptedOut } = await import("@/lib/opt-out.server");
    for (const r of phoneOnly) {
      const result = await contactOptedOut(supabase, c.orgId, { contactId: null, phone: r.phone });
      if (result.error) checkFailed.add(r.id);
      else if (result.optedOut) optedOut.add(r.id);
    }
  }
  if (optedOut.size) {
    c.skipped += optedOut.size;
    await withRetry(() =>
      supabase
        .from("campaign_recipients")
        .update({ status: "skipped", error: "opted_out" })
        .in("id", [...optedOut]),
    );
  }
  if (checkFailed.size) {
    c.failed += checkFailed.size;
    await withRetry(() =>
      supabase
        .from("campaign_recipients")
        .update({ status: "failed", error: "opt_out_check_failed" })
        .in("id", [...checkFailed]),
    );
    recorder.bump(c.id, { failed: checkFailed.size });
  }

  const go = rows.filter((r) => !optedOut.has(r.id) && !checkFailed.has(r.id));
  const conversations = await conversationsFor(
    supabase,
    c,
    go.map((r) => r.contact_id).filter((x): x is string => Boolean(x)),
    threads,
  );
  return go.map((r) => ({
    id: r.id,
    contactId: r.contact_id,
    phone: r.phone,
    variables: r.resolved_variables ?? {},
    conversationId: r.contact_id ? (conversations.get(r.contact_id) ?? null) : null,
    attempts: 0,
    notBefore: 0,
  }));
}

/** One open thread per contact per number: found in one read, the missing ones opened together. */
async function conversationsFor(
  supabase: SupabaseClient,
  c: Live,
  contactIds: string[],
  /** Threads already read with the contacts. */
  known?: Map<string, string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!contactIds.length) return out;
  const accountId = c.sender.accountId;
  const { data, error } = known
    ? {
        data: contactIds.flatMap((id) =>
          known.has(id) ? [{ id: known.get(id)!, contact_id: id }] : [],
        ),
        error: null,
      }
    : await supabase
        .from("conversations")
        .select("id, contact_id")
        .eq("organization_id", c.orgId)
        .eq("whatsapp_account_id", accountId)
        .in("contact_id", contactIds)
        .neq("status", "closed")
        .order("last_message_at", { ascending: false });
  if (!error) {
    for (const row of (data ?? []) as Array<{ id: string; contact_id: string }>) {
      if (!out.has(row.contact_id)) out.set(row.contact_id, row.id);
    }
  }
  const missing = [...new Set(contactIds.filter((id) => !out.has(id)))];
  if (!missing.length) return out;
  if (!error) {
    const { data: created, error: insertError } = await supabase
      .from("conversations")
      .insert(
        missing.map((contactId) => ({
          organization_id: c.orgId,
          contact_id: contactId,
          whatsapp_account_id: accountId,
          status: "open",
        })),
      )
      .select("id, contact_id");
    if (!insertError) {
      for (const row of (created ?? []) as Array<{ id: string; contact_id: string }>) {
        out.set(row.contact_id, row.id);
      }
      return out;
    }
  }
  // Someone opened one meanwhile (or the read failed): one at a time, as before.
  const { conversationFor } = await import("@/lib/campaigns.server");
  for (const contactId of missing) {
    const id = await conversationFor(supabase, c.orgId, accountId, contactId);
    if (id) out.set(contactId, id);
  }
  return out;
}

// ------------------------------------------------------------- sending

async function sendOne(
  supabase: SupabaseClient,
  c: Live,
  r: Recipient,
  env: {
    cfg: DispatchConfig;
    limiter: NumberRateLimiter;
    recorder: SendRecorder;
    postMessage: NonNullable<DispatchDeps["postMessage"]>;
    now: () => number;
  },
): Promise<void> {
  const { cfg, limiter, recorder, postMessage, now } = env;
  const number = c.sender.phoneNumberId;
  try {
    // A recipient with no contact row (not something launch creates) takes
    // the one-at-a-time path, which creates the contact as it always did.
    if (!r.contactId) {
      await sendLegacy(supabase, c, r, recorder);
      return;
    }

    const { toWaId } = await import("@/lib/phone");
    const to = toWaId(r.phone);
    if (!to || to.length < 8) {
      c.failed += 1;
      recorder.failure(c, r, {
        friendly: "Invalid phone number.",
        detail: JSON.stringify({ message: "invalid_phone_number", phone: r.phone }),
        code: "invalid_phone_number",
      });
      return;
    }

    const { buildTemplateRequest } = await import("@/lib/campaigns.server");
    const built = await buildTemplateRequest({
      template: c.template,
      variables: r.variables,
      context: c.context,
      mintLink: async (target) => {
        const { createShortLink } = await import("@/lib/short-links.server");
        return await createShortLink(supabase, {
          organizationId: c.orgId,
          targetUrl: target,
          scheduledSendId: null,
          campaignId: c.id,
          contactId: r.contactId,
        });
      },
      formIdFor: (metaFlowId) => {
        let p = c.formIds.get(metaFlowId);
        if (!p) {
          p = Promise.resolve(
            supabase
              .from("wa_forms")
              .select("id")
              .eq("organization_id", c.orgId)
              .eq("meta_flow_id", metaFlowId)
              .order("version", { ascending: false })
              .limit(1)
              .maybeSingle(),
          ).then(({ data }) => (data as { id: string } | null)?.id ?? null);
          c.formIds.set(metaFlowId, p);
        }
        return p;
      },
    });
    if (!built.ok) {
      c.failed += 1;
      recorder.failure(c, r, { friendly: built.friendly, detail: built.detail, code: built.code });
      return;
    }

    // Paused or cancelled while this one waited its turn: it goes back.
    if (c.stopped) {
      c.buffer.unshift(r);
      return;
    }
    const answer = await postMessage(
      c.sender,
      {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: c.template.name,
          language: { code: c.template.language },
          ...(built.components.length ? { components: built.components } : {}),
        },
        // Echoed back on every status webhook, so a status that arrives before
        // our message row is written can still find its campaign recipient.
        biz_opaque_callback_data: campaignCallbackData(c.id, r.id),
      },
      cfg.sendTimeoutMs,
    );
    const verdict = classifyGraphAnswer(answer);

    if (verdict.kind === "sent") {
      limiter.reward(number);
      c.sent += 1;
      if (c.card && c.cardTools) {
        try {
          // The card is a second message from the same number.
          while (!limiter.take(number)) {
            await new Promise((res) => setTimeout(res, Math.min(250, limiter.waitMs(number))));
          }
          await c.cardTools.sendCardToContact(supabase, {
            organizationId: c.orgId,
            contactId: r.contactId,
            phone: r.phone,
            sender: c.sender,
            kind: c.card.kind,
            vars: c.cardTools.fillCardVars(c.card.vars, r.variables),
            caption: c.templateName,
          });
        } catch {
          // card is decoration; the template already arrived
        }
      }
      const { headerMediaFromComponents } = await import("@/lib/templates");
      recorder.sent(c, r, {
        metaMessageId: verdict.metaMessageId,
        headerMedia: headerMediaFromComponents(built.payloadComponents as never),
      });
      return;
    }

    if (verdict.kind === "throttled") {
      const wait = verdict.scope === "number" ? limiter.penalize(number) : 5_000 * (r.attempts + 1);
      r.attempts += 1;
      if (r.attempts < cfg.maxAttempts) {
        c.retried += 1;
        r.notBefore = now() + wait;
        c.buffer.unshift(r);
        return;
      }
    }

    if (verdict.kind === "unknown") {
      if (verdict.status !== null) limiter.penalize(number);
      c.failed += 1;
      c.unknown += 1;
      recorder.failure(c, r, {
        friendly: UNKNOWN_SEND_ERROR,
        detail: JSON.stringify({
          message: "send_outcome_unknown",
          reason: verdict.reason,
          status: verdict.status,
        }),
        code: "send_outcome_unknown",
      });
      return;
    }

    // A real rejection (or a throttle that outlasted its tries).
    const body = answer.kind === "response" ? answer.body : {};
    const { graphErrorMessage, providerErrorDetail, providerErrorCode } =
      await import("@/lib/whatsapp-api.server");
    c.failed += 1;
    recorder.failure(c, r, {
      friendly: graphErrorMessage(body),
      detail: providerErrorDetail(body),
      code: providerErrorCode(body),
    });
  } catch (error) {
    // Nothing here may stop the run; the recipient's outcome is unknown.
    console.error(
      JSON.stringify({
        at: "campaign_send_threw",
        campaign_id: c.id,
        recipient_id: r.id,
        error: String(error),
      }),
    );
    c.failed += 1;
    c.unknown += 1;
    recorder.failure(c, r, {
      friendly: UNKNOWN_SEND_ERROR,
      detail: JSON.stringify({
        message: "send_outcome_unknown",
        reason: String(error).slice(0, 200),
      }),
      code: "send_outcome_unknown",
    });
  }
}

async function sendLegacy(
  supabase: SupabaseClient,
  c: Live,
  r: Recipient,
  recorder: SendRecorder,
): Promise<void> {
  const { sendCampaignTemplate } = await import("@/lib/campaigns.server");
  const outcome = await sendCampaignTemplate(
    supabase,
    c.orgId,
    c.sender,
    { contactId: r.contactId, phone: r.phone, variables: r.variables },
    c.template,
    c.context,
  );
  if (outcome.error) {
    c.failed += 1;
    await supabase
      .from("campaign_recipients")
      .update({ status: "failed", error: outcome.error, message_id: outcome.messageId })
      .eq("id", r.id);
    recorder.bump(c.id, { failed: 1 });
  } else {
    c.sent += 1;
    await supabase
      .from("campaign_recipients")
      .update({ status: "sent", message_id: outcome.messageId, error: null })
      .eq("id", r.id);
    recorder.bump(c.id, { sent: 1 });
  }
}

// ------------------------------------------------------------ recording

type SentItem = {
  kind: "sent";
  c: Live;
  r: Recipient;
  metaMessageId: string | null;
  headerMedia: { url: string; kind: string } | null;
  at: string;
};
type FailedItem = {
  kind: "failed";
  c: Live;
  r: Recipient;
  friendly: string;
  detail: string;
  code: string | null;
  at: string;
};
type Item = SentItem | FailedItem;

/**
 * Writes outcomes in batches. Per flush, in order:
 *   1. the messages rows (one insert; ids made here so nothing is read back),
 *   2. the recipients' status (one conditional update per outcome) and their
 *      message ids (one upsert of just that column),
 *   3. events, usage meters, conversation times and the campaign counters.
 * The rows match what sendCampaignTemplate wrote one at a time.
 */
class SendRecorder {
  private pending: Item[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushes = new Set<Promise<void>>();
  /** Counter changes not yet written, per campaign. */
  private readonly counters = new Map<string, { sent: number; failed: number }>();
  private readonly lastBump = new Map<string, number>();

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly cfg: DispatchConfig,
    private readonly now: () => number,
  ) {}

  sent(
    c: Live,
    r: Recipient,
    v: { metaMessageId: string | null; headerMedia: { url: string; kind: string } | null },
  ) {
    this.push({ kind: "sent", c, r, ...v, at: new Date(this.now()).toISOString() });
  }

  failure(c: Live, r: Recipient, v: { friendly: string; detail: string; code: string | null }) {
    this.push({ kind: "failed", c, r, ...v, at: new Date(this.now()).toISOString() });
  }

  /** Counter changes, written with a later flush (at most every COUNTER_EVERY_MS per campaign). */
  bump(campaignId: string, delta: { sent?: number; failed?: number }) {
    const cur = this.counters.get(campaignId) ?? { sent: 0, failed: 0 };
    cur.sent += delta.sent ?? 0;
    cur.failed += delta.failed ?? 0;
    this.counters.set(campaignId, cur);
    this.schedule();
  }

  private push(item: Item) {
    this.pending.push(item);
    if (this.pending.length >= this.cfg.flushSize) this.flushNow();
    else this.schedule();
  }

  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flushNow(), this.cfg.flushMs);
  }

  private track(p: Promise<void>) {
    const tracked = p.catch((error) =>
      console.error(JSON.stringify({ at: "campaign_record_failed", error: String(error) })),
    );
    this.flushes.add(tracked);
    void tracked.finally(() => this.flushes.delete(tracked));
  }

  private flushNow() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const items = this.pending.splice(0);
    if (items.length) this.track(this.write(items));
    else if (this.counters.size) this.track(this.writeCounters(false));
  }

  /**
   * One counter bump per campaign at most every COUNTER_EVERY_MS (the last
   * one when the run ends), not one per flush: with many campaigns a flush
   * would otherwise cost a round trip per campaign.
   */
  private async writeCounters(force: boolean) {
    const due: Array<[string, { sent: number; failed: number }]> = [];
    for (const [campaignId, delta] of this.counters) {
      if (!delta.sent && !delta.failed) continue;
      if (!force && this.now() - (this.lastBump.get(campaignId) ?? 0) < COUNTER_EVERY_MS) continue;
      due.push([campaignId, { ...delta }]);
      this.counters.delete(campaignId);
      this.lastBump.set(campaignId, this.now());
    }
    if (!force && this.counters.size) this.schedule();
    await Promise.all(
      due.map(async ([campaignId, delta]) => {
        const { error } = await this.supabase.rpc("bump_campaign_counters", {
          p_campaign_id: campaignId,
          p_sent: delta.sent,
          p_failed: delta.failed,
        });
        // Not written: owed again, so the next bump carries it.
        if (error) this.bump(campaignId, delta);
      }),
    );
  }

  async drain() {
    this.flushNow();
    while (this.flushes.size) await Promise.allSettled([...this.flushes]);
    await this.writeCounters(true);
  }

  private async write(items: Item[]) {
    const supabase = this.supabase;
    const { outboundMessageDimensions } = await import("@/lib/message-events");

    // 1. messages rows
    const rows = items.map((it): Record<string, unknown> & { id: string } => {
      const id = uuid();
      const base = {
        id,
        organization_id: it.c.orgId,
        conversation_id: it.r.conversationId,
        direction: "outbound",
        type: "template",
        template_name: it.c.templateName,
        status_updated_at: it.at,
        campaign_id: it.c.id,
        flow_id: null,
        flow_step_id: null,
        scheduled_send_id: null,
      };
      if (it.kind === "sent") {
        return {
          ...base,
          meta_message_id: it.metaMessageId,
          ...(it.headerMedia
            ? { media_url: it.headerMedia.url, media_mime: it.headerMedia.kind }
            : {}),
          metadata: {
            // The values it was sent with, so the inbox shows "Hi Priya", not "Hi {{1}}".
            ...(Object.keys(it.r.variables).length ? { template_params: it.r.variables } : {}),
            campaign_recipient_id: it.r.id,
          },
          status: "pending",
        };
      }
      return {
        ...base,
        metadata: { campaign_recipient_id: it.r.id },
        status: "failed",
        error_detail: it.detail,
      };
    });
    const written = new Map<number, string | null>();
    if (rows.length) {
      const uniform = rows.map((row) => ({
        media_url: null,
        media_mime: null,
        meta_message_id: null,
        error_detail: null,
        ...row,
      }));
      const { error } = await supabase.from("messages").insert(uniform);
      if (!error) rows.forEach((row, i) => written.set(i, row.id));
      else {
        // One bad row must not lose the rest: one at a time, retried; a
        // duplicate is a row the batch (or a try) already wrote. A sent row
        // that still can't be written is logged with its Meta id: without it
        // the delivered status, and so the price, has nothing to land on.
        await Promise.all(
          rows.map(async (row, i) => {
            const { error: oneError } = await withRetry(async () => {
              const res = await supabase.from("messages").insert(row);
              return (res.error as { code?: string } | null)?.code === "23505" ? { error: null } : res;
            });
            written.set(i, oneError ? null : row.id);
            if (oneError && row["meta_message_id"]) {
              console.error(
                JSON.stringify({
                  at: "campaign_message_row_failed",
                  campaign_id: row["campaign_id"],
                  meta_message_id: row["meta_message_id"],
                  error: oneError.message,
                }),
              );
            }
          }),
        );
      }
    }

    // 2. recipients
    const writes: Array<PromiseLike<unknown>> = [];
    const sentIds = items.filter((it) => it.kind === "sent").map((it) => it.r.id);
    if (sentIds.length) {
      writes.push(
        withRetry(() =>
          supabase
            .from("campaign_recipients")
            .update({ status: "sent", error: null })
            .in("id", sentIds)
            // Never pulls a recipient a status webhook already moved on back to
            // 'sent'; a cancel that raced the send is overwritten with the truth.
            .in("status", ["sending", "skipped"]),
        ),
      );
    }
    const failedByError = new Map<string, string[]>();
    for (const it of items) {
      if (it.kind !== "failed") continue;
      const key = it.friendly.slice(0, 300);
      failedByError.set(key, [...(failedByError.get(key) ?? []), it.r.id]);
    }
    for (const [error, ids] of failedByError) {
      writes.push(
        withRetry(() =>
          supabase
            .from("campaign_recipients")
            .update({ status: "failed", error })
            .in("id", ids)
            .in("status", ["sending", "skipped"]),
        ),
      );
    }
    const links = items
      .map((it, i) => ({ it, messageId: written.get(i) ?? null }))
      .filter((x) => x.messageId)
      .map(({ it, messageId }) => ({
        id: it.r.id,
        campaign_id: it.c.id,
        organization_id: it.c.orgId,
        phone: it.r.phone,
        message_id: messageId,
      }));
    // The status updates touch disjoint rows; the message ids touch the same
    // rows again, so they go after (two statements locking one set of rows
    // in different orders could deadlock each other).
    await Promise.all(writes);
    if (links.length) {
      await withRetry(() =>
        supabase.from("campaign_recipients").upsert(links, { onConflict: "id" }),
      );
    }

    // 3. events, meters, conversation times, counters
    const { emitEvents, recordUsages } = await import("@/lib/events.server");
    const { meterForMessageCategory } = await import("@/lib/events");
    const events = items.map((it, i) => {
      const messageId = written.get(i) ?? null;
      return {
        eventType: it.kind === "sent" ? "message.sent" : "message.failed",
        organizationId: it.c.orgId,
        whatsappAccountId: it.c.sender.accountId,
        entityType: "message",
        entityId: messageId,
        properties: outboundMessageDimensions({
          messageId,
          conversationId: it.r.conversationId,
          contactId: it.r.contactId,
          wabaId: it.c.sender.wabaId,
          whatsappAccountId: it.c.sender.accountId,
          templateName: it.c.templateName,
          messageType: "template",
          billingCategory: it.c.context.category,
          campaignId: it.c.id,
          flowId: null,
          flowStepId: null,
          scheduledSendId: null,
          ...(it.kind === "failed" ? { errorCode: it.code } : {}),
        }),
      };
    });
    const usage = items.flatMap((it, i) =>
      it.kind === "sent"
        ? [
            {
              organizationId: it.c.orgId,
              meterKey: meterForMessageCategory(it.c.context.category),
              quantity: 1,
              metadata: {
                whatsapp_account_id: it.c.sender.accountId,
                waba_id: it.c.sender.wabaId,
                campaign_id: it.c.id,
                flow_id: null,
                flow_step_id: null,
                template_name: it.c.templateName,
                message_id: written.get(i) ?? null,
                message_type: "template",
              },
            },
          ]
        : [],
    );
    const touched = [
      ...new Set(
        items
          .filter((it) => it.kind === "sent" && it.r.conversationId)
          .map((it) => it.r.conversationId as string),
      ),
    ];
    for (const it of items) {
      this.bump(it.c.id, it.kind === "sent" ? { sent: 1 } : { failed: 1 });
    }
    const tail: Array<PromiseLike<unknown>> = [this.writeCounters(false)];
    if (events.length) {
      tail.push(
        (async () => {
          await emitEvents(supabase, events);
        })(),
      );
    }
    if (usage.length) {
      tail.push(
        (async () => {
          await recordUsages(supabase, usage);
        })(),
      );
    }
    if (touched.length) {
      const last = items.reduce((m, it) => (it.at > m ? it.at : m), "");
      tail.push(supabase.from("conversations").update({ last_message_at: last }).in("id", touched));
    }
    await Promise.all(tail);
  }
}

// ------------------------------------------------------- crash recovery

/**
 * 'sending' rows nobody has touched for `staleMs` belong to a run that died.
 * A messages row for the recipient means it went (or failed) and is
 * recorded so; no row means we can't know whether Meta got it, so it is
 * marked failed — never sent a second time.
 */
async function reclaimStale(
  supabase: SupabaseClient,
  campaignId: string,
  cfg: DispatchConfig,
  now: () => number,
): Promise<void> {
  const c = { id: campaignId };
  const cutoff = new Date(now() - cfg.staleMs).toISOString();
  const { data: stale, error } = await supabase
    .from("campaign_recipients")
    .select("id")
    .eq("campaign_id", c.id)
    .eq("status", "sending")
    .lt("updated_at", cutoff)
    .limit(500);
  if (error || !stale?.length) return;
  const ids = (stale as Array<{ id: string }>).map((s) => s.id);

  const { data: messages, error: readError } = await supabase
    .from("messages")
    .select("id, status, meta_message_id, metadata")
    .eq("campaign_id", c.id)
    .in("metadata->>campaign_recipient_id", ids);
  // Without a trustworthy answer, decide nothing this run.
  if (readError) return;
  const byRecipient = new Map<
    string,
    { id: string; status: string; meta_message_id: string | null }
  >();
  for (const m of (messages ?? []) as Array<{
    id: string;
    status: string;
    meta_message_id: string | null;
    metadata: { campaign_recipient_id?: string } | null;
  }>) {
    const rid = m.metadata?.campaign_recipient_id;
    if (rid) byRecipient.set(rid, m);
  }

  let sent = 0;
  let failed = 0;
  const writes: Array<PromiseLike<unknown>> = [];
  for (const id of ids) {
    const m = byRecipient.get(id);
    let patch: Record<string, unknown>;
    if (m && m.meta_message_id && m.status !== "failed") {
      sent += 1;
      patch = {
        status: ["sent", "delivered", "read"].includes(m.status) ? m.status : "sent",
        message_id: m.id,
        error: null,
      };
    } else if (m) {
      failed += 1;
      patch = {
        status: "failed",
        message_id: m.id,
        error: "The messaging provider rejected the request.",
      };
    } else {
      failed += 1;
      patch = { status: "failed", error: STALE_SEND_ERROR };
    }
    writes.push(
      supabase
        .from("campaign_recipients")
        .update(patch)
        .eq("id", id)
        .eq("status", "sending")
        .lt("updated_at", cutoff),
    );
  }
  await Promise.all(writes);
  if (sent || failed) {
    await supabase.rpc("bump_campaign_counters", {
      p_campaign_id: c.id,
      p_sent: sent,
      p_failed: failed,
    });
    console.warn(JSON.stringify({ at: "campaign_stale_settled", campaign_id: c.id, sent, failed }));
  }
}

// ------------------------------------------------------------ finishing

/** Returns how many are still queued or sending; completes the campaign at zero. */
async function completeIfDone(
  supabase: SupabaseClient,
  c: Live,
  now: () => number,
): Promise<number> {
  const { count: remaining } = await supabase
    .from("campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", c.id)
    .in("status", ["queued", "sending"]);
  if (remaining) return remaining;

  // Launch writes the list in pages after the campaign row: never complete
  // a campaign whose list is still being written (unless launch clearly died).
  if (c.totalRecipients > 0) {
    const { count: listed } = await supabase
      .from("campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", c.id);
    const startedMs = c.startedAt ? Date.parse(c.startedAt) : 0;
    if ((listed ?? 0) < c.totalRecipients && now() - startedMs < 10 * 60_000) return 0;
  }

  const { data: finished } = await supabase
    .from("campaigns")
    .update({ status: "completed", completed_at: new Date(now()).toISOString() })
    .eq("id", c.id)
    .eq("status", "sending")
    .select("id, sent_count, failed_count");
  // Only the run that actually flipped the row emits, so a retry of the
  // worker can't double-count a completion.
  if (!finished || finished.length === 0) return 0;

  const { emitEvent } = await import("@/lib/events.server");
  await emitEvent(supabase, "campaign.completed", {
    organizationId: c.orgId,
    whatsappAccountId: c.accountId,
    entityType: "campaign",
    entityId: c.id,
    properties: {
      campaign_id: c.id,
      template_name: c.templateName,
      sent_count: finished[0]!.sent_count ?? null,
      failed_count: finished[0]!.failed_count ?? null,
    },
  });
  // Give back the unused reservation. Each message is charged once, by the
  // database, when Meta prices it (debit_message).
  const { settleCampaignSpend } = await import("@/lib/campaign-billing.server");
  const settled = await settleCampaignSpend(supabase, c.orgId, c.id);
  if (!settled.ok) {
    console.error(
      JSON.stringify({ at: "campaign_settle_failed", campaign_id: c.id, error: settled.error }),
    );
  }
  return 0;
}

/**
 * Meta prices messages for a while after a campaign completes, and the
 * webhook only re-reads the campaign's total every few seconds. Every five
 * minutes, campaigns completed in the last six hours get their
 * charged_amount brought up to the ledger (syncCampaignCharged: re-read,
 * raise-only).
 */
async function sweepCharged(supabase: SupabaseClient, now: () => number): Promise<void> {
  const minute = Math.floor(now() / 60_000);
  if (minute % 5 !== 0) return;
  const since = new Date(now() - 6 * 3_600_000).toISOString();
  const { data } = await supabase
    .from("campaigns")
    .select("id, organization_id")
    .in("status", ["completed", "cancelled"])
    .gte("completed_at", since)
    .limit(50);
  if (!data?.length) return;
  const { syncCampaignCharged } = await import("@/lib/campaign-billing.server");
  for (const row of data as Array<{ id: string; organization_id: string }>) {
    await syncCampaignCharged(supabase, row.organization_id, row.id).catch(() => null);
  }
}
