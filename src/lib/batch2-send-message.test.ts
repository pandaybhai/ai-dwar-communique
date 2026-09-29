import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./test-support/fake-db";

const h = vi.hoisted(() => ({
  db: null as null | { supabase: unknown },
  graphFetch: vi.fn(async () => ({
    ok: true,
    status: 200,
    body: { messages: [{ id: "wamid.1" }] },
  })),
}));
vi.mock("@/lib/whatsapp-api.server", () => ({
  requireOrgMember: async () => ({ supabase: h.db!.supabase, organizationId: "org", userId: "u1" }),
  requirePermission: async () => null,
  isResponse: (v: unknown) => v instanceof Response,
  jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
  graphFetch: h.graphFetch,
  graphErrorMessage: () => "error",
  logServerActivity: async () => {},
  providerErrorDetail: () => null,
  providerErrorCode: () => null,
  normalizePhone: (p: string) => `+${String(p).replace(/\D/g, "")}`,
  toWaId: (p: string) => String(p ?? "").replace(/\D/g, ""),
}));
vi.mock("@/lib/whatsapp-numbers.server", () => ({
  getWhatsAppConnection: async () => ({
    connection: { accountId: "acc", wabaId: "waba", phoneNumberId: "pn", accessToken: "t" },
    error: null,
  }),
}));
vi.mock("@/lib/events.server", () => {
  const noop = async () => {};
  return { emitEvent: noop, recordUsage: noop };
});

import { Route } from "../routes/api/whatsapp/send-message";

type Post = (a: { request: Request }) => Promise<Response>;
const post = (Route.options as unknown as { server: { handlers: { POST: Post } } }).server.handlers
  .POST;

async function send(optIn: string | null, body: Record<string, unknown>) {
  h.db = fakeDb((op) => {
    if (op.table === "contacts" && op.kind === "upsert") return { data: { id: "c1" }, error: null };
    if (op.table === "contacts")
      return optIn === "error"
        ? { data: null, error: { message: "down" } }
        : { data: { opt_in_status: optIn }, error: null };
    if (op.table === "conversations" && op.kind === "select")
      return {
        data: {
          id: "cv1",
          contact_id: "c1",
          whatsapp_account_id: "acc",
          last_customer_message_at: new Date().toISOString(),
        },
        error: null,
      };
    if (op.table === "messages") return { data: { id: "m1", status: "pending" }, error: null };
    return undefined;
  });
  return post({
    request: new Request("http://x", {
      method: "POST",
      body: JSON.stringify({ organization_id: "org", phone: "+919800000001", ...body }),
    }),
  });
}
const template = { message_type: "template", template_name: "promo" };

beforeEach(() => h.graphFetch.mockClear());

describe("(C) send-message: templates never go to an opted-out contact", () => {
  it("opted out: refused, nothing reaches Meta", async () => {
    const res = await send("opted_out", template);
    expect(res.status).toBe(422);
    expect(h.graphFetch).not.toHaveBeenCalled();
  });
  it("opt-out check failed: refused, nothing reaches Meta", async () => {
    expect((await send("error", template)).status).toBe(503);
    expect(h.graphFetch).not.toHaveBeenCalled();
  });
  it("unchanged: a template to a contact who hasn't opted out is sent", async () => {
    expect((await send("unknown", template)).status).toBe(200);
    expect(h.graphFetch).toHaveBeenCalledTimes(1);
  });
  it("unchanged: a text reply inside the service window is not blocked by the template check", async () => {
    expect((await send("opted_out", { message_type: "text", body: "hello" })).status).toBe(200);
    expect(h.graphFetch).toHaveBeenCalledTimes(1);
  });
});
