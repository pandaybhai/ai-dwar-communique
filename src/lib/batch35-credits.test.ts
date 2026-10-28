import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeDb } from "./test-support/fake-db";
import { creditPurchaseBlock } from "./billing";

/**
 * Batch 35 item 6 (live bug) — buying credits was refused unless the
 * workspace had a plan bought ("Pick a plan first"). Trial (with or without a
 * plan yet), active, past due and paused workspaces may buy credits and ask
 * for a top-up; only locked and cancelled must pick a plan first. The purchase
 * itself (Razorpay or Cashfree, createCreditPurchase) is unchanged.
 */

const h = vi.hoisted(() => ({
  org: null as Record<string, unknown> | null,
  purchase: vi.fn(async () => ({ url: "https://pay.example/1", payment_id: "p1" })),
  topup: vi.fn(async () => ({ ok: true as const })),
}));
vi.mock("@/lib/whatsapp-api.server", () => ({
  requireOrgMember: async () => ({
    supabase: fakeDb((op) =>
      op.table === "organizations" ? { data: h.org, error: null } : undefined,
    ).supabase,
    organizationId: "org",
    userId: "u1",
  }),
  isResponse: (r: unknown) => r instanceof Response,
  jsonError: (error: string, status = 400) => Response.json({ error }, { status }),
}));
vi.mock("@/lib/billing.server", () => ({
  billingEnabled: async () => true,
  isPermissionError: () => false,
  createCreditPurchase: h.purchase,
  requestTopup: h.topup,
}));

import { Route as PurchaseRoute } from "../routes/api/billing/purchase";
import { Route as TopupRoute } from "../routes/api/billing/request-topup";

type Post = (a: { request: Request }) => Promise<Response>;
const post = (r: unknown, body: Record<string, unknown>) =>
  (r as { options: { server: { handlers: { POST: Post } } } }).options.server.handlers.POST({
    request: new Request("https://aidwar.in/api/billing/x", {
      method: "POST",
      body: JSON.stringify({ organization_id: "org", ...body }),
    }),
  });

beforeEach(() => {
  h.purchase.mockClear();
  h.topup.mockClear();
});

describe("who may buy credits", () => {
  const cases: Array<[string, Record<string, unknown>, number]> = [
    ["trial, no plan bought yet", { plan_status: "trial", plan_version_id: null }, 200],
    ["trial with a plan", { plan_status: "trial", plan_version_id: "pv1" }, 200],
    ["active", { plan_status: "active", plan_version_id: "pv1" }, 200],
    ["past_due", { plan_status: "past_due", plan_version_id: "pv1" }, 200],
    ["paused", { plan_status: "paused", plan_version_id: "pv1" }, 200],
    ["locked", { plan_status: "locked", plan_version_id: "pv1" }, 409],
    ["cancelled", { plan_status: "cancelled", plan_version_id: "pv1" }, 409],
  ];

  for (const [name, org, status] of cases) {
    it(`${name}: buy credits ${status === 200 ? "allowed" : "refused"}, top-up request the same`, async () => {
      h.org = org;
      const buy = await post(PurchaseRoute, { pack_id: "pack-1" });
      expect(buy.status).toBe(status);
      const ask = await post(TopupRoute, { amount: 500 });
      expect(ask.status).toBe(status);
      if (status === 200) {
        expect(h.purchase).toHaveBeenCalledTimes(1);
        expect(h.topup).toHaveBeenCalledTimes(1);
      } else {
        expect(((await buy.json()) as { error: string }).error).toBe(
          "Pick a plan first — a locked or cancelled workspace can't buy credits.",
        );
        expect(h.purchase).not.toHaveBeenCalled();
        expect(h.topup).not.toHaveBeenCalled();
      }
    });
  }

  it("a workspace that can't be read is never let through", async () => {
    h.org = null;
    expect((await post(PurchaseRoute, { pack_id: "pack-1" })).status).toBe(503);
    expect(h.purchase).not.toHaveBeenCalled();
  });
});

describe("the billing page uses the same rule", () => {
  it("creditPurchaseBlock: only locked and cancelled", () => {
    for (const s of ["trial", "active", "past_due", "paused", null, undefined])
      expect(creditPurchaseBlock(s)).toBeNull();
    expect(creditPurchaseBlock("locked")).toMatch(/Pick a plan first/);
    expect(creditPurchaseBlock("CANCELLED")).toMatch(/Pick a plan first/);
  });

  it("canTopUp no longer needs a bought plan", () => {
    const page = readFileSync(join(import.meta.dirname, "../routes/app/billing.tsx"), "utf8");
    expect(page).toContain(
      "const canTopUp = Boolean(org) && !creditPurchaseBlock(org?.plan_status);",
    );
    expect(page).not.toMatch(/canTopUp =\s*Boolean\(org\?\.plan_version_id\)/);
  });
});
