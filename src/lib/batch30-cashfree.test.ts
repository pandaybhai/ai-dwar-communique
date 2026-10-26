import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  createPaymentLink,
  platformPaymentProvider,
  verifyWebhookSignature,
} from "@/lib/cashfree.server";

/**
 * Batch 30 — Cashfree cutover. Locks the rules that keep the money path safe
 * while Cashfree sits alongside Razorpay:
 *  - webhook signatures are verified exactly as Cashfree documents them;
 *  - a workspace pays through Cashfree ONLY when its cashfree_billing flag is
 *    on AND keys exist — every other workspace stays on Razorpay untouched;
 *  - the payment link payload carries our payment id in link_notes so the
 *    webhook can settle it.
 */

const SECRET = "whsec_test_secret";
const sign = (ts: string, body: string) =>
  createHmac("sha256", SECRET).update(`${ts}${body}`, "utf8").digest("base64");

describe("cashfree webhook signature", () => {
  const ts = "1730000000";
  const body = JSON.stringify({ type: "PAYMENT_LINK_EVENT", data: { link_status: "PAID" } });

  it("accepts a valid signature", () => {
    expect(verifyWebhookSignature(ts, body, sign(ts, body), SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const tampered = body.replace("PAID", "PARTIALLY_PAID");
    expect(verifyWebhookSignature(ts, tampered, sign(ts, body), SECRET)).toBe(false);
  });

  it("rejects a signature made with another secret", () => {
    const foreign = createHmac("sha256", "other_secret").update(`${ts}${body}`, "utf8").digest("base64");
    expect(verifyWebhookSignature(ts, body, foreign, SECRET)).toBe(false);
  });

  it("rejects an empty or missing signature", () => {
    expect(verifyWebhookSignature(ts, body, "", SECRET)).toBe(false);
  });
});

describe("platformPaymentProvider", () => {
  beforeEach(() => {
    delete process.env["CASHFREE_CLIENT_ID"];
    delete process.env["CASHFREE_CLIENT_SECRET"];
    delete process.env["CASHFREE_ENV"];
  });

  // Minimal supabase stub: org_flag_enabled answers the flag, read_vault_secret
  // answers the platform keys.
  const supa = (flag: boolean, keysInVault: boolean) =>
    ({
      rpc: (name: string) =>
        Promise.resolve({
          data: name === "org_flag_enabled" ? flag : keysInVault ? "value" : null,
          error: null,
        }),
    }) as never;

  it("keeps Razorpay when the flag is off, even with Cashfree keys present", async () => {
    expect(await platformPaymentProvider(supa(false, true), "org-1")).toBe("razorpay");
  });

  it("uses Cashfree only when the flag is on AND keys exist", async () => {
    expect(await platformPaymentProvider(supa(true, true), "org-1")).toBe("cashfree");
  });

  it("keeps Razorpay when the flag is on but no keys are configured", async () => {
    expect(await platformPaymentProvider(supa(true, false), "org-1")).toBe("razorpay");
  });
});

describe("cashfree payment link", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          cf_link_id: 1576977,
          link_id: "pay_123",
          link_url: "https://payments-test.cashfree.com/links/U1mgll3c0e9g",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  const keys = { clientId: "cf_client_id", clientSecret: "cf_client_secret", env: "sandbox" as const };

  it("posts the documented payload to the sandbox host", async () => {
    const { link, error } = await createPaymentLink(keys, {
      amount: 118,
      currency: "INR",
      description: "Starter credits for Acme",
      reference: "b1c2d3e4-0000-4000-8000-0000000000aa",
      customer: { name: "Acme", email: "a@acme.in", contact: "+91 98765 43210" },
      callbackUrl: "https://aidwar.in/app/billing?payment=x",
      notifyUrl: "https://aidwar.in/api/public/cashfree-webhook",
      notes: { organization_id: "org-1", payment_id: "b1c2d3e4" },
      expireBy: 2_000_000_000,
    });
    expect(error).toBeNull();
    expect(link?.id).toBe("1576977");
    expect(link?.short_url).toContain("https://");

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://sandbox.cashfree.com/pg/links");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-client-id"]).toBe("cf_client_id");
    expect(headers["x-client-secret"]).toBe("cf_client_secret");

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body["link_amount"]).toBe(118);
    expect(body["link_id"]).toBe("b1c2d3e4-0000-4000-8000-0000000000aa");
    expect((body["link_notes"] as Record<string, string>)["payment_id"]).toBe("b1c2d3e4");
    expect((body["link_meta"] as Record<string, string>)["notify_url"]).toBe(
      "https://aidwar.in/api/public/cashfree-webhook",
    );
    expect((body["customer_details"] as Record<string, string>)["customer_phone"]).toBe("9876543210");
  });

  it("uses the production host for production keys", async () => {
    await createPaymentLink(
      { ...keys, env: "production" },
      {
        amount: 10,
        currency: "INR",
        description: "x",
        reference: "ref_1",
        customer: {},
        notifyUrl: "https://aidwar.in/api/public/cashfree-webhook",
        notes: {},
      },
    );
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe("https://api.cashfree.com/pg/links");
  });

  it("surfaces the provider's refusal message", async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "link_amount should be >= 1" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    const { link, error } = await createPaymentLink(keys, {
      amount: 0,
      currency: "INR",
      description: "x",
      reference: "ref_2",
      customer: {},
      notifyUrl: "https://aidwar.in/api/public/cashfree-webhook",
      notes: {},
    });
    expect(link).toBeNull();
    expect(error).toContain("link_amount");
  });
});

describe("flow payment link provider choice", () => {
  afterEach(() => vi.restoreAllMocks());

  // Stubs workspace_connection_secret: cashfree and/or razorpay connections.
  const supa = (connections: Record<string, Record<string, string> | null>) =>
    ({
      rpc: (name: string, args: Record<string, string>) => {
        if (name !== "workspace_connection_secret") return Promise.resolve({ data: null, error: null });
        const secret = connections[String(args["p_provider"])];
        return Promise.resolve({
          data: secret
            ? [{ id: "c1", status: "active", public_config: {}, secret: JSON.stringify(secret) }]
            : [],
          error: null,
        });
      },
      from: () => ({ update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }),
    }) as never;

  it("prefers the workspace's Cashfree account when both are connected", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ cf_link_id: 42, link_url: "https://payments.cashfree.com/links/x" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const { createPaymentLink: flowLink } = await import("@/lib/flow-connections.server");
    const result = await flowLink(
      supa({
        cashfree: { client_id: "m_id", client_secret: "m_secret", webhook_secret: "w", env: "sandbox" },
        razorpay: { key_id: "rzp_live_x", key_secret: "s", webhook_secret: "w" },
      }),
      "org-1",
      { amountRupees: 500, description: "Order 1", name: "Rao", phone: "919876543210", expireHours: 24, runId: "run-1", nodeId: "node-1" },
    );
    expect("url" in result && result.url).toContain("cashfree");
    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toContain("sandbox.cashfree.com");
  });

  it("stays on Razorpay when only Razorpay is connected", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "plink_1", short_url: "https://rzp.io/l/x" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { createPaymentLink: flowLink } = await import("@/lib/flow-connections.server");
    const result = await flowLink(
      supa({ razorpay: { key_id: "rzp_live_x", key_secret: "s", webhook_secret: "w" } }),
      "org-1",
      { amountRupees: 500, description: "Order 1", name: "Rao", phone: "919876543210", expireHours: 24, runId: "run-1", nodeId: "node-1" },
    );
    expect("url" in result && result.url).toBe("https://rzp.io/l/x");
    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toContain("api.razorpay.com");
  });
});
