import { describe, expect, it, vi } from "vitest";
import { memoryDb, type Row } from "@/lib/test-support/memory-db";
import {
  cancelledLabel,
  cancellingNotes,
  creditCoverByInvoice,
  withoutCancelled,
} from "@/lib/invoice-cancel";

/**
 * Batch 58 items 1 and 2: internal (non-billed) workspaces and invoices
 * cancelled by credit notes. All against an in-memory database; nothing
 * reaches a live database, WhatsApp, Meta or Cashfree.
 */

const ORG = "org-aidwar";
const OTHER = "org-customer";
const ADMIN = "user-super";

function world(seed: Record<string, Row[]> = {}) {
  const walletCalls: Record<string, unknown>[] = [];
  let cn = 0;
  const db = memoryDb(
    {
      platform_settings: [{ id: true, invoice_series: "AD" }],
      organizations: [
        { id: ORG, name: "Ai Dwar", plan_version_id: "pv-1", plan_status: "active", billing_day: 1, billing_enabled_at: "2026-09-01T00:00:00Z" },
        { id: OTHER, name: "Customer", plan_version_id: "pv-1", plan_status: "active", billing_day: 1, billing_enabled_at: "2026-09-01T00:00:00Z" },
      ],
      organization_billing_settings: [
        { organization_id: ORG, limits_override: { _manual_flags: { ai: true } } },
        { organization_id: OTHER, limits_override: {} },
      ],
      invoices: [],
      credit_notes: [],
      billing_notifications: [],
      activity_log: [],
      subscriptions: [],
      ...seed,
    },
    {
      next_invoice_number: (args) => {
        cn += 1;
        return { data: `${String(args["p_series"])}/2026-27/${String(cn).padStart(5, "0")}`, error: null };
      },
      wallet_apply: (args) => {
        walletCalls.push(args);
        return { data: "ledger-1", error: null };
      },
    },
  );
  return { db, supabase: db.supabase, rows: db.rows, walletCalls };
}

const invoice = (id: string, extra: Row = {}): Row => ({
  id,
  organization_id: ORG,
  invoice_number: `AD/2026-27/${id}`,
  kind: "invoice",
  purpose: "plan_fee",
  status: "issued",
  total: 9999,
  taxable_value: 9999,
  cgst: 0,
  sgst: 0,
  igst: 0,
  amount_paid: 0,
  due_date: "2026-10-01",
  created_at: "2026-09-24T00:00:00Z",
  ...extra,
});

describe("(2) cancelled = credit notes cover the whole total of an unpaid invoice", () => {
  it("00013 / 00027 / 00028: a full credit note with refund_mode none cancels it", () => {
    const cover = creditCoverByInvoice([
      { invoice_id: "00027", number: "CN/2026-27/00004", amount: 9999, status: "issued" },
      { invoice_id: "00028", number: "CN/2026-27/00005", amount: 4999, status: "issued" },
    ]);
    expect(cancellingNotes({ status: "issued", total: 9999 }, cover.get("00027"))).toEqual(["CN/2026-27/00004"]);
    expect(cancellingNotes({ status: "issued", total: 4999 }, cover.get("00028"))).toEqual(["CN/2026-27/00005"]);
    expect(cancelledLabel(["CN/2026-27/00004"])).toBe("Cancelled (credit note CN/2026-27/00004)");
  });

  it("part credit, void notes, paid invoices and zero totals are not cancelled", () => {
    const cover = creditCoverByInvoice([
      { invoice_id: "a", number: "CN/1", amount: 5000, status: "issued" },
      { invoice_id: "b", number: "CN/2", amount: 9999, status: "void" },
      { invoice_id: "c", number: "CN/3", amount: 9999, status: "issued" },
    ]);
    expect(cancellingNotes({ status: "issued", total: 9999 }, cover.get("a"))).toBeNull();
    expect(cancellingNotes({ status: "issued", total: 9999 }, cover.get("b"))).toBeNull();
    expect(cancellingNotes({ status: "paid", total: 9999 }, cover.get("c"))).toBeNull();
    expect(cancellingNotes({ status: "void", total: 9999 }, cover.get("c"))).toBeNull();
    expect(cancellingNotes({ status: "issued", total: 0 }, cover.get("c"))).toBeNull();
  });

  it("two notes adding up to the total, to the paisa", () => {
    const cover = creditCoverByInvoice([
      { invoice_id: "x", number: "CN/1", amount: 0.1, status: "issued" },
      { invoice_id: "x", number: "CN/2", amount: 0.2, status: "issued" },
    ]);
    expect(cancellingNotes({ status: "partially_paid", total: 0.3 }, cover.get("x"))).toEqual(["CN/1", "CN/2"]);
    expect(cancelledLabel(["CN/1", "CN/2"])).toBe("Cancelled (credit notes CN/1, CN/2)");
    expect(withoutCancelled([{ id: "x", status: "issued", total: 0.3 }, { id: "y", status: "issued", total: 1 }], cover)).toEqual([
      { id: "y", status: "issued", total: 1 },
    ]);
  });
});

describe("(2) dunning and overdue reminders never chase a cancelled invoice", () => {
  it("runDunning skips the cancelled invoice and still chases a live one", async () => {
    const { runDunning } = await import("@/lib/dunning.server");
    const w = world({
      invoices: [
        invoice("00013", { organization_id: OTHER, due_date: "2026-09-20" }),
        invoice("00020", { organization_id: OTHER, total: 4999, due_date: "2026-09-25" }),
      ],
      credit_notes: [{ id: "cn-1", invoice_id: "00013", organization_id: OTHER, number: "CN/2026-27/00001", amount: 9999, status: "issued", refund_mode: "none" }],
    });
    const counts = await runDunning(w.supabase, new Date("2026-10-30T12:00:00Z"));
    expect(counts.notified).toBe(1);
    const notices = w.rows("billing_notifications");
    expect(notices).toHaveLength(1);
    expect((notices[0]!["payload"] as Row)["invoice_number"]).toBe("AD/2026-27/00020");
  });

  it("only cancelled invoices overdue → nobody is chased", async () => {
    const { runDunning } = await import("@/lib/dunning.server");
    const w = world({
      invoices: [invoice("00013", { organization_id: OTHER })],
      credit_notes: [{ id: "cn-1", invoice_id: "00013", number: "CN/2026-27/00001", amount: 9999, status: "issued" }],
    });
    const counts = await runDunning(w.supabase, new Date("2026-10-30T12:00:00Z"));
    expect(counts.notified + counts.paused + counts.suspended).toBe(0);
    expect(w.rows("billing_notifications")).toHaveLength(0);
    expect(w.rows("activity_log").filter((a) => a["action"] === "dunning_advanced")).toHaveLength(0);
  });

  it("a queued overdue notice for an invoice cancelled since is skipped by the drain check", async () => {
    const { noticeNoLongerOwed } = await import("@/lib/billing-notify.server");
    const w = world({
      invoices: [invoice("00027")],
      credit_notes: [{ id: "cn-1", invoice_id: "00027", number: "CN/1", amount: 9999, status: "issued" }],
    });
    const why = await noticeNoLongerOwed(w.supabase, {
      audience: "client",
      kind: "invoice_overdue",
      organization_id: OTHER,
      payload: { invoice_id: "00027" },
    });
    expect(why).toBe("invoice_cancelled");
    expect(
      await noticeNoLongerOwed(w.supabase, { audience: "client", kind: "credits_added", organization_id: OTHER, payload: {} }),
    ).toBeNull();
  });

  it("a payment no longer waits on a cancelled plan invoice to lift dunning", async () => {
    const { markPaid } = await import("@/lib/invoices.server");
    const w = world({
      invoices: [invoice("00030", { organization_id: OTHER }), invoice("00013", { organization_id: OTHER })],
      credit_notes: [{ id: "cn-1", invoice_id: "00013", number: "CN/1", amount: 9999, status: "issued" }],
    });
    w.rows("organization_billing_settings").find((r) => r["organization_id"] === OTHER)!["dunning_stage"] = "reminder_1";
    const result = await markPaid(w.supabase, "00030", "pay-1", 9999);
    expect(result.error).toBeNull();
    const settings = w.rows("organization_billing_settings").find((r) => r["organization_id"] === OTHER)!;
    expect(settings["dunning_stage"]).toBeNull();
  });
});

describe("(2) Cancel invoice = issueCreditNote, wallet OFF, reason required", () => {
  it("issues one credit note for the whole total, refund_mode none, never touches the wallet or the invoice row", async () => {
    const { cancelInvoice } = await import("@/lib/credit-notes.server");
    const w = world({ invoices: [invoice("00027")] });
    const before = { ...w.rows("invoices")[0]! };
    const result = await cancelInvoice(w.supabase, { invoiceId: "00027", reason: "Our own test workspace", actorId: ADMIN });
    expect("error" in result).toBe(false);
    const notes = w.rows("credit_notes");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ invoice_id: "00027", amount: 9999, refund_mode: "none", status: "issued", created_by: ADMIN });
    expect(String(notes[0]!["reason"])).toContain("Our own test workspace");
    expect(w.walletCalls).toHaveLength(0);
    // The invoice is never edited: same status, same number, same total.
    const after = w.rows("invoices")[0]!;
    expect({ status: after["status"], invoice_number: after["invoice_number"], total: after["total"] }).toEqual({
      status: before["status"],
      invoice_number: before["invoice_number"],
      total: before["total"],
    });
    expect(w.rows("activity_log").map((a) => a["action"])).toEqual(["credit_note_issued", "invoice_cancelled"]);
  });

  it("credits only what is left after an earlier part credit", async () => {
    const { cancelInvoice } = await import("@/lib/credit-notes.server");
    const w = world({
      invoices: [invoice("00027")],
      credit_notes: [{ id: "cn-0", invoice_id: "00027", number: "CN/0", amount: 999, taxable_value: 999, status: "issued" }],
    });
    const result = await cancelInvoice(w.supabase, { invoiceId: "00027", reason: "Test workspace", actorId: ADMIN });
    expect(result).toMatchObject({ amount: 9000 });
  });

  it("refuses: no reason, a paid or part-paid invoice, one already cancelled", async () => {
    const { cancelInvoice } = await import("@/lib/credit-notes.server");
    const w = world({
      invoices: [
        invoice("a"),
        invoice("paid", { status: "paid", amount_paid: 9999 }),
        invoice("part", { status: "partially_paid", amount_paid: 10 }),
        invoice("done"),
      ],
      credit_notes: [{ id: "cn-0", invoice_id: "done", number: "CN/0", amount: 9999, status: "issued" }],
    });
    expect(await cancelInvoice(w.supabase, { invoiceId: "a", reason: " ", actorId: ADMIN })).toHaveProperty("error");
    expect(await cancelInvoice(w.supabase, { invoiceId: "paid", reason: "test", actorId: ADMIN })).toHaveProperty("error");
    expect(await cancelInvoice(w.supabase, { invoiceId: "part", reason: "test", actorId: ADMIN })).toHaveProperty("error");
    expect(await cancelInvoice(w.supabase, { invoiceId: "done", reason: "test", actorId: ADMIN })).toHaveProperty("error");
    expect(w.rows("credit_notes")).toHaveLength(1);
  });

  it("cancelling the only overdue plan invoice lifts the dunning ladder", async () => {
    const { cancelInvoice } = await import("@/lib/credit-notes.server");
    const w = world({ invoices: [invoice("00013", { organization_id: OTHER })] });
    w.rows("organization_billing_settings").find((r) => r["organization_id"] === OTHER)!["dunning_stage"] = "reminder_2";
    const result = await cancelInvoice(w.supabase, { invoiceId: "00013", reason: "Billed in error", actorId: ADMIN });
    expect(result).toMatchObject({ dunning_lifted: true });
    expect(w.rows("organization_billing_settings").find((r) => r["organization_id"] === OTHER)!["dunning_stage"]).toBeNull();
  });
});

describe("(1) Internal workspace - don't bill", () => {
  it("on: billing_enabled_at NULL (the existing 'we don't bill' rule) + a marker; other overrides kept; logged", async () => {
    const { setInternalWorkspace, isInternalWorkspace } = await import("@/lib/internal-workspace.server");
    const w = world();
    const result = await setInternalWorkspace(w.supabase, { organizationId: ORG, internal: true, reason: "Our own workspace", actorId: ADMIN });
    expect(result).toMatchObject({ ok: true, internal: true, billing_enabled_at: null });
    const org = w.rows("organizations").find((o) => o["id"] === ORG)!;
    expect(org["billing_enabled_at"]).toBeNull();
    const settings = w.rows("organization_billing_settings").find((s) => s["organization_id"] === ORG)!;
    expect((settings["limits_override"] as Row)["_manual_flags"]).toEqual({ ai: true });
    expect((settings["limits_override"] as Row)["_internal_workspace"]).toMatchObject({ by: ADMIN, reason: "Our own workspace" });
    expect(await isInternalWorkspace(w.supabase, ORG)).toBe(true);
    expect(await isInternalWorkspace(w.supabase, OTHER)).toBe(false);
    const log = w.rows("activity_log").find((a) => a["action"] === "internal_workspace_on")!;
    expect(log).toMatchObject({ organization_id: ORG, user_id: ADMIN });
    expect((log["details"] as Row)["billing_enabled_at_before"]).toBe("2026-09-01T00:00:00Z");
  });

  it("a reason is required to switch it on", async () => {
    const { setInternalWorkspace } = await import("@/lib/internal-workspace.server");
    const w = world();
    expect(await setInternalWorkspace(w.supabase, { organizationId: ORG, internal: true, reason: "", actorId: ADMIN })).toHaveProperty("error");
    expect(w.rows("organizations").find((o) => o["id"] === ORG)!["billing_enabled_at"]).toBe("2026-09-01T00:00:00Z");
  });

  it("off: billing starts now (never back-charged), the marker goes", async () => {
    const { setInternalWorkspace, isInternalWorkspace } = await import("@/lib/internal-workspace.server");
    const w = world();
    await setInternalWorkspace(w.supabase, { organizationId: ORG, internal: true, reason: "test", actorId: ADMIN });
    const t0 = Date.now();
    const off = await setInternalWorkspace(w.supabase, { organizationId: ORG, internal: false, reason: "", actorId: ADMIN });
    expect(off).toMatchObject({ ok: true, internal: false });
    const at = Date.parse(String(w.rows("organizations").find((o) => o["id"] === ORG)!["billing_enabled_at"]));
    expect(at).toBeGreaterThanOrEqual(t0 - 1000);
    expect(await isInternalWorkspace(w.supabase, ORG)).toBe(false);
  });

  it("a plan change re-stamps billing_enabled_at (live trigger); reapplyInternalWorkspace clears it again, a no-op elsewhere", async () => {
    const { setInternalWorkspace, reapplyInternalWorkspace } = await import("@/lib/internal-workspace.server");
    const w = world();
    await setInternalWorkspace(w.supabase, { organizationId: ORG, internal: true, reason: "test", actorId: ADMIN });
    // What org_plan_assigned_before does on a plan change:
    w.rows("organizations").find((o) => o["id"] === ORG)!["billing_enabled_at"] = "2026-11-02T00:00:00Z";
    expect(await reapplyInternalWorkspace(w.supabase, ORG)).toBe(true);
    expect(w.rows("organizations").find((o) => o["id"] === ORG)!["billing_enabled_at"]).toBeNull();
    expect(await reapplyInternalWorkspace(w.supabase, OTHER)).toBe(false);
    expect(w.rows("organizations").find((o) => o["id"] === OTHER)!["billing_enabled_at"]).toBe("2026-09-01T00:00:00Z");
  });

  it("no billing notices to the workspace; admin notices and other workspaces untouched", async () => {
    const { setInternalWorkspace } = await import("@/lib/internal-workspace.server");
    const { notify } = await import("@/lib/billing.server");
    const w = world();
    await setInternalWorkspace(w.supabase, { organizationId: ORG, internal: true, reason: "test", actorId: ADMIN });
    for (const kind of ["invoice_issued", "invoice_overdue", "payment_failed", "low_credits", "trial_ending"]) {
      await notify(w.supabase, { organizationId: ORG, audience: "client", kind, payload: { invoice_id: `i-${kind}` } });
    }
    expect(w.rows("billing_notifications")).toHaveLength(0);
    await notify(w.supabase, { organizationId: ORG, audience: "client", kind: "credits_added", payload: {} });
    await notify(w.supabase, { organizationId: ORG, audience: "admin", kind: "settle_failed", payload: {} });
    await notify(w.supabase, { organizationId: OTHER, audience: "client", kind: "low_credits", payload: {} });
    expect(w.rows("billing_notifications").map((n) => `${String(n["organization_id"])}:${String(n["kind"])}`)).toEqual([
      `${ORG}:credits_added`,
      `${ORG}:settle_failed`,
      `${OTHER}:low_credits`,
    ]);
  });

  it("no plan-fee invoice and no dunning, even if billing_enabled_at was stamped again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T06:00:00Z"));
    try {
      const { setInternalWorkspace } = await import("@/lib/internal-workspace.server");
      const { runPlanBilling } = await import("@/lib/plan-billing.server");
      const { runDunning } = await import("@/lib/dunning.server");
      const w = world({ invoices: [invoice("00027", { due_date: "2026-10-01" })] });
      await setInternalWorkspace(w.supabase, { organizationId: ORG, internal: true, reason: "test", actorId: ADMIN });
      w.rows("organizations").find((o) => o["id"] === ORG)!["billing_enabled_at"] = "2026-10-01T00:00:00Z";
      // OTHER is billed as before: runPlanBilling tries it (and fails on
      // missing plan rows in this fake), ORG is never tried.
      const counts = await runPlanBilling(w.supabase);
      expect(counts.skipped).toBeGreaterThanOrEqual(1);
      expect(w.rows("invoices").filter((i) => i["organization_id"] === ORG && i["id"] !== "00027")).toHaveLength(0);
      const dunning = await runDunning(w.supabase, new Date("2026-11-01T06:00:00Z"));
      expect(dunning.notified).toBe(0);
      expect(w.rows("billing_notifications").filter((n) => n["organization_id"] === ORG)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("already-queued billing notices of an internal workspace are skipped by the drain check", async () => {
    const { setInternalWorkspace } = await import("@/lib/internal-workspace.server");
    const { noticeNoLongerOwed } = await import("@/lib/billing-notify.server");
    const w = world();
    await setInternalWorkspace(w.supabase, { organizationId: ORG, internal: true, reason: "test", actorId: ADMIN });
    expect(await noticeNoLongerOwed(w.supabase, { audience: "client", kind: "low_credits", organization_id: ORG, payload: {} })).toBe(
      "internal_workspace",
    );
    expect(await noticeNoLongerOwed(w.supabase, { audience: "admin", kind: "low_credits", organization_id: ORG, payload: {} })).toBeNull();
  });
});
