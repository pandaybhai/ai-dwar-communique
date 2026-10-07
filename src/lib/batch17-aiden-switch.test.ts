import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";

/**
 * Batch 17 (6): one Aiden switch. ai_agents.mode decides whether Aiden
 * replies; every save keeps organization_ai_settings.ai_enabled equal to it.
 */

const h = vi.hoisted(() => ({ db: null as null | { supabase: unknown } }));
vi.mock("@/lib/ai-tools.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai-tools.server")>()),
  enabledFlags: async () => new Set(["ai_features"]),
}));
vi.mock("@/lib/whatsapp-api.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp-api.server")>()),
  requireOrgMember: async () => ({ supabase: h.db!.supabase, organizationId: "org", userId: "u1", role: "owner" }),
  requirePermission: async () => null,
  logServerActivity: async () => {},
}));

import { prepareAgentInbound, syncAiSwitch } from "./ai-agent.server";
import { Route as EmployeeRoute } from "../routes/api/ai/employee";

type Post = (ctx: { request: Request }) => Promise<Response>;
const post = (EmployeeRoute.options as unknown as { server: { handlers: { POST: Post } } }).server.handlers.POST;
const call = (body: Record<string, unknown>) =>
  post({ request: new Request("http://x/api/ai/employee", { method: "POST", body: JSON.stringify({ organization_id: "org", ...body }) }) });

afterEach(() => vi.restoreAllMocks());

function world(mode: string, aiEnabled: boolean | null) {
  return fakeDb((op) => {
    if (op.table === "ai_agents" && op.kind === "select") return { data: { id: "agent-1", name: "Aiden", avatar: null, mode }, error: null };
    if (op.table === "organization_ai_settings" && op.kind === "select")
      return { data: aiEnabled === null ? null : { ai_enabled: aiEnabled }, error: null };
    // The "tested in the last 7 days" read before replying.
    if (op.table === "ai_runs") return { data: [{ id: "run" }], error: null };
    return undefined;
  });
}
const settingsWrites = (ops: FakeOp[]) =>
  ops.filter((o) => o.table === "organization_ai_settings" && (o.kind === "upsert" || o.kind === "update")).map((o) => o.payload);

describe("(6) mode decides whether Aiden replies", () => {
  it("mode replying: replies whatever ai_enabled says (the answer's reads start)", async () => {
    for (const enabled of [true, null]) {
      const prep = await prepareAgentInbound(world("replying", enabled).supabase, "org");
      expect(prep.prelude).not.toBeNull();
    }
  });

  it("mode off with ai_enabled = true (live: Ai Dwar, Kaira): Aiden doesn't reply", async () => {
    const prep = await prepareAgentInbound(world("off", true).supabase, "org");
    expect(prep.prelude).toBeNull();
  });
});

describe("(6) every save keeps ai_enabled equal to the mode", () => {
  it("syncAiSwitch: on unless mode is off", async () => {
    for (const [mode, enabled] of [["off", false], ["draft", true], ["replying", true]] as const) {
      const db = world(mode, null);
      await syncAiSwitch(db.supabase, "org", mode);
      expect(settingsWrites(db.ops)).toEqual([{ organization_id: "org", ai_enabled: enabled }]);
    }
  });

  it("set_mode replying turns ai_enabled on; set_mode off turns it off", async () => {
    h.db = world("off", false);
    expect((await call({ action: "set_mode", mode: "replying" })).status).toBe(200);
    expect(settingsWrites((h.db as ReturnType<typeof fakeDb>).ops)).toEqual([{ organization_id: "org", ai_enabled: true }]);
    h.db = world("replying", true);
    expect((await call({ action: "set_mode", mode: "off" })).status).toBe(200);
    expect(settingsWrites((h.db as ReturnType<typeof fakeDb>).ops)).toEqual([{ organization_id: "org", ai_enabled: false }]);
  });

  it("a refused mode change (billing guard) leaves ai_enabled alone", async () => {
    const db = fakeDb((op) => {
      if (op.table === "ai_agents" && op.kind === "select") return { data: { id: "agent-1", mode: "off" }, error: null };
      if (op.table === "ai_agents" && op.kind === "update") return { data: null, error: { message: "AI_GUARD: Add credits first." } };
      if (op.table === "ai_runs") return { data: [{ id: "run" }], error: null };
      return undefined;
    });
    h.db = db;
    expect((await call({ action: "set_mode", mode: "replying" })).status).toBe(402);
    expect(settingsWrites(db.ops)).toEqual([]);
  });

  it("switching AI off switches Aiden off too; switching it on leaves the mode (allowed to test)", async () => {
    const off = world("replying", true);
    h.db = off;
    await call({ action: "save_settings", ai_enabled: false });
    const agentUpdate = off.ops.find((o) => o.table === "ai_agents" && o.kind === "update")!;
    expect(agentUpdate.payload).toEqual({ mode: "off" });
    expect(off.has(agentUpdate, "eq", "id", "agent-1")).toBe(true);

    const on = world("off", false);
    h.db = on;
    await call({ action: "save_settings", ai_enabled: true });
    expect(on.ops.some((o) => o.table === "ai_agents" && o.kind === "update")).toBe(false);
  });

  it("the owner's WhatsApp 'turn Aiden on' syncs ai_enabled too", () => {
    const src = readFileSync(new URL("./merchant-channel.server.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("async function switchAgentOn"), src.indexOf("async function switchAgentOn") + 900);
    expect(fn).toMatch(/syncAiSwitch\(supabase, organizationId, "replying"\)/);
  });
});

describe("(6) migration: reports mismatches, changes nothing", () => {
  const sql = readFileSync(new URL("../../supabase/aidwar-migrations/20261034_batch17_ai_switch_report.sql", import.meta.url), "utf8");
  it("read-only: a RAISE NOTICE per mismatch, no write", () => {
    expect(sql).toMatch(/RAISE NOTICE 'ai switch mismatch:/);
    expect(sql).toMatch(/IS DISTINCT FROM \(COALESCE\(a\.mode, 'off'\) <> 'off'\)/);
    expect(sql).not.toMatch(/^\s*(UPDATE|INSERT|DELETE|ALTER|DROP|CREATE)\b/im);
  });
});
