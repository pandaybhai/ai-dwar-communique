import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type MemoryDb } from "./test-support/memory-db";

/**
 * Batch 19 item 3 — the knowledge worker never runs the suggested-behaviour
 * AI call or the onboarding nudges past its own deadline. Out of time, the
 * suggestion is deferred (persona_pending) and made first on the next tick;
 * the nudges simply wait for the next tick.
 */

const MOCKED = [
  "@/lib/whatsapp-webhook.server",
  "@/lib/knowledge.server",
  "@/lib/merchant-channel.server",
  "@/lib/persona.server",
  "@/lib/onboarding-nudges.server",
];

const h = {
  db: null as MemoryDb | null,
  readTakesMs: 0,
  personaCalls: [] as string[],
  nudgeCalls: 0,
  jump: (_ms: number) => {},
};

/** Date.now() moves on by `skip` ms whenever the test says time has passed. */
function clock() {
  const real = Date.now.bind(Date);
  let skip = 0;
  vi.spyOn(Date, "now").mockImplementation(() => real() + skip);
  h.jump = (ms) => (skip += ms);
}

beforeEach(() => {
  Object.assign(h, { readTakesMs: 0, personaCalls: [], nudgeCalls: 0 });
  vi.resetModules();
  vi.stubEnv("CRON_SECRET", "cron");
  clock();
  vi.doMock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.db!.supabase }));
  vi.doMock("@/lib/knowledge.server", () => ({
    resetStaleReads: async () => 0,
    retryPendingEmbeddings: async () => ({ tried: 0, built: 0 }),
    syncSource: async (supabase: MemoryDb["supabase"], id: string) => {
      h.jump(h.readTakesMs);
      await supabase.from("knowledge_sources").update({ status: "ready" }).eq("id", id);
      return { ok: true, itemCount: 3 };
    },
  }));
  vi.doMock("@/lib/merchant-channel.server", () => ({ finishOnboardingCrawl: async () => {} }));
  vi.doMock("@/lib/persona.server", () => ({
    suggestPersonaAfterRead: async (_s: unknown, id: string) => {
      h.personaCalls.push(id);
    },
  }));
  vi.doMock("@/lib/onboarding-nudges.server", () => ({
    runOnboardingNudges: async () => {
      h.nudgeCalls += 1;
      return { expired: 0, nudged: 1, code_nudged: 0, skipped: null };
    },
  }));
});
afterEach(() => {
  for (const m of MOCKED) vi.doUnmock(m);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

function world() {
  h.db = memoryDb({
    knowledge_sources: [
      { id: "src-1", organization_id: "org-1", type: "website", status: "pending", queued_at: "2026-10-07T08:00:00Z", sync_started_at: null, config: { url: "https://shop.example/" } },
    ],
  });
  return h.db;
}

async function tick() {
  const { Route } = await import("../routes/api/internal/knowledge-worker");
  const post = (Route.options as unknown as { server: { handlers: { POST: (a: { request: Request }) => Promise<Response> } } }).server.handlers.POST;
  const res = await post({ request: new Request("http://x/api/internal/knowledge-worker", { method: "POST", headers: { "x-cron-secret": "cron" } }) });
  return (await res.json()) as Record<string, unknown>;
}
const cfg = (db: MemoryDb) => db.rows("knowledge_sources")[0]!["config"] as Record<string, unknown>;

describe("3. knowledge worker deadline", () => {
  it("healthy: a quick read gets its suggestion and the nudges run, exactly as before", async () => {
    const db = world();
    h.readTakesMs = 10_000;
    const out = await tick();
    expect(out).toMatchObject({ claimed: 1, done: 1, failed: 0, nudges: { nudged: 1, skipped: null } });
    expect(out).not.toHaveProperty("persona_deferred");
    expect(h.personaCalls).toEqual(["src-1"]);
    expect(h.nudgeCalls).toBe(1);
    expect(cfg(db)).toEqual({ url: "https://shop.example/" });
  });

  it("a read that used the tick: no AI call and no nudges after the deadline; both happen on the next tick", async () => {
    const db = world();
    h.readTakesMs = 88_000;
    const first = await tick();
    expect(first).toMatchObject({ claimed: 1, done: 1, persona_deferred: 1, nudges: { nudged: 0, skipped: "deadline" } });
    expect(h.personaCalls).toEqual([]);
    expect(h.nudgeCalls).toBe(0);
    expect(cfg(db)).toEqual({ url: "https://shop.example/", persona_pending: true });

    // Next minute: nothing queued; the deferred suggestion is made first, once.
    h.readTakesMs = 0;
    const second = await tick();
    expect(second).toMatchObject({ claimed: 0, persona_caught_up: 1, nudges: { nudged: 1 } });
    expect(h.personaCalls).toEqual(["src-1"]);
    expect(h.nudgeCalls).toBe(1);
    expect(cfg(db)).toEqual({ url: "https://shop.example/" });

    const third = await tick();
    expect(third).not.toHaveProperty("persona_caught_up");
    expect(h.personaCalls).toEqual(["src-1"]);
  });

  it("a deferred suggestion waits while its source is being read again", async () => {
    const db = world();
    const row = db.rows("knowledge_sources")[0]!;
    Object.assign(row, { status: "syncing", queued_at: null, sync_started_at: new Date().toISOString(), config: { url: "https://shop.example/", persona_pending: true } });
    const out = await tick();
    expect(out).not.toHaveProperty("persona_caught_up");
    expect(h.personaCalls).toEqual([]);
    expect(cfg(db)["persona_pending"]).toBe(true);
  });
});
