import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { fakeDb } from "./test-support/fake-db";
import { optedOutMayReceive } from "./opt-out";

/**
 * Batch 35 item 5 — the inbox can send an approved template any time: a
 * template button sits next to the composer while the 24-hour window is
 * open (the closed-window banner is unchanged). The picker shows the
 * template's price before sending. A contact who opted out never gets a
 * marketing template; utility and authentication still go.
 */

const h = vi.hoisted(() => ({
  db: null as null | { supabase: unknown },
  category: null as string | null,
  graphFetch: vi.fn(async () => ({
    ok: true,
    status: 200,
    body: { messages: [{ id: "wamid.1" }] },
  })),
}));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ can: () => true, reasonFor: () => null, loading: false }),
}));
vi.mock("@/hooks/use-feature-flag", () => ({
  useFeatureFlag: () => ({ enabled: false, loading: false }),
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

import { Route as SendRoute } from "../routes/api/whatsapp/send-message";
import { ChatThread } from "@/components/inbox/chat-thread";

type Post = (a: { request: Request }) => Promise<Response>;
const post = (r: unknown) =>
  (r as { options: { server: { handlers: { POST: Post } } } }).options.server.handlers.POST;

beforeEach(() => h.graphFetch.mockClear());

function thread(lastCustomerMessageAt: string | null) {
  return renderToStaticMarkup(
    <ChatThread
      conversation={
        {
          id: "cv1",
          status: "open",
          last_customer_message_at: lastCustomerMessageAt,
          contact: { id: "c1", name: "Asha", phone: "+919800000001", opt_in_status: "opted_in" },
        } as never
      }
      messages={[]}
      members={[]}
      loading={false}
      sending={false}
      onSend={async () => true}
      onSendTemplate={async () => true}
      organizationId="org"
      onBack={() => {}}
      onAssign={() => {}}
      onToggleStatus={() => {}}
    />,
  );
}

describe("the template button", () => {
  it("is next to the composer while the 24-hour window is open", () => {
    const html = thread(new Date().toISOString());
    expect(html).toContain("Write a message…");
    expect(html).toContain('aria-label="Send a template"');
  });

  it("unchanged when the window is closed: the banner and its Send a template button", () => {
    const html = thread(new Date(Date.now() - 2 * 86_400_000).toISOString());
    expect(html).toContain("Outside the 24-hour window — send a template instead.");
    expect(html).toContain("Send a template</button>");
    expect(html).not.toContain("Write a message…");
  });
});

async function sendTemplate(optIn: string, category: string | null) {
  h.db = fakeDb((op) => {
    if (op.table === "message_templates")
      return { data: category ? { category } : null, error: null };
    if (op.table === "contacts" && op.kind === "upsert") return { data: { id: "c1" }, error: null };
    if (op.table === "contacts") return { data: { opt_in_status: optIn }, error: null };
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
  return post(SendRoute)({
    request: new Request("http://x", {
      method: "POST",
      body: JSON.stringify({
        organization_id: "org",
        phone: "+919800000001",
        message_type: "template",
        template_name: "t",
      }),
    }),
  });
}

describe("opted-out contacts", () => {
  it("a marketing template is refused before Meta; utility and authentication go", async () => {
    const refused = await sendTemplate("opted_out", "MARKETING");
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toMatch(/opted out of marketing/);
    expect(h.graphFetch).not.toHaveBeenCalled();

    expect((await sendTemplate("opted_out", "UTILITY")).status).toBe(200);
    expect((await sendTemplate("opted_out", "AUTHENTICATION")).status).toBe(200);
    expect(h.graphFetch).toHaveBeenCalledTimes(2);
  });

  it("a template we can't place counts as marketing; a contact who didn't opt out gets any template", async () => {
    expect((await sendTemplate("opted_out", null)).status).toBe(422);
    expect((await sendTemplate("opted_in", "MARKETING")).status).toBe(200);
    expect(optedOutMayReceive("utility")).toBe(true);
    expect(optedOutMayReceive("MARKETING")).toBe(false);
    expect(optedOutMayReceive(undefined)).toBe(false);
  });
});

describe("the price before sending", () => {
  it("the picker asks for the picked template's price for this conversation", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const picker = readFileSync(
      join(import.meta.dirname, "../components/templates/template-picker-dialog.tsx"),
      "utf8",
    );
    expect(picker).toContain('"/api/whatsapp/template-price"');
    expect(picker).toMatch(/This \$\{price\.category\} template costs about/);
  });

  it("the price route answers the client rate for the template's category in the contact's country", async () => {
    const db = fakeDb(
      (op) => {
        if (op.table === "conversations")
          return {
            data: { id: "cv1", whatsapp_account_id: "acc", contacts: { phone: "+919800000001" } },
            error: null,
          };
        if (op.table === "message_templates") return { data: { category: "UTILITY" }, error: null };
        if (op.table === "message_rates")
          return { data: [{ dial_code: "91", country_code: "IN" }], error: null };
        if (op.table === "wallet_balances") return { data: { balance: 50, held: 0 }, error: null };
        if (op.table === "organization_billing_settings")
          return { data: { overdraft_limit: 0 }, error: null };
        return undefined;
      },
      (call) => {
        if (call.name === "org_flag_enabled") return { data: true, error: null };
        if (call.name === "client_rate_for")
          return { data: [{ rate: 0.125, currency: "INR" }], error: null };
        return undefined;
      },
    );
    h.db = db;
    const { Route } = await import("../routes/api/whatsapp/template-price");
    const res = await post(Route)({
      request: new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          organization_id: "org",
          conversation_id: "cv1",
          template_name: "order_update",
        }),
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: true,
      category: "utility",
      rate: 0.125,
      currency: "INR",
    });
    expect(db.rpcs.find((r) => r.name === "client_rate_for")?.args).toEqual({
      p_org: "org",
      p_country: "IN",
      p_category: "utility",
    });
  });
});
