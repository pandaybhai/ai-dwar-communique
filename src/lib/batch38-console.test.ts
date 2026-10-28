import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeFetch, metaRoutes, ORG, OTHER_ORG, PDF } from "./test-support/public-api-world";
import { batch38World } from "./test-support/batch38-world";
import { clearSafeFetchDnsCache } from "./safe-fetch.server";
import { resetDialCodeCache } from "./public-api-send.server";
import { forgetWorkspacePlans } from "./public-api-plans.server";
import {
  CONSOLE_TTL_MS,
  consoleBody,
  consoleCredential,
  consoleQuery,
  forgetConsoleCredentials,
} from "./public-api-console.server";
import {
  CONSOLE_ENDPOINTS,
  CONSOLE_ENDPOINT_IDS,
  consoleEndpointFor,
  consoleFieldNames,
  tryItHref,
} from "./public-api-console";
import { API_ENDPOINTS } from "./public-api-spec";
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

describe("the other endpoints (session send, contacts, templates, balance)", () => {
  /** A customer who wrote an hour ago: their 24-hour window is open. */
  function customerWrote() {
    rows("conversations").push({
      id: "conv-c1",
      organization_id: ORG,
      contact_id: "c1",
      whatsapp_account_id: "acc-a",
      status: "open",
      last_customer_message_at: new Date(Date.now() - 3600_000).toISOString(),
    });
  }
  const response = (r: { body: Record<string, unknown> }) =>
    r.body["response"] as { status: number; body: Record<string, unknown> };
  const request = (r: { body: Record<string, unknown> }) =>
    r.body["request"] as { method: string; path: string; curl: string };

  it("every console endpoint is a spec endpoint with the same method and path, and the docs' Try it opens it", () => {
    for (const id of CONSOLE_ENDPOINT_IDS) {
      const c = CONSOLE_ENDPOINTS[id];
      const e = API_ENDPOINTS.find((x) => x.id === c.spec);
      expect(e, id).toBeDefined();
      expect([e!.method, e!.path], id).toEqual([c.method, c.path]);
      expect(consoleEndpointFor(c.spec)).toBe(id);
      expect(tryItHref(c.spec)).toBe(`/app/settings?tab=api&try=${c.spec}#try-it`);
    }
    expect(consoleEndpointFor("campaign-create")).toBeNull();
  });

  it("passes on only the endpoint's own fields and filters, never an idempotency key", () => {
    expect(consoleFieldNames("send_session", "body")).toEqual(
      expect.arrayContaining(["to", "type", "text", "image", "document", "buttons", "sections"]),
    );
    expect(
      consoleBody("send_session", {
        to: "+91",
        type: "text",
        text: "Hi",
        idempotency_key: "k",
        api_key: "x",
      }),
    ).toEqual({ to: "+91", type: "text", text: "Hi" });
    expect(
      consoleBody("contact_upsert", {
        phone: "+91",
        name: "A",
        tags: ["vip"],
        opted_in: true,
        organization_id: OTHER_ORG,
      }),
    ).toEqual({ phone: "+91", name: "A", tags: ["vip"], opted_in: true });
    expect(
      consoleQuery("contacts_list", {
        tag: " vip ",
        limit: "5",
        opt_in: "",
        organization_id: OTHER_ORG,
      }),
    ).toBe("?limit=5&tag=vip");
    expect(consoleQuery("templates_list", {})).toBe("");
    expect(consoleQuery("account_balance", { country: "IN" })).toBe("?country=IN");
  });

  it("a free-form message inside the window: sent through the session handler, labelled api_console", async () => {
    customerWrote();
    const res = await consoleCall("u-admin", "call", {
      endpoint: "send_session",
      body: { to: "+919800000001", type: "text", text: "Hi *Asha*", idempotency_key: "never-used" },
    });
    expect(res.status).toBe(200);
    expect(response(res).status).toBe(202);
    expect(net.calls.filter((c) => c.url.endsWith("/messages"))).toHaveLength(1);
    const message = rows("messages").find((m) => m["id"] === response(res).body["message_id"])!;
    expect(message["metadata"]).toMatchObject({ source: "api_console" });
    expect(request(res).curl).toContain("POST https://aidwar.in/api/v1/messages/session");
    expect(request(res).curl).not.toContain("never-used");
    expect(rows("api_requests")).toHaveLength(0);
  });

  it("outside the window: 409 window_closed, nothing sent", async () => {
    const res = await consoleCall("u-admin", "call", {
      endpoint: "send_session",
      body: { to: "+919800000001", type: "text", text: "Hi" },
    });
    expect([response(res).status, response(res).body["code"]]).toEqual([409, "window_closed"]);
    expect(net.calls.filter((c) => c.url.endsWith("/messages"))).toHaveLength(0);
  });

  it("creates a contact, then finds it in the list by its tag — only this workspace's", async () => {
    const created = await consoleCall("u-admin", "call", {
      endpoint: "contact_upsert",
      body: { phone: "+91 98111 22233", name: "Ravi", tags: ["console-test"] },
    });
    expect(response(created).status).toBeLessThan(300);
    expect(rows("contacts").find((c) => c["phone"] === "+919811122233")).toMatchObject({
      organization_id: ORG,
      name: "Ravi",
    });
    const listed = await consoleCall("u-admin", "call", {
      endpoint: "contacts_list",
      query: { tag: "console-test" },
    });
    expect(request(listed).path).toBe("/api/v1/contacts?tag=console-test");
    expect(request(listed).curl).toContain('"https://aidwar.in/api/v1/contacts?tag=console-test"');
    const data = response(listed).body["data"] as Array<Record<string, unknown>>;
    expect(data.map((c) => c["phone"])).toEqual(["+919811122233"]);
  });

  it("lists templates and shows the wallet through their own handlers", async () => {
    const templates = await consoleCall("u-admin", "call", {
      endpoint: "templates_list",
      query: { status: "APPROVED" },
    });
    expect(response(templates).status).toBe(200);
    const names = (response(templates).body["data"] as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("invoice_ready");
    const balance = await consoleCall("u-admin", "call", {
      endpoint: "account_balance",
      query: {},
    });
    expect(response(balance).status).toBe(200);
    expect(request(balance).method).toBe("GET");
  });
});
