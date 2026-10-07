import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type MemoryDb } from "./test-support/memory-db";

/**
 * Batch 19 item 4 — the scheduled re-read (knowledge-refresh) starts no
 * inline read after its deadline; what's left is still due and goes first
 * on the next run. Websites are only queued, as before.
 */

const MOCKED = ["@/lib/whatsapp-webhook.server", "@/lib/knowledge.server", "@/lib/reading.server"];
const h = { db: null as MemoryDb | null, synced: [] as string[], jump: (_ms: number) => {} };

beforeEach(() => {
  h.synced = [];
  vi.resetModules();
  vi.stubEnv("CRON_SECRET", "cron");
  const real = Date.now.bind(Date);
  let skip = 0;
  vi.spyOn(Date, "now").mockImplementation(() => real() + skip);
  h.jump = (ms) => (skip += ms);
  vi.doMock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.db!.supabase }));
  vi.doMock("@/lib/reading.server", () => ({
    loadKnowledgeAutoRefresh: async () => true,
    loadReadingSettings: async () => ({ refresh_days: 7 }),
  }));
  vi.doMock("@/lib/knowledge.server", () => ({
    planLimits: async () => ({ paid: true }),
    syncSource: async (_s: unknown, id: string) => {
      h.synced.push(id);
      h.jump(25_000);
      return { ok: true, itemCount: 1 };
    },
  }));
});
afterEach(() => {
  for (const m of MOCKED) vi.doUnmock(m);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function run() {
  const { Route } = await import("../routes/api/internal/knowledge-refresh");
  const post = (Route.options as unknown as { server: { handlers: { POST: (a: { request: Request }) => Promise<Response> } } }).server.handlers.POST;
  const res = await post({ request: new Request("http://x/api/internal/knowledge-refresh", { method: "POST", headers: { "x-cron-secret": "cron" } }) });
  return (await res.json()) as Record<string, unknown>;
}

describe("4. knowledge-refresh deadline", () => {
  it("starts no inline read after ~60 s; the rest stay due for the next run; websites are still queued", async () => {
    const old = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
    h.db = memoryDb({
      knowledge_sources: [
        ...[1, 2, 3, 4, 5].map((n) => ({ id: `qa-${n}`, organization_id: "org-1", type: "manual_qa", refresh_days: 1, last_synced_at: old(10 - n), status: "ready", config: {} })),
        { id: "web", organization_id: "org-1", type: "website", refresh_days: null, last_synced_at: old(30), status: "ready", config: { url: "https://shop.example/" } },
      ],
    });
    const out = await run();
    // 0 s, 25 s, 50 s start; at 75 s the deadline has passed.
    expect(h.synced).toEqual(["qa-1", "qa-2", "qa-3"]);
    expect(out).toMatchObject({ due: 6, refreshed: 3, queued: 1, deferred: 2 });
    expect(h.db.rows("knowledge_sources").find((r) => r["id"] === "web")).toMatchObject({ status: "pending" });
  });

  it("healthy: everything due is read and the answer has no deferred count", async () => {
    h.db = memoryDb({
      knowledge_sources: [{ id: "qa-1", organization_id: "org-1", type: "manual_qa", refresh_days: 1, last_synced_at: null, status: "ready", config: {} }],
    });
    const out = await run();
    expect(out).toMatchObject({ due: 1, refreshed: 1, failed: 0 });
    expect(out).not.toHaveProperty("deferred");
  });
});
