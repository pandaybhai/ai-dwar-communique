import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";
import { inboundPayload, latencyWorld } from "./test-support/latency-world";
import { inVirtualTime } from "./test-support/virtual-time";

/**
 * Batch 11 (small fixes):
 *  (1) /admin AI backup card: configured yes/no, models, "Test backup";
 *  (2) card usage alarm past 5,000 renders a month, once;
 *  (3) extend trial moves trial_ends_at only; Assign plan warns about
 *      features in use;
 *  (4) a trial workspace's first plan charge waits for the trial's end;
 *  (5) Show products lists matches cheapest first;
 *  (6) flow starts: timing marks, and the onboarding number's flow path
 *      uses the reads made while the message is stored;
 *  (7) no products from legal pages; the migration hides the 3 live rows;
 *  (8) old template sends show sample values or "...", never {{1}};
 *  (9) a published flow that is switched off says "Off".
 */

const h = vi.hoisted(() => ({
  db: null as null | { supabase: unknown },
  superAdmin: true,
}));
vi.mock("@/lib/whatsapp-webhook.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp-webhook.server")>()),
  getServiceClient: () => h.db!.supabase,
}));
vi.mock("@/lib/permissions.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/permissions.server")>()),
  hasPermission: async () => true,
}));
vi.mock("@/lib/whatsapp-api.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp-api.server")>()),
  isSuperAdmin: async () => h.superAdmin,
}));

import { backupFailureReason, backupStatus, testBackupProviders } from "./ai-fallback.server";
import { CARD_RENDER_ALERT_AT, checkCardUsageAlarm, resetCardUsageAlarm } from "./card-usage-alert.server";
import { drainBillingNotifications } from "./billing-notify.server";
import { extendTrial, planChangePreview } from "./billing.server";
import { firstChargeAt, getAutoPay, setupAutoPay } from "./subscriptions.server";
import { AI_TOOL_HANDLERS, sortByPrice } from "./ai-tools.server";
import { extractProduct, isLegalPage, looksLikeLegalClause } from "./product-extract.server";
import { fillTemplateText, templateBodyOf } from "../components/inbox/inbox-utils";
import { flowStatus } from "./flow-status";
import { processWebhookPayload } from "./whatsapp-webhook.server";
import { Route as AdminAiRoute } from "../routes/api/admin/ai";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_BACKUP_MODEL", "OPENAI_BACKUP_MODEL", "AI_BACKUP_ORDER", "BILLING_ADMIN_WHATSAPP", "PLATFORM_ORG_ID"];
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  h.superAdmin = true;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
  resetCardUsageAlarm();
});

// ------------------------------------------------------------------ (1)
describe("(1) AI backup card", () => {
  it("status says configured yes/no and the models — never a key", () => {
    const none = backupStatus({});
    expect(none.anthropic.configured).toBe(false);
    expect(none.openai.configured).toBe(false);
    // Batch 11B: the default Anthropic backup is Sonnet (was Opus) to keep cost down.
    expect(none.anthropic.model).toBe("claude-sonnet-5-5");
    expect(none.openai.model).toBe("gpt-5.4-mini");
    expect(none.openai.careful_model).toBe("gpt-5.4");
    const both = backupStatus({ ANTHROPIC_API_KEY: "sk-ant-secret", OPENAI_API_KEY: "sk-openai-secret", OPENAI_BACKUP_MODEL: "gpt-x" });
    expect(both.anthropic.configured).toBe(true);
    expect(both.openai).toEqual({ configured: true, model: "gpt-x", careful_model: "gpt-x", key_source: "env" });
    expect(JSON.stringify(both)).not.toContain("secret");
  });

  it("no backup key: nothing is called", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await testBackupProviders({})).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("one tiny prompt per configured model; 'answered in X s' or the provider's exact error", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url instanceof Request ? url.url : url);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url: u, body });
      if (u.includes("anthropic.com")) {
        return json({ id: "msg_1", type: "message", role: "assistant", model: body["model"], content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 1 } });
      }
      if (body["model"] === "gpt-5.4") return json({ error: { message: "The model `gpt-5.4` does not exist or you do not have access to it.", type: "invalid_request_error", code: "model_not_found" } }, 404);
      return json({ error: { message: "Incorrect API key provided: sk-...abc.", type: "invalid_request_error", code: "invalid_api_key" } }, 401);
    });
    const results = await testBackupProviders({ ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oa" });
    expect(results.map((r) => `${r.provider}:${r.model}`)).toEqual(["anthropic:claude-sonnet-5-5", "openai:gpt-5.4-mini", "openai:gpt-5.4"]);
    expect(results[0]).toMatchObject({ ok: true, reason: null, error: null });
    expect(typeof results[0]!.seconds).toBe("number");
    expect(results[1]).toMatchObject({ ok: false, reason: "bad_key", error: "invalid_api_key: Incorrect API key provided: sk-...abc." });
    expect(results[2]).toMatchObject({ ok: false, reason: "wrong_model" });
    expect(results[2]!.error).toContain("does not exist");
    // Tiny: a one-line prompt and a small cap.
    const anthropic = calls.find((c) => c.url.includes("anthropic.com"))!;
    expect(anthropic.body["max_tokens"]).toBe(256);
    expect(calls.filter((c) => c.url.includes("openai.com")).every((c) => c.body["max_output_tokens"] === 64)).toBe(true);
  });

  it("Anthropic's own errors: no credit, wrong model, bad key", async () => {
    let reply: Response = json({});
    vi.stubGlobal("fetch", async () => reply.clone());
    reply = json({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }, 400);
    expect((await testBackupProviders({ ANTHROPIC_API_KEY: "k" }))[0]).toMatchObject({ ok: false, reason: "no_credit" });
    reply = json({ type: "error", error: { type: "not_found_error", message: "model: claude-nope" } }, 404);
    expect((await testBackupProviders({ ANTHROPIC_API_KEY: "k", ANTHROPIC_BACKUP_MODEL: "claude-nope" }))[0]).toMatchObject({ ok: false, reason: "wrong_model", model: "claude-nope" });
    reply = json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401);
    const bad = (await testBackupProviders({ ANTHROPIC_API_KEY: "k" }))[0]!;
    expect(bad).toMatchObject({ ok: false, reason: "bad_key" });
    expect(bad.error).toContain("invalid x-api-key");
  });

  it("failure words from status + text", () => {
    expect(backupFailureReason(429, '{"error":{"code":"insufficient_quota"}}')).toBe("no_credit");
    expect(backupFailureReason(429, "slow down")).toBe("rate_limited");
    expect(backupFailureReason(402, "")).toBe("no_credit");
    expect(backupFailureReason(null, "")).toBe("unreachable");
    expect(backupFailureReason(500, "boom")).toBe("other");
  });

  describe("the /api/admin/ai actions", () => {
    type Post = (ctx: { request: Request }) => Promise<Response>;
    const post = (AdminAiRoute.options as unknown as { server: { handlers: { POST: Post } } }).server.handlers.POST;
    const call = (body: Record<string, unknown>) =>
      post({ request: new Request("http://x/api/admin/ai", { method: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify(body) }) });
    const world = () => {
      const db = fakeDb(() => undefined);
      Object.assign(db.supabase, { auth: { getUser: async () => ({ data: { user: { id: "admin-1" } } }) } });
      h.db = db;
      return db;
    };

    it("super admins only", async () => {
      const db = world();
      h.superAdmin = false;
      process.env["ANTHROPIC_API_KEY"] = "sk-ant";
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const res = await call({ action: "backup_test" });
      expect(res.status).toBe(403);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(db.ops.some((o) => o.table === "activity_log")).toBe(false);
    });

    it("Test backup is logged to activity_log (results, never the key)", async () => {
      const db = world();
      process.env["ANTHROPIC_API_KEY"] = "sk-ant-very-secret";
      vi.stubGlobal("fetch", async () =>
        json({ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }),
      );
      const res = await call({ action: "backup_test" });
      const out = (await res.json()) as { results: Array<{ ok: boolean }>; backup: { anthropic: { configured: boolean } } };
      expect(out.results).toHaveLength(1);
      expect(out.results[0]!.ok).toBe(true);
      expect(out.backup.anthropic.configured).toBe(true);
      const log = db.ops.find((o) => o.table === "activity_log" && o.kind === "insert")!;
      expect((log.payload as { action: string; user_id: string }).action).toBe("ai_backup_tested");
      expect((log.payload as { user_id: string }).user_id).toBe("admin-1");
      expect(JSON.stringify(log.payload)).not.toContain("very-secret");
      expect(JSON.stringify(out)).not.toContain("very-secret");
    });
  });
});

// ------------------------------------------------------------------ (2)
describe("(2) card usage alarm", () => {
  const ORG = "org-cards";
  const world = (runs: number[], alreadyAlerted = false) =>
    fakeDb((op) => {
      if (op.table === "ai_usage") return { data: runs.map((r) => ({ runs: r })), error: null };
      if (op.table === "activity_log" && op.kind === "select") return { data: alreadyAlerted ? [{ id: "a" }] : [], error: null };
      if (op.table === "organizations") return { data: { name: "Sharma Textiles" }, error: null };
      return undefined;
    });

  it(`${CARD_RENDER_ALERT_AT.toLocaleString("en-IN")} renders or fewer: nothing`, async () => {
    const db = world([3000, 2000]);
    expect(await checkCardUsageAlarm(db.supabase, ORG)).toBe(false);
    expect(db.ops.some((o) => o.kind === "insert")).toBe(false);
  });

  it("past 5,000 this month: one activity row + one admin WhatsApp notice; never again that month", async () => {
    const db = world([3000, 2001]);
    expect(await checkCardUsageAlarm(db.supabase, ORG)).toBe(true);
    const usage = db.ops.find((o) => o.table === "ai_usage")!;
    expect(db.has(usage, "eq", "task", "card_render")).toBe(true);
    expect(db.has(usage, "gte", "usage_date", new Date().toISOString().slice(0, 8) + "01")).toBe(true);
    const activity = db.ops.filter((o) => o.table === "activity_log" && o.kind === "insert");
    const notice = db.ops.filter((o) => o.table === "billing_notifications" && o.kind === "insert");
    expect(activity).toHaveLength(1);
    expect(activity[0]!.payload).toMatchObject({ organization_id: ORG, action: "card_usage_alert", details: { renders: 5001, threshold: 5000 } });
    expect(notice).toHaveLength(1);
    expect(notice[0]!.payload).toMatchObject({ organization_id: ORG, audience: "admin", kind: "card_usage_alert", channel: "whatsapp" });
    // No charge anywhere.
    expect(db.ops.some((o) => ["wallet_ledger", "ai_runs"].includes(o.table))).toBe(false);
    // Later renders the same month: no second alert (and not even a re-count).
    const before = db.ops.length;
    expect(await checkCardUsageAlarm(db.supabase, ORG, new Date(Date.now() + 10 * 60_000))).toBe(false);
    expect(db.ops.length).toBe(before);
  });

  it("another server already raised it this month: nothing new", async () => {
    const db = world([6000], true);
    expect(await checkCardUsageAlarm(db.supabase, ORG)).toBe(false);
    expect(db.ops.some((o) => o.kind === "insert")).toBe(false);
  });

  it("the notice goes out on the approved admin_ai_provider_alert template", async () => {
    process.env["PLATFORM_ORG_ID"] = "plat";
    process.env["BILLING_ADMIN_WHATSAPP"] = "+919811111111";
    const db = fakeDb((op) => {
      // Batch 18: the drain claims the notice before sending it.
      if (op.table === "billing_notifications" && op.kind === "update" && !(op.payload as { status?: string }).status)
        return { data: [{ id: "n1" }], error: null };
      if (op.table === "billing_notifications" && op.kind === "select")
        return {
          data: [
            {
              id: "n1",
              organization_id: ORG,
              audience: "admin",
              kind: "card_usage_alert",
              channel: "whatsapp",
              recipient: null,
              status: "queued",
              payload: { headline: "Sharma Textiles has drawn 5,001 customer cards this month (over 5,000)", detail: "cards are not charged, so nothing was billed or stopped", link: "https://aidwar.in/admin/organizations" },
            },
          ],
          error: null,
        };
      if (op.table === "whatsapp_accounts")
        return { data: [{ id: "acc", organization_id: "plat", waba_id: "w", phone_number_id: "pn", display_phone_number: "91", status: "active", is_default: true }], error: null };
      if (op.table === "whatsapp_credentials") return { data: { access_token: "tok" }, error: null };
      if (op.table === "contacts") return { data: [], error: null };
      if (op.table === "organizations") return { data: { name: "Sharma Textiles" }, error: null };
      if (op.table === "message_templates") return { data: { name: "admin_ai_provider_alert", language: "en", status: "APPROVED" }, error: null };
      return undefined;
    });
    const sent: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return json({ messages: [{ id: "wamid.1" }] });
    });
    const counts = await drainBillingNotifications(db.supabase);
    expect(counts.sent).toBe(1);
    expect(sent[0]).toMatchObject({
      to: "+919811111111",
      template: {
        name: "admin_ai_provider_alert",
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "Sharma Textiles has drawn 5,001 customer cards this month (over 5,000)" },
              { type: "text", text: "cards are not charged, so nothing was billed or stopped" },
              { type: "text", text: "https://aidwar.in/admin/organizations" },
            ],
          },
        ],
      },
    });
  });
});

// ------------------------------------------------------------------ (3)
describe("(3) extend trial; Assign plan warns about features in use", () => {
  const ORG = "org-trial";
  const trialWorld = (org: Record<string, unknown> | null, updated: unknown[] = [{ id: ORG }]) =>
    fakeDb((op) => {
      if (op.table === "profiles") return { data: { is_super_admin: h.superAdmin }, error: null };
      if (op.table === "organizations" && op.kind === "select") return { data: org, error: null };
      if (op.table === "organizations" && op.kind === "update") return { data: updated, error: null };
      return undefined;
    });

  it("moves trial_ends_at only — no plan, feature, limit or mandate write — and logs it", async () => {
    const end = new Date(Date.now() + 3 * 864e5).toISOString();
    const db = trialWorld({ id: ORG, plan_status: "trial", trial_ends_at: end });
    const r = await extendTrial(db.supabase, { organizationId: ORG, days: 7, actorId: "admin" });
    expect("ok" in r && r.ok).toBe(true);
    const next = (r as { trial_ends_at: string }).trial_ends_at;
    expect(Date.parse(next) - Date.parse(end)).toBe(7 * 864e5);
    const writes = db.ops.filter((o) => o.kind !== "select");
    expect(writes.map((o) => o.table).sort()).toEqual(["activity_log", "organizations"]);
    const update = writes.find((o) => o.table === "organizations")!;
    expect(update.payload).toEqual({ trial_ends_at: next });
    // Only if nobody changed it meanwhile.
    expect(db.has(update, "eq", "trial_ends_at", end)).toBe(true);
    expect(db.has(update, "eq", "plan_status", "trial")).toBe(true);
    expect(writes.find((o) => o.table === "activity_log")!.payload).toMatchObject({ action: "trial_extended", details: { days: 7, previous_trial_ends_at: end, trial_ends_at: next } });
    expect(db.ops.some((o) => ["plan_versions", "organization_feature_overrides", "subscriptions", "organization_billing_settings"].includes(o.table))).toBe(false);
  });

  it("a trial that already ended counts from now", async () => {
    const db = trialWorld({ id: ORG, plan_status: "trial", trial_ends_at: new Date(Date.now() - 5 * 864e5).toISOString() });
    const at = Date.now();
    const r = (await extendTrial(db.supabase, { organizationId: ORG, days: 2, actorId: "admin" })) as { trial_ends_at: string };
    expect(Math.abs(Date.parse(r.trial_ends_at) - (at + 2 * 864e5))).toBeLessThan(5_000);
  });

  it("refuses: not a trial, a silly number of days, a change made meanwhile, a non-super-admin", async () => {
    expect(await extendTrial(trialWorld({ id: ORG, plan_status: "active", trial_ends_at: null }).supabase, { organizationId: ORG, days: 7, actorId: "a" })).toEqual({
      error: "This workspace isn't on a trial, so there's nothing to extend.",
    });
    expect(await extendTrial(trialWorld({ id: ORG, plan_status: "trial", trial_ends_at: null }).supabase, { organizationId: ORG, days: 0, actorId: "a" })).toEqual({ error: "Extend by 1 to 90 days." });
    const raced = trialWorld({ id: ORG, plan_status: "trial", trial_ends_at: null }, []);
    expect("error" in (await extendTrial(raced.supabase, { organizationId: ORG, days: 7, actorId: "a" }))).toBe(true);
    expect(raced.ops.some((o) => o.table === "activity_log")).toBe(false);
    h.superAdmin = false;
    await expect(extendTrial(trialWorld({ id: ORG, plan_status: "trial", trial_ends_at: null }).supabase, { organizationId: ORG, days: 7, actorId: "a" })).rejects.toThrow();
  });

  const previewWorld = (opts: { manual?: Record<string, boolean>; v2Live?: number; runs?: number; cardRenders?: number[] }) =>
    fakeDb((op) => {
      if (op.table === "profiles") return { data: { is_super_admin: h.superAdmin }, error: null };
      if (op.table === "plan_versions") return { data: [{ id: "v-basic", features: ["inbox", "contacts", "templates", "campaigns"], limits: {}, plans: { key: "basic", name: "Basic" } }], error: null };
      if (op.table === "organization_billing_settings") return { data: { organization_id: ORG, limits_override: { _manual_flags: opts.manual ?? {} } }, error: null };
      if (op.table === "organization_feature_overrides")
        return { data: [{ flag_key: "flows_v2", enabled: true }, { flag_key: "cards", enabled: true }, { flag_key: "flows", enabled: true }], error: null };
      if (op.table === "flows" && op.filters.some(([f, a]) => f === "like" && a[1] === "v2:%")) return { data: null, error: null, count: opts.v2Live ?? 0 };
      if (op.table === "flow_runs") return { data: null, error: null, count: opts.runs ?? 0 };
      if (op.table === "ai_usage") return { data: (opts.cardRenders ?? []).map((r) => ({ runs: r })), error: null };
      if (op.table === "organization_members" || op.table === "whatsapp_numbers") return { data: [], error: null };
      return { data: null, error: null, count: 0 };
    });

  it("features switching off that the workspace is using are listed, with what uses them", async () => {
    const db = previewWorld({ v2Live: 2, runs: 5, cardRenders: [40, 2] });
    const p = await planChangePreview(db.supabase, { organizationId: ORG, planKey: "basic", actorId: "admin" });
    if ("error" in p) throw new Error(p.error);
    expect(p.requires_confirmation).toBe(true);
    expect(p.in_use).toEqual([
      { key: "cards", name: "Cards", uses: [{ label: "cards sent in the last 30 days", count: 42 }] },
      { key: "flows_v2", name: expect.any(String), uses: [{ label: "chat flows switched on", count: 2 }, { label: "conversations in a chat flow", count: 5 }] },
    ]);
    // Read-only.
    expect(db.ops.some((o) => o.kind !== "select")).toBe(false);
  });

  it("a feature set by hand (_manual_flags) is kept, so it isn't in the warning", async () => {
    const db = previewWorld({ manual: { flows_v2: true }, v2Live: 2, cardRenders: [] });
    const p = await planChangePreview(db.supabase, { organizationId: ORG, planKey: "basic", actorId: "admin" });
    if ("error" in p) throw new Error(p.error);
    expect(p.in_use).toEqual([]);
    expect(p.features_off.some((f) => f.key === "flows_v2")).toBe(false);
  });

  it("the admin sheet's Extend trial calls only extend_trial (never assign_plan)", () => {
    const sheet = readFileSync("src/components/admin/org-billing-sheet.tsx", "utf8");
    const fn = sheet.slice(sheet.indexOf("async function extendTrial()"), sheet.indexOf("async function resyncFeatures()"));
    expect(fn).toContain('action: "extend_trial"');
    expect(fn).not.toContain("assign_plan");
    expect(fn).not.toContain("resync");
  });
});

// ------------------------------------------------------------------ (4)
describe("(4) first plan charge at the trial's end", () => {
  const ORG = "org-sub";
  const DAY = 864e5;

  it("firstChargeAt: trial with days left → its end; trial over → now; no trial → now", () => {
    const now = Date.parse("2026-10-06T00:00:00Z");
    expect(firstChargeAt({ plan_status: "trial", trial_ends_at: "2026-10-16T00:00:00Z" }, now)).toBe(Date.parse("2026-10-16T00:00:00Z") / 1000);
    expect(firstChargeAt({ plan_status: "trial", trial_ends_at: "2026-10-01T00:00:00Z" }, now)).toBeNull();
    expect(firstChargeAt({ plan_status: "trial", trial_ends_at: new Date(now + 60_000).toISOString() }, now)).toBeNull();
    expect(firstChargeAt({ plan_status: "active", trial_ends_at: null }, now)).toBeNull();
    expect(firstChargeAt({ plan_status: "active", trial_ends_at: "2026-10-16T00:00:00Z" }, now)).toBeNull();
    expect(firstChargeAt({ plan_status: "trial", trial_ends_at: null }, now)).toBeNull();
  });

  const subscribe = async (org: Record<string, unknown>) => {
    const db = fakeDb(
      (op) => {
        if (op.table === "organizations") return { data: { id: ORG, name: "Shop", billing_account_id: "ba", plan_version_id: "pv", ...org }, error: null };
        if (op.table === "plan_versions") return { data: { id: "pv", price_monthly: 999, price_annual: null, plans: { name: "Starter" } }, error: null };
        if (op.table === "subscriptions") return { data: null, error: null };
        if (op.table === "organization_members") return { data: { role: "owner" }, error: null };
        if (op.table === "profiles") return { data: { is_super_admin: true }, error: null };
        return undefined;
      },
      (rpc) => (rpc.name === "read_vault_secret" ? { data: "rzp_key", error: null } : undefined),
    );
    const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      bodies.push({ url: String(url), body });
      if (String(url).endsWith("/plans")) return json({ id: "plan_1" });
      return json({ id: "sub_1", short_url: "https://rzp.io/i/x", ...(body["start_at"] ? { start_at: body["start_at"] } : {}) });
    });
    const result = await setupAutoPay(db.supabase, { organizationId: ORG, userId: "u1", cycle: "monthly" });
    const sub = bodies.find((b) => b.url.endsWith("/subscriptions"));
    return { db, result, sub };
  };

  it("trial with days left: the subscription starts on the trial's end, and says so", async () => {
    const end = new Date(Date.now() + 9 * DAY);
    const { db, result, sub } = await subscribe({ plan_status: "trial", trial_ends_at: end.toISOString() });
    expect(result).toEqual({ url: "https://rzp.io/i/x" });
    expect(sub!.body["start_at"]).toBe(Math.floor(end.getTime() / 1000));
    const row = db.ops.find((o) => o.table === "subscriptions" && o.kind === "insert")!;
    expect((row.payload as { raw: Record<string, unknown> }).raw["start_at"]).toBe(Math.floor(end.getTime() / 1000));
    expect(db.ops.find((o) => o.table === "activity_log")!.payload).toMatchObject({ details: { first_charge_at: new Date(Math.floor(end.getTime() / 1000) * 1000).toISOString() } });
    // The status line: "Paid plan starts on <date>".
    const status = await getAutoPay(
      fakeDb(() => ({ data: { status: "authenticated", billing_cycle: "monthly", next_charge_at: end.toISOString(), raw: { start_at: Math.floor(end.getTime() / 1000) } }, error: null })).supabase,
      ORG,
    );
    expect(status.enabled).toBe(true);
    expect(Date.parse(status.starts_at!)).toBe(Math.floor(end.getTime() / 1000) * 1000);
    const panel = readFileSync("src/components/billing/invoices-panel.tsx", "utf8");
    expect(panel).toContain("Paid plan starts on {day(autopay.starts_at)}");
  });

  it("trial already over: charged on authorisation, as before (no start_at)", async () => {
    const { result, sub } = await subscribe({ plan_status: "trial", trial_ends_at: new Date(Date.now() - DAY).toISOString() });
    expect(result).toEqual({ url: "https://rzp.io/i/x" });
    expect("start_at" in sub!.body).toBe(false);
  });

  it("no trial: exactly as before (no start_at), and no 'starts on' line", async () => {
    const { db, sub } = await subscribe({ plan_status: "active", trial_ends_at: null });
    expect(Object.keys(sub!.body).sort()).toEqual(["customer_notify", "notes", "plan_id", "total_count"]);
    expect("start_at" in ((db.ops.find((o) => o.table === "subscriptions" && o.kind === "insert")!.payload as { raw: Record<string, unknown> }).raw)).toBe(false);
    const status = await getAutoPay(fakeDb(() => ({ data: { status: "active", billing_cycle: "monthly", raw: {} }, error: null })).supabase, ORG);
    expect(status.starts_at).toBeNull();
  });
});

// ------------------------------------------------------------------ (5)
describe("(5) Show products: cheapest first", () => {
  it("sortByPrice: cheapest first, no-price last, ties keep their order", () => {
    const rows = [
      { title: "A", price: 730 },
      { title: "B", price: 60 },
      { title: "C", price: null },
      { title: "D", price: 630 },
      { title: "E", price: 0 },
      { title: "F", price: 60 },
    ];
    expect(sortByPrice(rows).map((r) => r.title)).toEqual(["B", "F", "D", "A", "C", "E"]);
  });

  const search = async (args: Record<string, unknown>) => {
    const db = fakeDb((op) =>
      op.table === "products"
        ? {
            data: [
              { title: "The Collection Snowboard: Hydrogen", price: 600, image_url: "https://x/1.png", availability: "in_stock" },
              { title: "The Multi-location Snowboard", price: 730, image_url: "https://x/2.png", availability: "in_stock" },
              { title: "The Archived Snowboard", price: 630, image_url: "https://x/3.png", availability: "in_stock" },
            ],
            error: null,
          }
        : undefined,
    );
    const r = await AI_TOOL_HANDLERS["catalogSearch"]!({ supabase: db.supabase, organizationId: "o", actorUserId: null, initiatedBy: "ai" }, args);
    return { db, r };
  };

  it("with order=price_asc (the flow step): same filters and limit, ordered by price in the query and the result", async () => {
    const { db, r } = await search({ limit: 5, min_price: 500, max_price: 800, order: "price_asc" });
    expect(((r as { data: Array<{ price: number }> }).data).map((x) => x.price)).toEqual([600, 630, 730]);
    const q = db.ops.find((o) => o.table === "products")!;
    expect(db.has(q, "order", "price", { ascending: true, nullsFirst: false })).toBe(true);
    expect(db.has(q, "limit", 5)).toBe(true);
    expect(db.has(q, "gte", "price", 500)).toBe(true);
    expect(db.has(q, "lte", "price", 800)).toBe(true);
  });

  it("unchanged for Aiden (no order arg): the browse order and the result order are as before", async () => {
    const { db, r } = await search({ limit: 5, min_price: 500, max_price: 800 });
    expect(((r as { data: Array<{ price: number }> }).data).map((x) => x.price)).toEqual([600, 730, 630]);
    const q = db.ops.find((o) => o.table === "products")!;
    expect(q.filters.some(([f, a]) => f === "order" && a[0] === "price")).toBe(false);
    expect(db.has(q, "order", "updated_at", { ascending: false })).toBe(true);
  });
});

// ------------------------------------------------------------------ (6)
describe("(6) flow start speed", () => {
  const RTT = 60;
  const KEYWORD = { id: "wamid.kw", type: "text", text: { body: "menu" } };
  const TAP = { id: "wamid.tap", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "menu:b1", title: "Shop" } }, context: { id: "wamid.prompt" } };
  const arrive = async (org: string, waitingRun: boolean, msg: Record<string, unknown>, onboarding: boolean) => {
    const acc = `acc-${org}`;
    const w = latencyWorld({
      org,
      rttMs: RTT,
      graphMs: RTT,
      waitingRun,
      maxConcurrent: 6,
      override: (op) => {
        if (!onboarding) return undefined;
        if (op.table === "platform_settings") return { data: { onboarding_whatsapp_account_id: acc }, error: null };
        if (op.table === "flow_triggers")
          return {
            data: [{ id: "8ea5aa7c-6a2a-4f7d-bb85-000000000000", flow_id: "flow-1", kind: "keyword", config: { keywords: ["menu"], match: "exact" }, flows: { whatsapp_account_id: acc } }],
            error: null,
          };
        return undefined;
      },
    });
    vi.stubGlobal("fetch", w.fetchStub);
    // Batch 17: on a virtual clock, so "within N round trips" never races a loaded machine.
    await inVirtualTime(async () => {
      w.t0.at = Date.now();
      await processWebhookPayload(w.supabase, `ev-${org}`, inboundPayload(msg), new Date(Date.now() - 100).toISOString(), { storeMs: RTT });
    });
    const close = w.ops.find((o) => o.table === "webhook_events" && o.kind === "update")?.payload as
      | { timing?: { messages?: Array<{ marks: Record<string, number>; route: string }> } }
      | undefined;
    return { w, timing: close?.timing?.messages?.[0] };
  };

  it("warm-up (module loading is not part of any budget)", { timeout: 20_000 }, async () => {
    await arrive("b11-warm1", false, KEYWORD, false);
    await arrive("b11-warm2", false, KEYWORD, true);
  });

  it("a keyword start records trigger matching, run creation and the first step, in order", async () => {
    for (const onboarding of [false, true]) {
      const { w, timing } = await arrive(`b11-marks-${onboarding}`, false, KEYWORD, onboarding);
      expect(w.graphSends).toHaveLength(1);
      expect(timing?.route).toBe("flow");
      const m = timing!.marks;
      const order = ["message_stored", "trigger_matched", "run_created", "first_node", "send_start"];
      for (const k of order) expect(m[k], `${k} (onboarding=${onboarding})`).toBeTypeOf("number");
      for (let i = 1; i < order.length; i++) expect(m[order[i]!]!).toBeGreaterThanOrEqual(m[order[i - 1]!]!);
    }
  });

  it("onboarding number: a keyword's first send starts within 3.5 round trips of the message being stored (before: ~8, no marks)", async () => {
    const { w, timing } = await arrive("b11-onb-kw", false, KEYWORD, true);
    expect(w.graphSends).toHaveLength(1);
    const m = timing!.marks;
    expect(m["send_start"]! - m["message_stored"]!).toBeLessThan(3.5 * RTT + RTT / 2);
    // The number is never looked up again, the run's reads went out with the message write.
    expect(w.ops.filter((o) => o.table === "whatsapp_accounts")).toHaveLength(1);
    expect(w.ops.some((o) => o.table === "whatsapp_credentials")).toBe(true);
    expect(w.ops.filter((o) => o.table === "whatsapp_credentials")).toHaveLength(1);
  });

  it("onboarding number: a tap continuing a run sends within 2.5 round trips of being stored (before: ~6)", async () => {
    const { w, timing } = await arrive("b11-onb-tap", true, TAP, true);
    expect(w.graphSends).toHaveLength(1);
    const m = timing!.marks;
    expect(m["send_start"]! - m["message_stored"]!).toBeLessThan(2.5 * RTT + RTT / 2);
  });

  it("customer number: a keyword start no longer reads the conversation's owner separately (it came with the conversation)", async () => {
    const { w } = await arrive("b11-cust-kw", false, KEYWORD, false);
    expect(w.graphSends).toHaveLength(1);
    expect(w.ops.some((o) => o.table === "conversations" && o.filters.some(([f]) => f === "not"))).toBe(false);
    const convRead = w.ops.find((o) => o.table === "conversations" && o.kind === "select")!;
    expect(String(convRead.select?.[0])).toContain("assigned_to");
    // The published version is read once, right after the triggers.
    expect(w.ops.filter((o) => o.table === "flow_versions")).toHaveLength(1);
  });

  it("unchanged: nothing is sent before the 24-hour window write lands (onboarding number too)", async () => {
    const { w } = await arrive("b11-onb-window", false, KEYWORD, true);
    const idx = (pred: (s: { phase: string; table: string; kind: string }) => boolean) => w.sequence.findIndex(pred);
    const windowEnd = idx((s) => s.phase === "end" && s.table === "conversations" && s.kind === "update");
    const sendEvent = idx((s) => s.phase === "start" && s.table === "flow_run_events" && s.kind === "insert");
    expect(windowEnd).toBeGreaterThanOrEqual(0);
    expect(sendEvent).toBeGreaterThan(windowEnd);
  });

  it("unchanged: a message no trigger matches reads no flow version (nothing extra on ordinary messages)", async () => {
    const { prefetchStartVersions, readInboundTriggers } = await import("./flow-triggers.server");
    const w = latencyWorld({ org: "b11-nomatch", rttMs: 1, graphMs: 1, waitingRun: false });
    const versions = await prefetchStartVersions(w.supabase, {
      organizationId: "b11-nomatch",
      triggers: readInboundTriggers(w.supabase, "b11-nomatch"),
      body: "hello there",
      isFirstMessageEver: false,
      isCtwa: false,
    });
    expect(versions.size).toBe(0);
    expect(w.ops.some((o) => o.table === "flow_versions")).toBe(false);
    // A matching keyword reads its flow's version, once.
    const w2 = latencyWorld({ org: "b11-match", rttMs: 1, graphMs: 1, waitingRun: false });
    const v2 = await prefetchStartVersions(w2.supabase, {
      organizationId: "b11-match",
      triggers: readInboundTriggers(w2.supabase, "b11-match"),
      body: "menu",
      isFirstMessageEver: false,
      isCtwa: false,
    });
    expect([...v2.keys()]).toEqual(["flow-1"]);
    expect((await v2.get("flow-1"))?.id).toBe("ver-1");
  });
});

// ------------------------------------------------------------------ (7)
describe("(7) no products from legal pages", () => {
  const page = (title: string, h1: string, body: string) =>
    `<html><head><title>${title}</title></head><body><h1>${h1}</h1>${body}${" ".repeat(300)}</body></html>`;
  const terms = page(
    "Terms of Service — AiDwar",
    "Terms of Service",
    "<h2>7. Limitation of liability</h2><p>Our total liability is limited to ₹5,000 or the fees paid.</p>",
  );

  it("the live junk page gives no product", () => {
    expect(extractProduct(terms, "https://aidwar.in/terms")).toBeNull();
    // Even at a URL that doesn't say so, the title gives it away.
    expect(extractProduct(terms, "https://aidwar.in/p/1")).toBeNull();
    // And a numbered clause heading is never a product name.
    const bare = page("AiDwar", "", "<h2>7. Limitation of liability</h2><p>₹5,000</p>");
    expect(extractProduct(bare, "https://aidwar.in/p/2")).toBeNull();
  });

  it("legal pages by address", () => {
    const blank = page("Shop", "", "");
    for (const u of ["https://x.in/terms", "https://x.in/privacy-policy", "https://x.in/pages/refund-policy", "https://x.in/policies/shipping-policy", "https://x.in/pages/terms-and-conditions", "https://x.in/pages/returns", "https://x.in/pages/shipping"])
      expect(isLegalPage(u, blank), u).toBe(true);
    for (const u of ["https://x.in/products/gold-ring", "https://x.in/products/shipping-box", "https://x.in/collections/rings", "https://x.in/products/terminal-pendant"])
      expect(isLegalPage(u, page("Gold ring", "Gold ring", "")), u).toBe(false);
  });

  it("numbered clause headings vs real product names", () => {
    for (const t of ["7. Limitation of liability", "2.1) Refunds", "Section 4 Payment", "Clause 9: Governing law"]) expect(looksLikeLegalClause(t), t).toBe(true);
    for (const t of ["3 Piece Kurta Set", "24K Gold Chain", "1.5 Carat Ring", "Gold Ring 7", "Snowboard"]) expect(looksLikeLegalClause(t), t).toBe(false);
  });

  it("unchanged: a real product page still reads", () => {
    const html = page(
      "Golden Petal Ring",
      "Golden Petal Ring",
      '<div class="price">₹12,499</div><img src="https://cdn.x.in/ring.jpg" class="product-image">',
    );
    const draft = extractProduct(html, "https://x.in/products/golden-petal-ring");
    expect(draft?.title).toBe("Golden Petal Ring");
    expect(draft?.price).toBe(12499);
  });

  it("the migration hides (never deletes) only crawled numbered-clause rows, idempotently, and lists the 3 live rows", () => {
    const sql = readFileSync("supabase/aidwar-migrations/20261016_hide_legal_clause_products.sql", "utf8");
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).toMatch(/UPDATE public\.products\s+SET is_visible = false/);
    expect(code).not.toMatch(/DELETE/i);
    expect(code).toContain("source = 'crawl'");
    expect(code).toContain("is_visible = true");
    for (const id of ["c3665eb7-5e58-4e65-90a5-98a7c0c887c3", "98f76a4b-81a5-454d-9bf2-f3f834384341", "56207d9d-90bf-45fa-9288-1214ec2dc86a"]) expect(sql).toContain(id);
    // The SQL pattern agrees with the extractor's rule on the live title and on real names.
    const pattern = /'(\^[^']+)'/.exec(code)![1]!;
    const re = new RegExp(pattern.replace(/\\s/g, "\\s"), "i");
    expect(re.test("7. Limitation of liability")).toBe(true);
    expect(re.test("3 Piece Kurta Set")).toBe(false);
    expect(re.test("1.5 Carat Ring")).toBe(false);
  });
});

// ------------------------------------------------------------------ (8)
describe("(8) old template sends in the inbox", () => {
  const components = [
    { type: "HEADER", format: "TEXT", text: "Hello" },
    { type: "BODY", text: "Hi {{1}}, your order {{2}} is on its way.", example: { body_text: [["Priya", "#1042"]] } },
  ];

  it("sample values stand in for a send with no stored values", () => {
    const tpl = templateBodyOf(components)!;
    expect(tpl.samples).toEqual({ "1": "Priya", "2": "#1042" });
    expect(fillTemplateText(tpl.text, null, tpl.samples)).toBe("Hi Priya, your order #1042 is on its way.");
  });

  it("no samples: a neutral '...' — never a raw {{1}}", () => {
    const tpl = templateBodyOf([{ type: "BODY", text: "Hi {{1}}" }])!;
    expect(fillTemplateText(tpl.text, null, tpl.samples)).toBe("Hi ...");
    expect(fillTemplateText("Hi {{1}}", undefined)).toBe("Hi ...");
  });

  it("named parameters use their named samples", () => {
    const tpl = templateBodyOf([{ type: "BODY", text: "Hi {{first_name}}", example: { body_text_named_params: [{ param_name: "first_name", example: "Asha" }] } }])!;
    expect(fillTemplateText(tpl.text, {}, tpl.samples)).toBe("Hi Asha");
  });

  it("unchanged: a send with stored values shows them (samples never override)", () => {
    const tpl = templateBodyOf(components)!;
    expect(fillTemplateText(tpl.text, { template_params: { "1": "Vinay", "2": "#7" } }, tpl.samples)).toBe("Hi Vinay, your order #7 is on its way.");
  });

  it("the thread shows the filled template text for a template message with no body", () => {
    const thread = readFileSync("src/components/inbox/chat-thread.tsx", "utf8");
    expect(thread).toContain("message.template_text?.trim()");
  });
});

// ------------------------------------------------------------------ (9)
describe("(9) flows list status", () => {
  it("published + switched off = Off; switched on = Published; never published = Draft", () => {
    expect(flowStatus(false, true)).toBe("Off");
    expect(flowStatus(true, true)).toBe("Published");
    expect(flowStatus(false, false)).toBe("Draft");
    // Versions not known (read failed): exactly as before.
    expect(flowStatus(true, null)).toBe("Published");
    expect(flowStatus(false, null)).toBe("Draft");
  });

  it("the editor's chip says Off for a published flow that is switched off", () => {
    const editor = readFileSync("src/components/flows/v2/flow-editor.tsx", "utf8");
    expect(editor).toContain('{published ? (switchedOff ? "Off" : "Published") : "Draft only"}');
  });
});

// Keeps FakeOp in use for readers jumping here from the helpers above.
export type { FakeOp };
