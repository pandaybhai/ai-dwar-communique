import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeFetch, metaRoutes, ORG, OTHER_ORG, PDF } from "./test-support/public-api-world";
import { batch38World } from "./test-support/batch38-world";
import { clearSafeFetchDnsCache } from "./safe-fetch.server";
import { resetDialCodeCache } from "./public-api-send.server";
import { forgetWorkspacePlans } from "./public-api-plans.server";
import {
  CONSOLE_TTL_MS,
  consoleCredential,
  forgetConsoleCredentials,
} from "./public-api-console.server";
import { authenticateApiKey, listApiKeys } from "./public-api.server";

/**
 * Batch 38 item 7 — the Try-it console. A real call through the same
 * /api/v1 handlers, with a credential minted for one workspace and one
 * member: stored as a sha256 only, never in any answer, dead after 10
 * minutes, unusable for another workspace, rate-limited like a key, and its
 * sends charged and labelled like API sends (metadata.source "api_console").
 */

const h = vi.hoisted(() => ({
  world: null as null | ReturnType<typeof import("./test-support/batch38-world").batch38World>,
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.world!.db.supabase }));

import { Route as ConsoleRoute } from "../routes/api/developer/console";

const rows = (t: string) => h.world!.db.rows(t);
const B64 = Buffer.from(PDF).toString("base64");

async function consoleCall(user: string, action: "call" | "quote", body: Record<string, unknown>) {
  const handler = (
    ConsoleRoute as unknown as {
      options: { server: { handlers: { POST: (a: { request: Request }) => Promise<Response> } } };
    }
  ).options.server.handlers.POST;
  const res = await handler({
    request: new Request("https://aidwar.in/api/developer/console", {
      method: "POST",
      headers: { authorization: `Bearer ${user}`, "content-type": "application/json" },
      body: JSON.stringify({ organization_id: ORG, action, ...body }),
    }),
  });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
}

const send = (over: Record<string, unknown> = {}, user = "u-admin") =>
  consoleCall(user, "call", {
    endpoint: "send_template",
    body: {
      to: "+91 98765 43210",
      template_name: "invoice_ready",
      document: { base64: B64, filename: "INV-1.pdf" },
      body_params: ["Asha", "INV-1", "INR 10"],
      ...over,
    },
  });

let net: ReturnType<typeof fakeFetch>;
beforeEach(() => {
  h.world = batch38World();
  forgetWorkspacePlans();
  forgetConsoleCredentials();
  clearSafeFetchDnsCache();
  resetDialCodeCache();
  net = fakeFetch([metaRoutes({})]);
  vi.stubGlobal("fetch", net.impl);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a real send through the console", () => {
  it("goes through the same handler: a template message to Meta, labelled api_console, charged like an API send", async () => {
    const res = await send();
    expect(res.status).toBe(200);
    const response = res.body["response"] as { status: number; body: Record<string, unknown> };
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ status: "queued" });
    expect(net.calls.filter((c) => c.url.endsWith("/messages"))).toHaveLength(1);

    const [message] = rows("messages");
    expect(message).toMatchObject({
      organization_id: ORG,
      type: "template",
      template_name: "invoice_ready",
    });
    expect(message!["metadata"]).toMatchObject({ source: "api_console" });
    expect(
      rows("activity_log").find((a) => a["action"] === "message_sent")?.["details"],
    ).toMatchObject({
      source: "api_console",
    });

    // The status poll reads it through the status handler.
    const poll = await consoleCall("u-admin", "call", {
      endpoint: "message_status",
      message_id: response.body["message_id"],
    });
    expect((poll.body["response"] as { status: number }).status).toBe(200);
    expect((poll.body["response"] as { body: Record<string, unknown> }).body).toMatchObject({
      message_id: response.body["message_id"],
      status: "queued",
    });

    // The request is shown as curl with the credential masked and the file shortened.
    const curl = String((res.body["request"] as Record<string, unknown>)["curl"]);
    expect(curl).toContain("POST https://aidwar.in/api/v1/messages/template");
    expect(curl).toContain("Bearer adw_console_••••••••");
    expect(curl).toContain("KB of base64");
    expect(curl).not.toContain(B64);
  });

  it("its statuses reach the merchant's webhook queue like any API send's", async () => {
    const { queueApiStatus } = await import("./public-api-webhooks.server");
    const queued = await queueApiStatus(h.world!.db.supabase, {
      organizationId: ORG,
      messageId: "m-console",
      status: "delivered",
      at: "2026-10-28T10:00:00Z",
      metadata: { source: "api_console", to: "+919876543210" },
      errorDetail: null,
    });
    expect(queued).toBeNull();
    expect(rows("api_webhook_deliveries")).toEqual([
      expect.objectContaining({ message_id: "m-console", event: "message.delivered" }),
    ]);
  });

  it("the same credit check as an API key: no credits, nothing sent (402 in the response)", async () => {
    rows("wallet_balances")[0]!["balance"] = 0;
    const res = await send();
    const response = res.body["response"] as { status: number; body: Record<string, unknown> };
    expect(response.status).toBe(402);
    expect(response.body["code"]).toBe("insufficient_credits");
    expect(net.calls.filter((c) => c.url.startsWith("https://graph.facebook.com/"))).toHaveLength(
      0,
    );
  });

  it("shows the cost first: the template's category at the customer's rate, nothing sent", async () => {
    const res = await consoleCall("u-admin", "quote", {
      template_name: "invoice_ready",
      to: "+919876543210",
    });
    expect(res.body).toMatchObject({
      ok: true,
      billed: true,
      category: "utility",
      rate: 0.15,
      covers: true,
    });
    expect(rows("messages")).toHaveLength(0);
  });

  it("never takes an idempotency key (that record belongs to a real API key)", async () => {
    const res = await send({ idempotency_key: "try-1" });
    expect((res.body["response"] as { status: number }).status).toBe(202);
    expect(rows("api_requests")).toHaveLength(0);
  });
});

describe("the credential", () => {
  it("is stored only as its sha256 and is in no answer; it isn't an API key and isn't listed with them", async () => {
    const res = await send();
    expect(res.text).not.toMatch(/adw_console_[A-Za-z0-9_-]{43}/);
    const creds = rows("api_console_credentials");
    expect(creds).toHaveLength(1);
    expect(creds[0]).toMatchObject({ organization_id: ORG, created_by: "u-admin" });
    expect(String(creds[0]!["token_hash"])).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(creds)).not.toMatch(/adw_console_/);
    expect((await listApiKeys(h.world!.db.supabase, ORG)).map((k) => k.id)).toEqual([
      "key-a",
      "key-r",
    ]);
    // One console session is one credential.
    await send();
    expect(rows("api_console_credentials")).toHaveLength(1);
  });

  it("expires after 10 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-28T10:00:00Z"));
    const { token } = await consoleCredential(h.world!.db.supabase, {
      organizationId: ORG,
      userId: "u-admin",
    });
    const ask = () =>
      authenticateApiKey(
        h.world!.db.supabase,
        new Request("https://aidwar.in/api/v1/messages/x", {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
    const caller = await ask();
    expect(caller).toMatchObject({ organizationId: ORG, source: "api_console" });
    vi.setSystemTime(new Date(Date.parse("2026-10-28T10:00:00Z") + CONSOLE_TTL_MS + 1000));
    const late = await ask();
    expect(late).toBeInstanceOf(Response);
    expect((late as Response).status).toBe(401);
    // The console mints a fresh one rather than reuse it.
    await send();
    expect(rows("api_console_credentials")).toHaveLength(2);
  });

  it("is scoped to its workspace: another workspace's message is a 404, and no member reaches another workspace", async () => {
    rows("messages").push({
      id: "msg-b",
      organization_id: OTHER_ORG,
      type: "template",
      status: "delivered",
      metadata: { source: "api" },
      created_at: "2026-10-27T00:00:00Z",
    });
    const res = await consoleCall("u-admin", "call", {
      endpoint: "message_status",
      message_id: "msg-b",
    });
    expect((res.body["response"] as { status: number }).status).toBe(404);
    const other = await consoleCall("u-admin", "call", {
      organization_id: OTHER_ORG,
      endpoint: "message_status",
      message_id: "msg-b",
    });
    expect(other.status).toBe(403);
  });

  it("dies with its member's right to manage the API", async () => {
    const { token } = await consoleCredential(h.world!.db.supabase, {
      organizationId: ORG,
      userId: "u-admin",
    });
    rows("organization_members").find((m) => m["user_id"] === "u-admin")!["role"] = "agent";
    const res = await authenticateApiKey(
      h.world!.db.supabase,
      new Request("https://aidwar.in/api/v1/messages/x", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect((res as Response).status).toBe(401);
  });

  it("only owners and admins with public_api on may open the console", async () => {
    expect((await send({}, "u-agent")).status).toBe(403);
    h.world!.flags.on = false;
    expect((await send()).status).toBe(403);
    expect(rows("api_console_credentials")).toHaveLength(0);
  });

  it("is rate-limited like a key: 60 calls a minute per member", async () => {
    for (let i = 0; i < 60; i += 1) {
      const r = await consoleCall("u-admin", "call", {
        endpoint: "message_status",
        message_id: "m1",
      });
      expect(r.status).toBe(200);
    }
    const over = await consoleCall("u-admin", "call", {
      endpoint: "message_status",
      message_id: "m1",
    });
    expect(over.status).toBe(429);
    expect(over.body["code"]).toBe("rate_limited");
  });
});
