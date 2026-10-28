import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ORG, publicApiWorld } from "./test-support/public-api-world";
import { resetDialCodeCache } from "./public-api-send.server";

/**
 * Batch 37 item 6 — GET /api/v1/account/balance: the wallet (as its ledger
 * left it) and per-category prices from client_rate_for, the rates messages
 * are debited at. Only the key's own workspace. Fakes only.
 */

const h = vi.hoisted(() => ({
  world: null as null | ReturnType<typeof import("./test-support/public-api-world").publicApiWorld>,
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.world!.db.supabase }));

import { Route } from "../routes/api/v1/account/balance";

type Get = (a: { request: Request }) => Promise<Response>;
const GET = (Route as unknown as { options: { server: { handlers: { GET: Get } } } }).options.server
  .handlers.GET;

async function balance(query = "", key = h.world!.keys.a) {
  const res = await GET({
    request: new Request(`https://aidwar.in/api/v1/account/balance${query}`, {
      headers: { authorization: `Bearer ${key}` },
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The pricing source: a rate per (country, category), as client_rate_for answers. */
const RATES: Record<string, Record<string, number>> = {
  IN: { marketing: 0.9412, utility: 0.15, authentication: 0.15, service: 0 },
  AE: { marketing: 3.2, utility: 1.4, authentication: 1.4, service: 0 },
};
const asked: Array<Record<string, unknown>> = [];

beforeEach(() => {
  resetDialCodeCache();
  asked.length = 0;
  h.world = publicApiWorld({ balance: 100 });
  const w = h.world;
  w.db
    .rows("message_rates")
    .push({ dial_code: "91", country_code: "IN" }, { dial_code: "971", country_code: "AE" });
  const rpc = w.db.supabase.rpc.bind(w.db.supabase);
  (w.db.supabase as unknown as { rpc: unknown }).rpc = (
    name: string,
    args: Record<string, unknown>,
  ) => {
    if (name !== "client_rate_for") return rpc(name, args);
    asked.push(args);
    const rate = RATES[String(args["p_country"])]?.[String(args["p_category"])] ?? null;
    return Promise.resolve({ data: [{ rate, currency: "INR" }], error: null });
  };
});
afterEach(() => vi.restoreAllMocks());

/** wallet_apply, as the database does it: one ledger row and the wallet moved together. */
function apply(amount: number, entry: string) {
  const w = h.world!;
  const wallet = w.db.rows("wallet_balances").find((b) => b["organization_id"] === ORG)!;
  const after = Math.round((Number(wallet["balance"]) + amount) * 10_000) / 10_000;
  wallet["balance"] = after;
  w.db.rows("wallet_ledger").push({
    organization_id: ORG,
    entry_type: entry,
    amount,
    balance_after: after,
    created_at: new Date().toISOString(),
  });
}

describe("GET /api/v1/account/balance", () => {
  it("the balance is what the wallet ledger left; available = balance + overdraft − held", async () => {
    apply(500, "credit_purchase");
    apply(-0.15, "debit_message");
    apply(-0.9412, "debit_message");
    const w = h.world!;
    w.db.rows("wallet_balances")[0]!["held"] = 25;
    w.db.rows("organization_billing_settings")[0]!["overdraft_limit"] = 50;

    const res = await balance();
    expect(res.status).toBe(200);
    const ledger = w.db.rows("wallet_ledger");
    const lastAfter = Number(ledger.at(-1)!["balance_after"]);
    const sum = 100 + ledger.reduce((s, r) => s + Number(r["amount"]), 0);
    expect(res.body["balance"]).toBe(Math.round(lastAfter * 100) / 100);
    expect(res.body["balance"]).toBe(Math.round(sum * 100) / 100);
    expect(res.body).toMatchObject({
      balance: 598.91,
      held: 25,
      available: 623.91,
      currency: "INR",
      billing_enabled: true,
      country: "IN",
    });
  });

  it("prices per category from the pricing source, for a country or a customer's number", async () => {
    const india = await balance();
    expect(india.body["prices"]).toEqual([
      { category: "marketing", price: 0.9412, currency: "INR" },
      { category: "utility", price: 0.15, currency: "INR" },
      { category: "authentication", price: 0.15, currency: "INR" },
      { category: "service", price: 0, currency: "INR" },
    ]);
    expect(asked.every((a) => a["p_org"] === ORG)).toBe(true);
    const uae = await balance("?to=%2B971501234567");
    expect(uae.body).toMatchObject({ country: "AE" });
    expect((uae.body["prices"] as Array<{ price: number }>)[0]!.price).toBe(3.2);
    expect((await balance("?country=ae")).body["country"]).toBe("AE");
    expect((await balance("?country=India")).body["code"]).toBe("invalid_filter");
  });

  it("only the key's own workspace", async () => {
    const other = await balance("", h.world!.keys.b);
    expect(other.status).toBe(200);
    expect(other.body["balance"]).toBe(0);
    expect(asked.some((a) => a["p_org"] === "org-b")).toBe(true);
    expect(asked.some((a) => a["p_org"] === ORG)).toBe(false);
  });
});
