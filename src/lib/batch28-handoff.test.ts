import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";

/**
 * Batch 28 item 1 — hand-off alerts were never sent (handoff_alert_at NULL on
 * every row): the flow's Assign step fired the alert and forgot it inside a
 * worker request that ended first, and a send that threw skipped the record.
 */

const alert = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>>, finished: 0 }));
vi.mock("@/lib/ai-tools.server", () => ({ enabledFlags: async () => new Set(["flows_v2"]) }));
vi.mock("@/lib/feature-flags.server", () => ({ enabledFlags: async () => new Set(["flows_v2"]) }));
vi.mock("@/lib/flows.server", () => ({
  loadSendSettings: async () => ({ timezone: "Asia/Kolkata" }),
}));
vi.mock("@/lib/whatsapp-numbers.server", () => ({
  ACCOUNT_COLUMNS: "id, organization_id, waba_id",
  getWhatsAppConnection: async () => ({ connection: null }),
  connectionForAccount: async () => ({ connection: null }),
}));

afterEach(() => {
  alert.calls.length = 0;
  alert.finished = 0;
  vi.doUnmock("@/lib/handoff-alerts.server");
  vi.resetModules();
});

const WAIT_THEN_ASSIGN = {
  nodes: [
    { id: "s", type: "start", data: {} },
    { id: "w", type: "wait", data: { minutes: 30 } },
    { id: "a", type: "assign", data: { mode: "team" } },
    { id: "e", type: "end", data: {} },
  ],
  edges: [
    { id: "e1", source: "s", target: "w", sourceHandle: "next" },
    { id: "e2", source: "w", target: "a", sourceHandle: "next" },
    { id: "e3", source: "a", target: "e", sourceHandle: "next" },
  ],
};

const claimed = {
  id: "run-1",
  organization_id: "org-1",
  flow_id: "flow-1",
  version_id: "ver-1",
  contact_id: "contact-1",
  conversation_id: "conv-1",
  current_node_id: "w",
  variables: {},
  status: "running",
  waiting_for: "timer",
  wake_at: new Date(Date.now() - 1000).toISOString(),
  steps: 2,
  started_at: new Date().toISOString(),
  claimed_at: "2026-10-08T08:00:00.000000+00:00",
  trigger: {},
};

describe("item 1 — a flow's Assign step sends the staff alert before the worker moves on", () => {
  it("tickRuns returns only after sendHandoffAlert has finished (no fire-and-forget)", async () => {
    vi.doMock("@/lib/handoff-alerts.server", () => ({
      sendHandoffAlert: async (_db: unknown, args: Record<string, unknown>) => {
        alert.calls.push(args);
        // A real alert takes a few round trips.
        await new Promise((r) => setTimeout(r, 20));
        alert.finished += 1;
        return { whatsapp: ["+919876543210"], email: null, refused: [] };
      },
    }));
    const { tickRuns } = await import("./flow-engine.server");
    const db = fakeDb(
      (op: FakeOp) => {
        if (op.table === "contacts")
          return {
            data: {
              name: "Asha",
              phone: "+919800000001",
              wa_id: null,
              attributes: {},
              opt_in_status: "opted_in",
            },
            error: null,
          };
        if (op.table === "flow_versions") return { data: { graph: WAIT_THEN_ASSIGN }, error: null };
        if (op.table === "flow_runs" && op.kind === "select")
          return { data: { trigger: {} }, error: null };
        return undefined;
      },
      (call) => (call.name === "claim_flow_runs" ? { data: [claimed], error: null } : undefined),
    );
    await tickRuns(db.supabase, { deadlineAt: Date.now() + 60_000 });
    expect(alert.calls).toEqual([
      { organizationId: "org-1", conversationId: "conv-1", reason: "flow_assign" },
    ]);
    expect(alert.finished).toBe(1);
    // The chat is marked as waiting for a person first.
    const marked = db.ops.find((o) => o.table === "conversations" && o.kind === "update");
    expect(marked?.payload).toMatchObject({ needs_human: true, needs_human_reason: "flow_assign" });
  });
});

/** One waiting chat with a staff phone and an email saved. */
function alertWorld(
  settings: Record<string, unknown> = {
    handoff_alert_phones: ["+919876543210"],
    handoff_alert_email: "team@shop.test",
  },
) {
  return fakeDb((op) => {
    if (op.table === "organization_ai_settings")
      return { data: { handoff_alert_hours: null, ...settings }, error: null };
    if (op.table === "whatsapp_accounts")
      return { data: [{ display_phone_number: "+91 98000 00098" }], error: null };
    if (op.table === "organizations") return { data: { name: "Zoori" }, error: null };
    if (op.table === "conversations" && op.kind === "select")
      return { data: { contacts: { name: "Asha", phone: "+919800000001" } }, error: null };
    return undefined;
  });
}
const updates = (db: ReturnType<typeof alertWorld>) =>
  db.ops
    .filter((o) => o.table === "conversations" && o.kind === "update")
    .map((o) => o.payload as Record<string, unknown>);

describe("item 1 — sendHandoffAlert always completes and records who was told", () => {
  it("a WhatsApp send that throws still falls back to email and writes handoff_alert_at + the result", async () => {
    const { sendHandoffAlert } = await import("./handoff-alerts.server");
    const db = alertWorld();
    const emails: string[] = [];
    const out = await sendHandoffAlert(
      db.supabase,
      { organizationId: "org-1", conversationId: "conv-1", reason: "flow_assign" },
      {
        channelFor: async () => null,
        sendTemplate: async () => {
          throw new Error("graph timeout");
        },
        sendEmail: async (to) => (emails.push(to), true),
      },
    );
    expect(emails).toEqual(["team@shop.test"]);
    expect(out.email).toBe("team@shop.test");
    const [stamp, result] = updates(db);
    expect(Object.keys(stamp!)).toEqual(["handoff_alert_at", "handoff_reminded_at"]);
    // The result is its own write: a database without the column keeps the timestamp.
    expect(Object.keys(result!)).toEqual(["handoff_alert_result"]);
    expect(result!["handoff_alert_result"]).toMatchObject({
      whatsapp: [],
      email: "team@shop.test",
      skipped: null,
      reminder: false,
    });
  });

  it("the approved template reaches staff any time (no open chat needed)", async () => {
    const { sendHandoffAlert } = await import("./handoff-alerts.server");
    const db = alertWorld();
    const out = await sendHandoffAlert(
      db.supabase,
      { organizationId: "org-1", conversationId: "conv-1", reason: "flow_assign" },
      { channelFor: async () => null, sendTemplate: async () => true, sendEmail: async () => true },
    );
    expect(out.whatsapp).toEqual(["+919876543210"]);
    expect(out.templated).toEqual(["+919876543210"]);
    expect(out.email).toBeNull();
    expect(updates(db)[1]!["handoff_alert_result"]).toMatchObject({
      whatsapp: ["+919876543210"],
      email: null,
    });
  });

  it("a failed settings read still records the alert (so the 30-minute reminder retries it)", async () => {
    const { sendHandoffAlert } = await import("./handoff-alerts.server");
    const db = fakeDb((op) => {
      if (op.table === "organization_ai_settings") throw new Error("connection reset");
      return undefined;
    });
    const out = await sendHandoffAlert(db.supabase, {
      organizationId: "org-1",
      conversationId: "conv-1",
      reason: "flow_assign",
    });
    expect(out.skipped).toBe("error");
    expect(updates(db)[0]).toHaveProperty("handoff_alert_at");
  });

  it("the Inbox banner says who was told, or that nobody could be reached", async () => {
    const { describeAlertResult } = await import("./ai-outcome");
    const at = "2026-10-08T06:00:00.000Z";
    expect(describeAlertResult(null)).toBeNull();
    expect(
      describeAlertResult({ at, whatsapp: ["+919876543210"], email: null, skipped: null }),
    ).toBe("Your team was told: +919876543210 on WhatsApp.");
    expect(describeAlertResult({ at, whatsapp: [], email: "team@shop.test", skipped: null })).toBe(
      "Your team was told: team@shop.test by email.",
    );
    expect(
      describeAlertResult({ at, whatsapp: [], email: null, skipped: "no_staff_contact" }),
    ).toMatch(/^Nobody on your team was told/);
    expect(
      describeAlertResult({ at, whatsapp: [], email: null, skipped: "not_delivered" }),
    ).toMatch(/^Nobody on your team could be reached/);
  });

  it("a flow's hand-off no longer claims a message to the customer failed", () => {
    const src = readFileSync(join(__dirname, "../components/inbox/chat-thread.tsx"), "utf8");
    expect(src).toMatch(/conversation\.handover_state \? \(/);
    expect(src).toContain("describeAlertResult");
  });

  it("settings copy: alerts go as an approved WhatsApp message any time; email only if WhatsApp fails", () => {
    const src = readFileSync(
      join(__dirname, "../components/employee/handoff-alerts-card.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/last 24 hours/);
    expect(src).toMatch(/any time of day/);
    expect(src).toMatch(/email is used only if WhatsApp can't reach anyone/);
  });
});

describe("item 1 audit — no fire-and-forget import() in server code", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) files.push(p);
    }
  };
  walk(join(__dirname));
  walk(join(__dirname, "../routes/api"));

  it("no `void import(...)` anywhere a request could end before it runs", () => {
    const offenders = files.filter((f) => /void\s+import\(/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
