import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { world } from "./test-support/campaign-world";
import { resetDispatchCaches } from "./campaign-dispatch.server";
import type { MemoryDb } from "./test-support/campaign-memory-db";

/**
 * (C) The campaign worker re-checks opt-out right before each send.
 * Batch 12: the worker claims a handful of recipients at a time and reads
 * their opt-out in one go just before they are sent; the rule is unchanged.
 */
const h = vi.hoisted(() => ({ db: null as null | MemoryDb }));
vi.mock("@/lib/whatsapp-webhook.server", () => ({
  getServiceClient: () => h.db!.client,
  waitUntilOf: () => null,
}));

import { Route } from "../routes/api/internal/campaign-worker";

type Post = (a: { request: Request }) => Promise<Response>;
const post = (Route.options as unknown as { server: { handlers: { POST: Post } } }).server.handlers
  .POST;

let graph: Array<Record<string, unknown>> = [];
beforeEach(() => {
  resetDispatchCaches();
  graph = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    if (!String(url).startsWith("https://graph.facebook.com/"))
      throw new Error(`unexpected fetch ${String(url)}`);
    graph.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.${graph.length}` }] }));
  });
});
afterEach(() => vi.unstubAllGlobals());

async function run(setup: (w: ReturnType<typeof world>) => void) {
  const w = world({ campaigns: [{ recipients: 2 }] });
  setup(w);
  h.db = w.db;
  process.env["CRON_SECRET"] = "s";
  const res = await post({
    request: new Request("http://x", { method: "POST", headers: { "x-cron-secret": "s" } }),
  });
  expect(res.status).toBe(200);
  const c = w.campaigns[0]!;
  return {
    ...w,
    recipients: w.db.rows("campaign_recipients").filter((r) => r["campaign_id"] === c.id),
    campaign: w.db.rows("campaigns").find((r) => r["id"] === c.id)!,
  };
}

describe("(C) campaign worker re-checks opt-out right before each send", () => {
  it("an opted-out recipient is skipped and never sent; the rest still go", async () => {
    const w = await run(({ db, campaigns }) => {
      const out = campaigns[0]!.recipients[0]!["contact_id"];
      db.rows("contacts").find((c) => c["id"] === out)!["opt_in_status"] = "opted_out";
    });
    expect(graph).toHaveLength(1);
    expect(graph[0]!["to"]).toBe(String(w.recipients[1]!["phone"]).replace("+", ""));
    expect(w.recipients.map((r) => [r["status"], r["error"]])).toEqual([
      ["skipped", "opted_out"],
      ["sent", null],
    ]);
    expect(w.campaign).toMatchObject({ sent_count: 1, failed_count: 0 });
  });

  it("a failed opt-out check sends nothing to that recipient", async () => {
    const w = await run(({ db }) => {
      db.hook = (call) =>
        call.table === "contacts" ? { data: null, error: { message: "down" } } : undefined;
    });
    expect(graph).toHaveLength(0);
    expect(w.recipients.map((r) => [r["status"], r["error"]])).toEqual([
      ["failed", "opt_out_check_failed"],
      ["failed", "opt_out_check_failed"],
    ]);
    expect(w.campaign).toMatchObject({ sent_count: 0, failed_count: 2 });
  });

  it("unchanged: recipients who haven't opted out are all sent", async () => {
    const w = await run(({ db }) => {
      for (const c of db.rows("contacts")) c["opt_in_status"] = "unknown";
    });
    expect(graph).toHaveLength(2);
    expect(w.recipients.map((r) => r["status"])).toEqual(["sent", "sent"]);
  });
});
