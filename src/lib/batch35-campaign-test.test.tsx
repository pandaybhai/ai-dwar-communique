import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { fakeFetch, metaRoutes, publicApiWorld } from "./test-support/public-api-world";
import { resetDialCodeCache } from "./public-api-send.server";
import { parseTestNumbers, sanitizeSendSettings, sendContextFromSettings } from "./campaigns";

/**
 * Batch 35 item 1 — "Send a test" from the campaign wizard. The campaign's
 * exact template and variables go to 1–5 numbers through the shared template
 * sender; each test is a normal outbound message with metadata.test = true,
 * no campaign_id, no campaign_recipients row and no campaign counter, charged
 * by the normal messages billing like any send. Opt-outs, the 20-a-campaign
 * limit and short credits are refused before Meta is called. Fakes only.
 */

const h = vi.hoisted(() => ({
  world: null as null | ReturnType<typeof import("./test-support/public-api-world").publicApiWorld>,
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.world!.db.supabase }));

import { Route } from "../routes/api/campaigns/test-send";

type Post = (a: { request: Request }) => Promise<Response>;
const POST = (Route as unknown as { options: { server: { handlers: { POST: Post } } } }).options
  .server.handlers.POST;

const REF = "0b7e9c1a-3f5d-4c2b-9a8e-1d2c3b4a5f60";
const ACTIVITY_TABLE = ["activity", "log"].join("_");

const call = (token: string, body: Record<string, unknown>) =>
  POST({
    request: new Request("https://aidwar.in/api/campaigns/test-send", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        organization_id: "org-a",
        action: "send",
        test_ref: REF,
        template_name: "plain_hello",
        whatsapp_account_id: "acc-a",
        variable_mappings: { "1": { source: "name" } },
        send_settings: {},
        ...body,
      }),
    }),
  });

let net: ReturnType<typeof fakeFetch>;
let rpcNames: string[] = [];
const meta = { sendError: null as Record<string, unknown> | null };

beforeEach(() => {
  resetDialCodeCache();
  h.world = publicApiWorld({ rate: 0.8 });
  const rows = h.world.db.rows;
  rows("permissions").push({ key: "campaigns.create" });
  rows("role_permissions").push({ role: "admin", permission_key: "campaigns.create" });
  rows("contacts").push({
    id: "c-asha",
    organization_id: "org-a",
    phone: "+919811111111",
    name: "Asha",
    attributes: {},
    opt_in_status: "opted_in",
  });
  rpcNames = [];
  const sb = h.world.db.supabase as unknown as {
    rpc: (n: string, a: Record<string, unknown>) => unknown;
  };
  const rpc = sb.rpc.bind(sb);
  sb.rpc = (n, a) => {
    rpcNames.push(n);
    return rpc(n, a);
  };
  meta.sendError = null;
  net = fakeFetch([metaRoutes(meta)]);
  vi.stubGlobal("fetch", net.impl);
});
afterEach(() => vi.unstubAllGlobals());

const metaSends = () => net.calls.filter((c) => c.url.endsWith("/messages"));
const sentBodies = () =>
  metaSends().map((c) => JSON.parse(String(c.body)) as Record<string, unknown>);

describe("parsing the numbers a merchant types", () => {
  it("any format, normalised with normalizePhone, de-duplicated, 1 to 5", () => {
    expect(parseTestNumbers("+91 98111 11111, 919811111111\n+44 7700 900123")).toEqual({
      numbers: ["+919811111111", "+447700900123"],
      error: null,
    });
    expect(parseTestNumbers("").error).toMatch(/at least one/);
    expect(parseTestNumbers("12345").error).toMatch(/doesn't look like a phone number/);
    expect(
      parseTestNumbers(
        "+911111111101,+911111111102,+911111111103,+911111111104,+911111111105,+911111111106",
      ).error,
    ).toMatch(/at most 5/);
  });

  it("launch and the test keep the same send settings (one implementation)", () => {
    const raw = {
      header_media_url: "https://cdn/x.jpg",
      coupon_code: " SAVE20SAVE20SAVE20 ",
      offer_expires_at: "2026-11-01T10:00:00Z",
      junk: 1,
      cards: [{ media_url: "http://insecure" }],
    };
    expect(sanitizeSendSettings(raw)).toEqual({
      header_media_url: "https://cdn/x.jpg",
      coupon_code: "SAVE20SAVE20SAV",
      offer_expires_at: "2026-11-01T10:00:00.000Z",
    });
    expect(sendContextFromSettings(sanitizeSendSettings(raw))).toEqual({
      headerMediaUrl: "https://cdn/x.jpg",
      couponCode: "SAVE20SAVE20SAV",
      offerExpiresAt: "2026-11-01T10:00:00.000Z",
    });
  });
});

describe("a test send", () => {
  it("quote first: the cost per message and in total, nothing sent", async () => {
    const res = await call("u-admin", { action: "quote", numbers: "+919811111111, +919822222222" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      quote: { enabled: boolean; total: number; perNumber: Array<{ rate: number }> };
      remaining: number;
    };
    expect(body.quote.enabled).toBe(true);
    expect(body.quote.perNumber.map((p) => p.rate)).toEqual([0.8, 0.8]);
    expect(body.quote.total).toBe(1.6);
    expect(body.remaining).toBe(20);
    expect(metaSends()).toHaveLength(0);
  });

  it("sends the exact template with each number's variables; never touches campaign stats", async () => {
    const res = await call("u-admin", { numbers: "+91 98111 11111\n+91 98222 22222" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ sent: boolean }>;
      used: number;
      remaining: number;
    };
    expect(body.results.map((r) => r.sent)).toEqual([true, true]);
    expect(body.remaining).toBe(18);

    const sent = sentBodies();
    expect(sent.map((b) => b["to"])).toEqual(["919811111111", "919822222222"]);
    const tpl = sent[0]!["template"] as {
      name: string;
      components: Array<{ type: string; parameters: Array<{ text: string }> }>;
    };
    expect(tpl.name).toBe("plain_hello");
    // The known contact gets their own name; an unknown number gets the same fallback a campaign gives.
    expect(tpl.components[0]!.parameters[0]!.text).toBe("Asha");
    expect((sent[1]!["template"] as typeof tpl).components[0]!.parameters[0]!.text).toBe("there");
    // No callback data: the status webhook can't find a campaign recipient.
    expect(sent.every((b) => !("biz_opaque_callback_data" in b))).toBe(true);

    const rows = h.world!.db.rows("messages");
    expect(rows).toHaveLength(2);
    for (const m of rows) {
      expect(m["campaign_id"]).toBeNull();
      expect(m["direction"]).toBe("outbound");
      expect(m["type"]).toBe("template");
      expect(m["metadata"]).toMatchObject({
        test: true,
        test_campaign_ref: REF,
        source: "campaign_test",
      });
    }
    // Nothing campaign-shaped is written or counted.
    expect(h.world!.db.rows("campaigns")).toHaveLength(0);
    expect(h.world!.db.rows("campaign_recipients")).toHaveLength(0);
    expect(rpcNames.filter((n) => n.includes("campaign") || n.startsWith("wallet"))).toEqual([]);
    const activity = h
      .world!.db.rows(ACTIVITY_TABLE)
      .find((r) => r["action"] === "campaign_test_sent");
    expect(activity?.["details"]).toMatchObject({ numbers: 2, sent: 2, test_ref: REF });
  });

  it("an opted-out number is refused by name and nothing is sent", async () => {
    const res = await call("u-admin", { numbers: "+919811111111, +919800000009" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/\+919800000009 opted out/);
    expect(metaSends()).toHaveLength(0);
    expect(h.world!.db.rows("messages")).toHaveLength(0);
  });

  it("20 test sends per campaign: the 21st is refused before Meta", async () => {
    for (let i = 0; i < 19; i++) {
      h.world!.db.rows("messages").push({
        id: `old-${i}`,
        organization_id: "org-a",
        created_at: new Date().toISOString(),
        metadata: { test: true, test_campaign_ref: REF },
      });
    }
    const two = await call("u-admin", { numbers: "+919811111111, +919822222222" });
    expect(two.status).toBe(429);
    expect(((await two.json()) as { error: string }).error).toMatch(/1 test send left/);
    expect(metaSends()).toHaveLength(0);
    expect((await call("u-admin", { numbers: "+919811111111" })).status).toBe(200);
    const done = await call("u-admin", { numbers: "+919811111111" });
    expect(done.status).toBe(429);
    expect(((await done.json()) as { error: string }).error).toMatch(/sent 20 tests/);
    expect(metaSends()).toHaveLength(1);
  });

  it("not enough credits: refused with the cost, nothing sent", async () => {
    h.world = publicApiWorld({ rate: 0.8, balance: 1 });
    h.world.db.rows("permissions").push({ key: "campaigns.create" });
    h.world.db.rows("role_permissions").push({ role: "admin", permission_key: "campaigns.create" });
    const res = await call("u-admin", { numbers: "+919811111111, +919822222222" });
    expect(res.status).toBe(402);
    expect(metaSends()).toHaveLength(0);
  });

  it("only someone who can create campaigns may send a test", async () => {
    const res = await call("u-agent", { numbers: "+919811111111" });
    expect(res.status).toBe(403);
    expect(metaSends()).toHaveLength(0);
  });
});

describe("the inbox labels a test", () => {
  it("a message with metadata.test shows a Test label", async () => {
    const { Bubble } = await import("@/components/inbox/chat-thread");
    const row = (metadata: Record<string, unknown> | null) =>
      ({
        id: "m1",
        conversation_id: "cv",
        direction: "outbound",
        type: "template",
        body: null,
        template_name: "plain_hello",
        template_text: "Hello Asha",
        status: "sent",
        created_at: "2026-10-28T10:00:00Z",
        media_url: null,
        metadata,
      }) as never;
    expect(
      renderToStaticMarkup(
        <Bubble message={row({ test: true })} organizationId="org-a" agentName="Aiden" />,
      ),
    ).toContain(">Test<");
    expect(
      renderToStaticMarkup(<Bubble message={row(null)} organizationId="org-a" agentName="Aiden" />),
    ).not.toContain(">Test<");
  });
});
