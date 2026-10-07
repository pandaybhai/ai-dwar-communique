import { describe, expect, it, vi } from "vitest";
import { memoryDb } from "./test-support/memory-db";

/**
 * Batch 19 item 6 — "Read the whole site" after a plan purchase never
 * re-queues a website that is being read right now (two crawls of the same
 * site, paid-reader pages spent twice). Every other website is queued in
 * full mode exactly as before.
 */

const notified: string[] = [];
vi.mock("@/lib/merchant-channel.server", () => ({
  notifyOwnerOnOnboardingChannel: async (_s: unknown, _o: string, body: string) => {
    notified.push(body);
    return true;
  },
}));

import { activatePlanFromPayment } from "./plan-purchase.server";

describe("6. plan purchase full read", () => {
  it("queues the idle website in full mode and leaves the one being read alone", async () => {
    const startedAt = new Date(Date.now() - 30_000).toISOString();
    const db = memoryDb({
      organizations: [{ id: "org-1", plan_status: "trial", plan_version_id: null }],
      knowledge_sources: [
        { id: "idle", organization_id: "org-1", type: "website", name: "shop.example", status: "ready", sync_started_at: startedAt, queued_at: null, config: { url: "https://shop.example/", mode: "day0" } },
        { id: "busy", organization_id: "org-1", type: "website", name: "blog.example", status: "syncing", sync_started_at: startedAt, queued_at: null, config: { url: "https://blog.example/", mode: "day0", pages_done: 4 } },
        { id: "gone", organization_id: "org-1", type: "website", name: "old.example", status: "disabled", sync_started_at: null, queued_at: null, config: { url: "https://old.example/" } },
      ],
    });
    const ok = await activatePlanFromPayment(db.supabase, { id: "pay-1", organization_id: "org-1", raw: { plan_version_id: "pv-1", plan_key: "growth" } });
    expect(ok).toBe(true);
    const row = (id: string) => db.rows("knowledge_sources").find((r) => r["id"] === id)!;

    expect(row("idle")).toMatchObject({ status: "pending", sync_started_at: null, last_error: null });
    expect(row("idle")["config"]).toEqual({ url: "https://shop.example/", mode: "full", resume: false, pages_done: 0 });
    expect(typeof row("idle")["queued_at"]).toBe("string");

    // Still the one read in flight: no second claim possible, nothing reset.
    expect(row("busy")).toMatchObject({ status: "syncing", sync_started_at: startedAt, queued_at: null });
    expect(row("busy")["config"]).toEqual({ url: "https://blog.example/", mode: "day0", pages_done: 4 });

    expect(row("gone")["status"]).toBe("disabled");
    expect(notified).toHaveLength(1);
  });
});
