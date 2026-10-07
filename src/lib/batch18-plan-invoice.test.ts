import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./test-support/fake-db";

/**
 * Batch 18 (7) — one plan-fee invoice per workspace per period, also when
 * two billing runs overlap. Its own file: the invoice modules are mocked for
 * the whole file (two runs import them at the same moment).
 */

const h = vi.hoisted(() => ({
  invoices: [] as Array<Record<string, unknown>>,
  seq: 0,
  uniqueIndex: false,
  /** Holds the first build here (after its "already invoiced?" read) until released. */
  hold: null as null | { reached: () => void; release: Promise<void> },
}));
const tick = () => new Promise((r) => setTimeout(r, 1));
vi.mock("@/lib/invoices.server", () => ({
  loadSupplier: async () => ({ sac_platform: "998314" }),
  // Inserts a draft; with uniqueIndex, refuses a second live one like
  // plan_fee_invoice_period_uidx would.
  buildInvoice: async (_s: unknown, org: string, input: { period: { start: string } }) => {
    const hold = h.hold;
    if (hold) {
      h.hold = null;
      hold.reached();
      await hold.release;
    }
    await tick();
    if (
      h.uniqueIndex &&
      h.invoices.some(
        (i) =>
          i["organization_id"] === org &&
          i["period_start"] === input.period.start &&
          i["status"] !== "void",
      )
    )
      return { error: "We couldn't prepare the invoice." };
    h.seq += 1;
    h.invoices.push({
      id: `inv-${h.seq}`,
      organization_id: org,
      period_start: input.period.start,
      status: "draft",
      created_at: h.seq,
    });
    await tick();
    return { invoice_id: `inv-${h.seq}` };
  },
  issueInvoice: async (_s: unknown, id: string) => {
    h.invoices.find((i) => i["id"] === id)!["status"] = "issued";
    return { invoice_number: `AD/26-27/${id}` };
  },
  deliverInvoice: async () => ({}),
}));
vi.mock("@/lib/billing-statement.server", () => ({
  buildStatementLines: async () => [],
  planFeeRoiSnapshot: async () => null,
}));
vi.mock("@/lib/razorpay.server", () => ({
  razorpayKeys: async () => null,
  createPaymentLink: async () => null,
}));

import { invoicePlanFee } from "./plan-billing.server";
// Loaded once here, so the two runs below never import them at the same moment.
import "@/lib/invoices.server";
import "@/lib/billing-statement.server";
import "@/lib/razorpay.server";

beforeEach(() => {
  h.invoices.length = 0;
  h.seq = 0;
  h.uniqueIndex = false;
});

const db = () =>
  fakeDb((op) => {
    if (op.table === "invoices" && op.kind === "select") {
      const org = op.filters.find(([n, a]) => n === "eq" && a[0] === "organization_id")![1][1];
      const start = op.filters.find(([n, a]) => n === "eq" && a[0] === "period_start")![1][1];
      const rows = h.invoices
        .filter(
          (i) =>
            i["organization_id"] === org && i["period_start"] === start && i["status"] !== "void",
        )
        .sort((a, b) => Number(a["created_at"]) - Number(b["created_at"]))
        .slice(0, 2)
        .map((i) => ({ id: i["id"] }));
      return { data: rows, error: null };
    }
    if (op.table === "invoices" && op.kind === "delete") {
      const id = op.filters.find(([n, a]) => n === "eq" && a[0] === "id")![1][1];
      const at = h.invoices.findIndex((i) => i["id"] === id && i["status"] === "draft");
      if (at >= 0) h.invoices.splice(at, 1);
      return { data: null, error: null };
    }
    if (op.table === "organizations")
      return { data: { id: "org-1", name: "Zoori", plan_version_id: "pv-1" }, error: null };
    if (op.table === "plan_versions")
      return { data: { price_monthly: 999, plans: { name: "Growth" } }, error: null };
    if (op.table === "organization_billing_settings") return { data: null, error: null };
    return undefined;
  });
const period = { start: "2026-11-01", end: "2026-11-30" };

describe("(7) one plan-fee invoice per workspace per period", () => {
  it("duplicate plan-fee invoice: two runs at once raise one (the unique index, 20261026, refuses the second)", async () => {
    // 20261026_plan_fee_invoice_unique.sql is applied live (Batch 20 item 10):
    // the index, not a check in code, keeps one invoice per period.
    h.uniqueIndex = true;
    const d = db();
    // Run A has read "nothing invoiced" and is building; run B reads, builds
    // and issues meanwhile; then A goes on. Both passed the read before either
    // wrote: the race. (Interleaved by hand: two dynamic imports of a mocked
    // module at the same moment can load the real one under vitest.)
    let reached!: () => void;
    let release!: () => void;
    const atBuild = new Promise<void>((r) => (reached = r));
    h.hold = { reached, release: new Promise<void>((r) => (release = r)) };
    const a = invoicePlanFee(d.supabase, "org-1", period);
    await atBuild;
    const b = await invoicePlanFee(d.supabase, "org-1", period);
    release();
    const results = [await a, b];
    expect(
      h.invoices.filter((i) => i["status"] !== "void"),
      JSON.stringify(results),
    ).toHaveLength(1);
    expect(h.invoices[0]!["status"]).toBe("issued");
    expect(results.filter((r) => "invoice_id" in r)).toHaveLength(1);
    expect(results.filter((r) => "error" in r && r.error === "already_invoiced")).toHaveLength(1);
  });

  it("duplicate plan-fee invoice: the unique index refuses ours because another run's is there → already_invoiced", async () => {
    h.uniqueIndex = true;
    const d = db();
    // Our read finds nothing; the other run's draft lands before our insert.
    let reads = 0;
    const raced = fakeDb((op) => {
      if (op.table === "invoices" && op.kind === "select" && reads++ === 0) {
        h.invoices.push({
          id: "inv-other",
          organization_id: "org-1",
          period_start: period.start,
          status: "draft",
          created_at: 0,
        });
        return { data: [], error: null };
      }
      return undefined;
    });
    const client = {
      from: (t: string) =>
        t === "invoices" && reads === 0 ? raced.supabase.from(t) : d.supabase.from(t),
      rpc: d.supabase.rpc,
    };
    const out = await invoicePlanFee(client as never, "org-1", period);
    expect(out).toEqual({ error: "already_invoiced" });
    expect(h.invoices.map((i) => i["id"])).toEqual(["inv-other"]);
  });

  it("a period already invoiced is left alone (unchanged)", async () => {
    const d = db();
    await invoicePlanFee(d.supabase, "org-1", period);
    expect(await invoicePlanFee(d.supabase, "org-1", period)).toEqual({
      error: "already_invoiced",
    });
    expect(h.invoices).toHaveLength(1);
  });

  it("a failed read is reported, never taken as 'nothing invoiced yet'", async () => {
    const d = fakeDb((op) =>
      op.table === "invoices" ? { data: null, error: { message: "timeout" } } : undefined,
    );
    expect(await invoicePlanFee(d.supabase, "org-1", period)).toEqual({ error: "timeout" });
    expect(h.invoices).toHaveLength(0);
  });
});
