import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FakeOp } from "./test-support/fake-db";
import { inboundPayload, latencyWorld } from "./test-support/latency-world";
import {
  CATCH_UP_LEASE_MS,
  CATCH_UP_MESSAGES_AFTER_MS,
  REANSWER_AFTER_MS,
  STATUS_ROW_WAIT_MS,
  WEBHOOK_MAX_ATTEMPTS,
  processWebhookPayload,
  reprocessUnprocessedEvents,
} from "./whatsapp-webhook.server";

/**
 * Batch 27 — a customer is never left in silence (webhook side).
 *
 *  H1  catch-up takes a customer message only once a retry may re-answer it,
 *      and holds the event with a lease (never processed_at before it runs).
 *  H2  a throw while Aiden answers hands the chat to a person.
 *  M7  a chat a person owns gets no transcription and no automatic fallback.
 *  M12 DISABLED / DELETED / REINSTATED template events are applied.
 *  Low a status that beats its message's row is kept for the retry.
 */

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const TAP = {
  id: "wamid.tap",
  type: "interactive",
  interactive: { type: "button_reply", button_reply: { id: "menu:b1", title: "Shop" } },
  context: { id: "wamid.prompt" },
};

const eventUpdates = (ops: FakeOp[]) =>
  ops.filter((o) => o.table === "webhook_events" && o.kind === "update").map((o) => o.payload as Record<string, unknown>);

/**
 * One stored, never-finished event with a customer message whose first pass
 * died after storing it (answer_claimed_at stamped by that insert). The
 * message's state lives here, so the re-answer claim behaves like the
 * database's conditional update.
 */
function catchUpWorld(opts: {
  ageMs: number;
  lease?: string | null;
  error?: string | null;
  /** The webhook_events read refuses lease_until (migration not applied). */
  noLeaseColumn?: boolean;
}) {
  const receivedAt = new Date(Date.now() - opts.ageMs).toISOString();
  const message = { answeredAt: null as string | null, claimedAt: new Date(Date.now() - opts.ageMs + 1000).toISOString() };
  const event = {
    id: "ev-27",
    payload: inboundPayload(TAP),
    received_at: receivedAt,
    lease_until: opts.lease ?? null,
    error: opts.error ?? null,
    processed_at: null as string | null,
  };
  const w = latencyWorld({
    org: `o27-${Math.random()}`,
    rttMs: 0,
    graphMs: 0,
    waitingRun: true,
    duplicate: true,
    override: (op) => {
      if (op.table === "webhook_events" && op.kind === "select") {
        const columns = String(op.select?.[0] ?? "");
        if (columns.includes("lease_until") && opts.noLeaseColumn)
          return { data: null, error: { code: "42703", message: "column webhook_events.lease_until does not exist" } };
        if (columns === "error") return { data: { error: event.error }, error: null };
        return { data: event.processed_at ? [] : [{ ...event }], error: null };
      }
      if (op.table === "webhook_events" && op.kind === "update") {
        const patch = op.payload as Record<string, unknown>;
        const leaseFilter = op.filters.find(([n, a]) => (n === "eq" || n === "is") && a[0] === "lease_until");
        const leaseMatches =
          !leaseFilter || (leaseFilter[0] === "is" ? event.lease_until === null : event.lease_until === leaseFilter[1][1]);
        const open = !op.filters.some(([n, a]) => n === "is" && a[0] === "processed_at") || event.processed_at === null;
        if (!leaseMatches || !open) return { data: [], error: null };
        Object.assign(event, patch);
        return { data: [{ id: event.id }], error: null };
      }
      // reclaimUnanswered: answered_at IS NULL AND answer_claimed_at < cutoff.
      if (op.table === "messages" && op.kind === "update" && "answer_claimed_at" in (op.payload as object)) {
        const cutoff = op.filters.find(([n, a]) => n === "lt" && a[0] === "answer_claimed_at")?.[1][1] as string;
        if (message.answeredAt || !(message.claimedAt < cutoff)) return { data: [], error: null };
        message.claimedAt = String((op.payload as Record<string, unknown>)["answer_claimed_at"]);
        return { data: [{ id: "m-in" }], error: null };
      }
      if (op.table === "messages" && op.kind === "update" && "answered_at" in (op.payload as object)) {
        message.answeredAt = String((op.payload as Record<string, unknown>)["answered_at"]);
        return { data: [{ id: "m-in" }], error: null };
      }
      return undefined;
    },
  });
  vi.stubGlobal("fetch", w.fetchStub);
  return { ...w, event, message };
}

// The route's own settings (api/internal/reprocess-events).
const ROUTE = { olderThanSeconds: 60, limit: 500, statusConcurrency: 10 };

describe("H1: catch-up re-answers a message its first pass dropped — once", () => {
  it("the catch-up wait is the re-answer wait plus the live pass", () => {
    expect(CATCH_UP_MESSAGES_AFTER_MS).toBe(REANSWER_AFTER_MS + 30_000);
  });

  it("an event caught at 90 s is left alone (not closed as a duplicate), then re-answered once", async () => {
    const w = catchUpWorld({ ageMs: 90_000 });
    // 90 s: the re-answer claim would still lose to the dead pass's stamp.
    // Before Batch 27 this pass closed the event unanswered.
    expect(await reprocessUnprocessedEvents(w.supabase, ROUTE)).toBe(0);
    expect(w.graphSends).toEqual([]);
    expect(eventUpdates(w.ops)).toEqual([]);
    expect(w.event.processed_at).toBeNull();

    // The next pass, once the message is old enough to re-answer.
    w.event.received_at = new Date(Date.now() - 4 * 60_000).toISOString();
    w.message.claimedAt = new Date(Date.now() - 4 * 60_000 + 1000).toISOString();
    expect(await reprocessUnprocessedEvents(w.supabase, ROUTE)).toBe(1);
    expect(w.graphSends).toHaveLength(1);
    expect(w.message.answeredAt).toBeTruthy();
    expect(w.event.processed_at).toBeTruthy();
    expect(w.event.lease_until).toBeNull();

    // Nothing left to catch up, and a redelivery stays a duplicate.
    expect(await reprocessUnprocessedEvents(w.supabase, ROUTE)).toBe(0);
    w.event.processed_at = null;
    await reprocessUnprocessedEvents(w.supabase, ROUTE);
    expect(w.graphSends).toHaveLength(1);
  });

  it("the event is held with a lease, not marked processed, while it runs", async () => {
    const w = catchUpWorld({ ageMs: 4 * 60_000 });
    await reprocessUnprocessedEvents(w.supabase, ROUTE);
    const [first, ...rest] = eventUpdates(w.ops);
    expect(first).not.toHaveProperty("processed_at");
    expect(Date.parse(String(first!["lease_until"]))).toBeGreaterThan(Date.now() + CATCH_UP_LEASE_MS - 10_000);
    // Closed with processed_at and the lease let go.
    expect(rest.at(-1)).toMatchObject({ lease_until: null });
    expect(rest.at(-1)!["processed_at"]).toBeTruthy();
  });

  it("a pass that dies mid-way leaves the event open for the next one", async () => {
    const w = catchUpWorld({ ageMs: 4 * 60_000 });
    // Simulate the death: the lease is taken, then nothing closes it.
    w.event.lease_until = new Date(Date.now() - 1000).toISOString();
    w.event.error = null;
    expect(w.event.processed_at).toBeNull();
    // The next pass sees an expired lease: counts the attempt and runs it.
    expect(await reprocessUnprocessedEvents(w.supabase, ROUTE)).toBe(1);
    expect(eventUpdates(w.ops)[0]).toMatchObject({ error: "retry:1 catch-up pass never finished" });
    expect(w.graphSends).toHaveLength(1);
    expect(w.event.processed_at).toBeTruthy();
  });

  it("an event another pass holds is skipped", async () => {
    const w = catchUpWorld({ ageMs: 4 * 60_000, lease: new Date(Date.now() + 60_000).toISOString() });
    expect(await reprocessUnprocessedEvents(w.supabase, ROUTE)).toBe(0);
    expect(eventUpdates(w.ops)).toEqual([]);
    expect(w.graphSends).toEqual([]);
  });

  it("an event whose passes keep dying is given up after the usual attempts", async () => {
    const w = catchUpWorld({
      ageMs: 4 * 60_000,
      lease: new Date(Date.now() - 1000).toISOString(),
      error: `retry:${WEBHOOK_MAX_ATTEMPTS - 1} catch-up pass never finished`,
    });
    expect(await reprocessUnprocessedEvents(w.supabase, ROUTE)).toBe(0);
    expect(w.graphSends).toEqual([]);
    expect(w.event.processed_at).toBeTruthy();
    expect(w.event.error).toBe(`gave_up:${WEBHOOK_MAX_ATTEMPTS} catch-up pass never finished`);
  });

  it("before the migration (no lease_until): claimed with processed_at, as before — still never at 90 s", async () => {
    const young = catchUpWorld({ ageMs: 90_000, noLeaseColumn: true });
    expect(await reprocessUnprocessedEvents(young.supabase, ROUTE)).toBe(0);
    expect(eventUpdates(young.ops)).toEqual([]);

    const w = catchUpWorld({ ageMs: 4 * 60_000, noLeaseColumn: true });
    expect(await reprocessUnprocessedEvents(w.supabase, ROUTE)).toBe(1);
    const updates = eventUpdates(w.ops);
    expect(updates[0]).toHaveProperty("processed_at");
    expect(updates.some((u) => "lease_until" in u)).toBe(false);
    expect(w.graphSends).toHaveLength(1);
  });

  it("status-only events keep their 60 s, and a just-connected number (olderThanSeconds 0) still takes everything", async () => {
    const status = {
      entry: [{ id: "waba", changes: [{ field: "messages", value: { metadata: { phone_number_id: "pn" }, statuses: [] } }] }],
    };
    const w = catchUpWorld({ ageMs: 90_000 });
    w.event.payload = status as never;
    expect(await reprocessUnprocessedEvents(w.supabase, ROUTE)).toBe(1);

    const now = catchUpWorld({ ageMs: 5_000 });
    expect(await reprocessUnprocessedEvents(now.supabase, { olderThanSeconds: 0 })).toBe(1);
  });

  it("migration: idempotent, a nullable column, lock timeout set and reset", () => {
    const sql = readFileSync(new URL("../../supabase/aidwar-migrations/20261070_batch27_webhook_lease.sql", import.meta.url), "utf8");
    expect(sql).toContain("ALTER TABLE public.webhook_events ADD COLUMN IF NOT EXISTS lease_until timestamptz;");
    expect(sql).toMatch(/SET lock_timeout = '5s';[\s\S]*RESET lock_timeout;/);
    expect(sql).not.toMatch(/lease_until timestamptz (NOT NULL|DEFAULT)/);
  });
});

// ------------------------------------------------------------------ Aiden

/** A workspace where Aiden replies and nobody owns the chat (unless told). */
function aidenWebhookWorld(opts: { conversation?: Record<string, unknown>; failFirstGate?: boolean }) {
  let gateReads = 0;
  const w = latencyWorld({
    org: `o27a-${Math.random()}`,
    rttMs: 0,
    graphMs: 0,
    waitingRun: false,
    override: (op) => {
      if (op.table === "feature_flags")
        return { data: [{ key: "flows_v2", default_enabled: true }, { key: "ai_features", default_enabled: true }], error: null };
      if (op.table === "ai_agents") return { data: { id: "agent-1", mode: "replying" }, error: null };
      if (op.table === "conversations" && op.kind === "select") {
        const columns = String(op.select?.[0] ?? "");
        if (columns.startsWith("assigned_to, needs_human")) {
          gateReads += 1;
          if (opts.failFirstGate && gateReads === 1) throw new Error("gate read cut off");
        }
        return {
          data: {
            id: "cv1",
            contact_id: "c1",
            unread_count: 0,
            assigned_to: null,
            needs_human: false,
            last_customer_message_at: new Date().toISOString(),
            whatsapp_account_id: `acc`,
            contacts: { phone: "+919800000001" },
            ...opts.conversation,
          },
          error: null,
        };
      }
      return undefined;
    },
  });
  const urls: string[] = [];
  const fetch = async (url: string | URL, init?: RequestInit) => {
    urls.push(String(url));
    return w.fetchStub(url, init);
  };
  vi.stubGlobal("fetch", fetch);
  return { ...w, urls };
}

const IMAGE = { id: "wamid.img", type: "image", image: { id: "media-27", mime_type: "image/jpeg" } };
const texts = (sends: Array<{ body: Record<string, unknown> }>) =>
  sends.filter((s) => s.body["type"] === "text").map((s) => String((s.body["text"] as Record<string, unknown>)["body"]));

describe("M7: a chat a person owns is theirs — no transcription, no automatic fallback", () => {
  for (const [label, conversation] of [
    ["assigned to a teammate", { assigned_to: "user-1" }],
    ["waiting for a person", { needs_human: true }],
  ] as const) {
    it(`${label}: the picture is never fetched or read, and nothing is sent`, async () => {
      const w = aidenWebhookWorld({ conversation });
      await processWebhookPayload(w.supabase, "ev-m7", inboundPayload(IMAGE), new Date().toISOString(), { storeMs: 1 });
      expect(w.urls.some((u) => u.includes("media-27"))).toBe(false);
      expect(texts(w.graphSends)).toEqual([]);
    });
  }

  it("unchanged: a chat Aiden is on still has its picture read", async () => {
    const w = aidenWebhookWorld({});
    await processWebhookPayload(w.supabase, "ev-m7b", inboundPayload(IMAGE), new Date().toISOString(), { storeMs: 1 });
    expect(w.urls.some((u) => u.includes("media-27"))).toBe(true);
  });
});

describe("H2: a throw while Aiden answers hands the chat to a person", () => {
  it("needs_human (ai_error), the workspace's hand-over line, the question filed — and the message still recorded answered", async () => {
    const w = aidenWebhookWorld({ failFirstGate: true });
    await processWebhookPayload(
      w.supabase,
      "ev-h2",
      inboundPayload({ id: "wamid.q", type: "text", text: { body: "do you have silver anklets?" } }),
      new Date().toISOString(),
      { storeMs: 1 },
    );
    const handOff = w.ops.find(
      (o) => o.table === "conversations" && o.kind === "update" && (o.payload as Record<string, unknown>)["needs_human"] === true,
    );
    expect(handOff?.payload).toMatchObject({ needs_human: true, needs_human_reason: "ai_error", needs_human_question: "do you have silver anklets?" });
    // The configured default hand-over line (scripts handover_default), never words written here.
    const { SCRIPTS } = await import("./scripts");
    expect(texts(w.graphSends)).toEqual([SCRIPTS.handover_default.text]);
    expect(w.ops.some((o) => o.table === "pending_owner_replies" && o.kind === "insert")).toBe(true);
    expect(w.ops.some((o) => o.table === "messages" && o.kind === "update" && "answered_at" in (o.payload as object))).toBe(true);
  });
});

describe("Low: a status that arrives before its message's row is kept for the retry", () => {
  const statusPayload = (secondsAgo: number) => ({
    entry: [
      {
        id: "waba",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "pn" },
              statuses: [{ id: "wamid.aiden", status: "delivered", timestamp: String(Math.floor(Date.now() / 1000) - secondsAgo) }],
            },
          },
        ],
      },
    ],
  });
  const close = (w: ReturnType<typeof latencyWorld>) => eventUpdates(w.ops).at(-1)!;

  it("a recent status for a message we have no row for: the event stays open (retry), not dropped", async () => {
    const w = latencyWorld({ org: "o27s", rttMs: 0, graphMs: 0, waitingRun: false });
    await processWebhookPayload(w.supabase, "ev-st", statusPayload(5));
    expect(close(w)["processed_at"]).toBeNull();
    expect(String(close(w)["error"])).toMatch(/^retry:1 .*wamid\.aiden: message not written yet/);
  });

  it("an old one is a message we never sent: closed as before", async () => {
    const w = latencyWorld({ org: "o27s2", rttMs: 0, graphMs: 0, waitingRun: false });
    await processWebhookPayload(w.supabase, "ev-st2", statusPayload(STATUS_ROW_WAIT_MS / 1000 + 60));
    expect(close(w)["processed_at"]).toBeTruthy();
    expect(close(w)["error"]).toBeNull();
  });

  it("a message already at that status (row there): closed as before", async () => {
    const w = latencyWorld({
      org: "o27s3",
      rttMs: 0,
      graphMs: 0,
      waitingRun: false,
      override: (op) =>
        op.table === "messages" && op.kind === "select"
          ? { data: { id: "m-out", status: "read", cost_amount: 1, campaign_id: null, flow_id: null, created_at: new Date().toISOString() }, error: null }
          : undefined,
    });
    await processWebhookPayload(w.supabase, "ev-st3", statusPayload(5));
    expect(close(w)["processed_at"]).toBeTruthy();
  });
});

describe("M12: every template status Meta sends is applied", () => {
  const templateEvent = (event: string) => ({
    entry: [
      {
        id: "waba-27",
        changes: [
          {
            field: "message_template_status_update",
            value: { event, message_template_id: 777, message_template_name: "festive_offer", message_template_language: "en_US" },
          },
        ],
      },
    ],
  });
  const applied = async (event: string) => {
    const w = latencyWorld({
      org: "o27t",
      rttMs: 0,
      graphMs: 0,
      waitingRun: false,
      override: (op) => (op.table === "whatsapp_accounts" ? { data: [{ organization_id: "o27t" }], error: null } : undefined),
    });
    await processWebhookPayload(w.supabase, `ev-${event}`, templateEvent(event));
    return w.ops.filter((o) => o.table === "message_templates" && o.kind === "update").map((o) => (o.payload as Record<string, unknown>)["status"]);
  };

  it("DISABLED and DELETED stop the template (PAUSED); REINSTATED makes it sendable again", async () => {
    expect(await applied("DISABLED")).toEqual(["PAUSED"]);
    expect(await applied("DELETED")).toEqual(["PAUSED"]);
    expect(await applied("REINSTATED")).toEqual(["APPROVED"]);
  });

  it("unchanged: APPROVED, REJECTED, FLAGGED, PENDING_DELETION; an unknown event changes nothing", async () => {
    expect(await applied("APPROVED")).toEqual(["APPROVED"]);
    expect(await applied("REJECTED")).toEqual(["REJECTED"]);
    expect(await applied("FLAGGED")).toEqual(["PAUSED"]);
    expect(await applied("PENDING_DELETION")).toEqual(["PAUSED"]);
    expect(await applied("SOMETHING_NEW")).toEqual([]);
  });
});
