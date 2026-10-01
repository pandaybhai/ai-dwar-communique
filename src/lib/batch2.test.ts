import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";

const mocks = vi.hoisted(() => ({
  billingEnabled: vi.fn(async () => true),
  sendCampaignTemplate: vi.fn(async () => ({ error: null, messageId: "msg-1" })),
  loadSenderContext: vi.fn(async () => ({
    accountId: "acc",
    wabaId: "waba",
    phoneNumberId: "pn",
    accessToken: "t",
  })),
  emitEvent: vi.fn(async () => {}),
}));
vi.mock("@/lib/billing.server", () => ({
  billingEnabled: mocks.billingEnabled,
  rateFor: async () => ({ rate: 1.04 }),
}));
vi.mock("@/lib/campaigns.server", () => ({
  sendCampaignTemplate: mocks.sendCampaignTemplate,
  loadSenderContext: mocks.loadSenderContext,
}));
vi.mock("@/lib/events.server", () => {
  const noop = async () => {};
  return { emitEvent: mocks.emitEvent, recordUsage: noop };
});
vi.mock("@/lib/whatsapp-numbers.server", () => ({
  ACCOUNT_COLUMNS: "id, organization_id, waba_id",
  getWhatsAppConnection: async () => ({ connection: null }),
  connectionForAccount: async () => ({ connection: null }),
}));
vi.mock("@/lib/service-text.server", () => ({ sendServiceText: async () => ({ ok: true }) }));

import { AI_TOOL_HANDLERS, type ToolContext } from "./ai-tools.server";
import { settleCampaignSpend } from "./campaign-billing.server";
import { contactOptedOut, importOptInPatch } from "./opt-out.server";
import { sendTemplate } from "./flow-engine.server";
import { toolSubject } from "./ai-run.server";
import {
  finishEvent,
  processWebhookPayload,
  webhookAttempts,
  WEBHOOK_MAX_ATTEMPTS,
} from "./whatsapp-webhook.server";

beforeEach(() => {
  mocks.billingEnabled.mockClear();
  mocks.billingEnabled.mockResolvedValue(true);
  mocks.sendCampaignTemplate.mockClear();
  mocks.emitEvent.mockClear();
});

const filterOf = (op: FakeOp, name: string) =>
  op.filters.filter(([n]) => n === name).map(([, a]) => a);

// ------------------------------------------------------------------ (A)
describe("(A) customer-chat AI tools only see the chat's own contact", () => {
  const ME = {
    id: "c-me",
    name: "Asha",
    phone: "+919800000001",
    wa_id: "919800000001",
    opt_in_status: "opted_in",
  };
  const OTHER = {
    id: "c-other",
    name: "Ravi",
    phone: "+919800000002",
    wa_id: "919800000002",
    opt_in_status: "opted_in",
  };
  const world = () =>
    fakeDb((op) => {
      if (op.table === "contacts") {
        const byId = filterOf(op, "eq").find(([col]) => col === "id");
        if (byId)
          return {
            data: byId[1] === ME.id ? ME : byId[1] === OTHER.id ? OTHER : null,
            error: null,
          };
        const or = String(filterOf(op, "or")[0]?.[0] ?? "");
        return {
          data: or.includes(OTHER.phone) ? OTHER : or.includes(ME.phone) ? ME : null,
          error: null,
        };
      }
      if (op.table === "conversations") return { data: [{ id: "cv-1" }], error: null };
      if (op.table === "orders")
        return { data: { id: "o-1", order_number: "#1001", contact_id: "c-x" }, error: null };
      if (op.table === "abandoned_checkouts") return { data: { id: "ab-1" }, error: null };
      return { data: [], error: null };
    });
  const ctx = (db: ReturnType<typeof world>, subject?: ToolContext["subject"]): ToolContext => ({
    supabase: db.supabase,
    organizationId: "org",
    actorUserId: null,
    initiatedBy: "ai",
    ...(subject ? { subject } : {}),
  });
  const chat = { contactId: ME.id, conversationId: "cv-1" };

  it("a phone that belongs to someone else finds nothing", async () => {
    const db = world();
    for (const tool of [
      "lookupContact",
      "searchConversationHistory",
      "getCustomerOrders",
      "getAbandonedCheckout",
    ]) {
      const r = await AI_TOOL_HANDLERS[tool]!(ctx(db, chat), { phone: OTHER.phone });
      expect(r.found, tool).toBe(false);
    }
    expect(
      db.ops.some(
        (o) => o.table === "orders" || o.table === "abandoned_checkouts" || o.table === "messages",
      ),
    ).toBe(false);
    expect(db.ops.some((o) => o.table === "contacts" && filterOf(o, "or").length > 0)).toBe(false);
  });

  it("the chat's own number (any format) and no number both resolve to the chat contact", async () => {
    const db = world();
    const own = await AI_TOOL_HANDLERS["lookupContact"]!(ctx(db, chat), {
      phone: "+91 98000 00001",
    });
    expect((own.data as { id: string }).id).toBe(ME.id);
    const bare = await AI_TOOL_HANDLERS["lookupContact"]!(ctx(db, chat), {});
    expect((bare.data as { id: string }).id).toBe(ME.id);
  });

  it("history is limited to the current conversation", async () => {
    const db = world();
    await AI_TOOL_HANDLERS["searchConversationHistory"]!(ctx(db, chat), {});
    const conv = db.ops.find((o) => o.table === "conversations")!;
    expect(db.has(conv, "eq", "id", "cv-1")).toBe(true);
    expect(db.has(conv, "eq", "contact_id", ME.id)).toBe(true);
  });

  it("an order number only opens the chat contact's order", async () => {
    const db = world();
    await AI_TOOL_HANDLERS["lookupOrder"]!(ctx(db, chat), { order_number: "1001" });
    const q = db.ops.find((o) => o.table === "orders")!;
    expect(db.has(q, "eq", "contact_id", ME.id)).toBe(true);
  });

  it("no contact on the chat: order and contact lookups find nothing", async () => {
    const db = world();
    const none = { contactId: null, conversationId: "cv-1" };
    expect(
      (await AI_TOOL_HANDLERS["lookupOrder"]!(ctx(db, none), { order_number: "1001" })).found,
    ).toBe(false);
    expect(
      (await AI_TOOL_HANDLERS["lookupContact"]!(ctx(db, none), { phone: ME.phone })).found,
    ).toBe(false);
    expect(db.ops.some((o) => o.table === "orders")).toBe(false);
  });

  it("unchanged: owner/member runs (no subject) keep workspace scope", async () => {
    const db = world();
    const other = await AI_TOOL_HANDLERS["lookupContact"]!(ctx(db), { phone: OTHER.phone });
    expect((other.data as { id: string }).id).toBe(OTHER.id);
    await AI_TOOL_HANDLERS["lookupOrder"]!(ctx(db), { order_number: "1001" });
    const q = db.ops.find((o) => o.table === "orders")!;
    expect(filterOf(q, "eq").some(([col]) => col === "contact_id")).toBe(false);
    expect((await AI_TOOL_HANDLERS["lookupContact"]!(ctx(db), {})).found).toBe(false);
  });
});

// ------------------------------------------------------------------ (B)
describe("(B) campaign money: charged once, from the ledger", () => {
  const campaign = {
    id: "camp",
    estimated_cost: 2.08,
    held_amount: 2.08,
    charged_amount: 0,
    sent_count: 2,
    template_name: "t",
  };
  const world = (
    opts: {
      debits?: number[];
      released?: boolean;
      rpcError?: string;
      ledgerError?: string;
      held?: number;
    } = {},
  ) =>
    fakeDb(
      (op) => {
        if (op.table === "campaigns" && op.kind === "select")
          return {
            data: { ...campaign, held_amount: opts.held ?? campaign.held_amount },
            error: null,
          };
        if (op.table === "wallet_ledger" && db_has(op, "entry_type", "debit_message"))
          return opts.ledgerError
            ? { data: null, error: { message: opts.ledgerError } }
            : { data: (opts.debits ?? []).map((a) => ({ amount: -a })), error: null };
        if (op.table === "wallet_ledger" && db_has(op, "entry_type", "hold_release"))
          return { data: opts.released ? [{ id: "l-1" }] : [], error: null };
        return undefined;
      },
      (call) =>
        call.name === "wallet_apply" && opts.rpcError
          ? { data: null, error: { message: opts.rpcError } }
          : undefined,
    );
  const db_has = (op: FakeOp, col: string, val: unknown) =>
    op.filters.some(([n, a]) => n === "eq" && a[0] === col && a[1] === val);
  const update = (db: ReturnType<typeof world>) =>
    db.ops.find((o) => o.table === "campaigns" && o.kind === "update");

  it("never posts a 'debit' row: releases only the unused hold, charged_amount comes from debit_message rows", async () => {
    const db = world({ debits: [1.04] });
    expect(await settleCampaignSpend(db.supabase, "org", "camp")).toEqual({ ok: true });
    expect(db.rpcs.map((r) => r.args["p_type"])).toEqual(["hold_release"]);
    expect(db.rpcs[0]!.args["p_amount"]).toBe(1.04);
    expect(update(db)!.payload).toEqual({
      held_amount: 0,
      charged_amount: 1.04,
      returned_amount: 1.04,
    });
  });

  it("nothing priced yet: the whole hold comes back and nothing is recorded as charged", async () => {
    const db = world({ debits: [] });
    await settleCampaignSpend(db.supabase, "org", "camp");
    expect(db.rpcs.map((r) => [r.args["p_type"], r.args["p_amount"]])).toEqual([
      ["hold_release", 2.08],
    ]);
    expect((update(db)!.payload as Record<string, number>)["charged_amount"]).toBe(0);
  });

  it("a failed ledger call never writes charged_amount", async () => {
    const db = world({ debits: [1.04], rpcError: "INSUFFICIENT_CREDITS" });
    const r = await settleCampaignSpend(db.supabase, "org", "camp");
    expect(r.ok).toBe(false);
    expect(update(db)).toBeUndefined();
  });

  it("a failed ledger read never writes charged_amount", async () => {
    const db = world({ ledgerError: "timeout" });
    expect((await settleCampaignSpend(db.supabase, "org", "camp")).ok).toBe(false);
    expect(db.rpcs).toEqual([]);
    expect(update(db)).toBeUndefined();
  });

  it("a release that already landed is never repeated", async () => {
    const db = world({ debits: [1.04], released: true });
    expect((await settleCampaignSpend(db.supabase, "org", "camp")).ok).toBe(true);
    expect(db.rpcs).toEqual([]);
    expect(update(db)).toBeDefined();
  });

  it("unchanged: billing off, or nothing held, touches nothing", async () => {
    mocks.billingEnabled.mockResolvedValueOnce(false);
    const off = world({ debits: [1] });
    await settleCampaignSpend(off.supabase, "org", "camp");
    expect(off.ops).toEqual([]);
    const settled = world({ held: 0 });
    await settleCampaignSpend(settled.supabase, "org", "camp");
    expect(settled.rpcs).toEqual([]);
    expect(update(settled)).toBeUndefined();
  });
});

// ------------------------------------------------------------------ (C)
describe("(C) opt-out is never overwritten and is re-checked at send time", () => {
  it("an import with consent never flips opted_out to opted_in", () => {
    expect(importOptInPatch("opted_out", true)).toEqual({});
    expect(importOptInPatch("OPTED_OUT", true)).toEqual({});
  });
  it("unchanged: consent still raises unknown to opted_in; no consent changes nothing", () => {
    expect(importOptInPatch("unknown", true)).toEqual({ opt_in_status: "opted_in" });
    expect(importOptInPatch(null, true)).toEqual({ opt_in_status: "opted_in" });
    expect(importOptInPatch("unknown", false)).toEqual({});
  });

  const contacts = (status: string | null, error?: string) =>
    fakeDb((op) => {
      if (op.table === "contacts")
        return error
          ? { data: null, error: { message: error } }
          : { data: status ? { opt_in_status: status } : null, error: null };
      if (op.table === "message_templates")
        return {
          data: {
            name: "promo",
            language: "en",
            category: "UTILITY",
            status: "APPROVED",
            components: [],
          },
          error: null,
        };
      return undefined;
    });

  it("contactOptedOut reads by contact id, else by phone, within the workspace", async () => {
    const byId = contacts("opted_out");
    expect(
      await contactOptedOut(byId.supabase, "org", { contactId: "c1", phone: "+91 98" }),
    ).toEqual({ optedOut: true, error: null });
    expect(byId.has(byId.ops[0]!, "eq", "id", "c1")).toBe(true);
    expect(byId.has(byId.ops[0]!, "eq", "organization_id", "org")).toBe(true);
    const byPhone = contacts("opted_in");
    expect(await contactOptedOut(byPhone.supabase, "org", { phone: "98000 00001" })).toEqual({
      optedOut: false,
      error: null,
    });
    expect(byPhone.has(byPhone.ops[0]!, "eq", "phone", "+9800000001")).toBe(true);
    const failed = contacts(null, "down");
    expect(await contactOptedOut(failed.supabase, "org", { contactId: "c1" })).toEqual({
      optedOut: false,
      error: "down",
    });
  });

  const run = {
    id: "r1",
    organization_id: "org",
    contact_id: "c1",
    flow_id: "f1",
    conversation_id: "cv1",
  };
  const env = {
    optedIn: true,
    optedOut: false,
    conn: { accountId: "acc" },
    ctx: { contact: { phone: "+919800000001" } },
  };

  it("flows v2: a contact who opted out since the run started gets no template", async () => {
    const db = contacts("opted_out");
    expect(await sendTemplate(db.supabase, run as never, env as never, "tpl", [])).toEqual({
      error: null,
      skipped: "opted_out",
    });
    expect(mocks.sendCampaignTemplate).not.toHaveBeenCalled();
  });

  it("flows v2: an opt-out check that fails sends nothing", async () => {
    const db = contacts(null, "down");
    expect((await sendTemplate(db.supabase, run as never, env as never, "tpl", [])).error).toBe(
      "opt_out_check_failed",
    );
    expect(mocks.sendCampaignTemplate).not.toHaveBeenCalled();
  });

  it("unchanged: flows v2 still sends to a contact who has not opted out", async () => {
    const db = contacts("unknown");
    expect(await sendTemplate(db.supabase, run as never, env as never, "tpl", [])).toEqual({
      error: null,
    });
    expect(mocks.sendCampaignTemplate).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------------------ (D)
describe("(D) webhook: one failing message never drops the rest", () => {
  const account = { id: "acc", organization_id: "org", waba_id: "waba" };
  const payload = (messages: unknown[], statuses: unknown[]) => ({
    entry: [
      {
        id: "waba",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "pn", display_phone_number: "911111111111" },
              contacts: [],
              messages,
              statuses,
            },
          },
        ],
      },
    ],
  });
  const inbound = (id: string, from: string) => ({
    id,
    from,
    timestamp: "1700000000",
    type: "text",
    text: { body: "hi" },
  });
  const status = { id: "wamid.out", status: "delivered", timestamp: "1700000000" };

  const world = (opts: {
    contactError?: boolean;
    insertError?: boolean;
    priorError?: string | null;
  }) =>
    fakeDb((op) => {
      if (op.table === "whatsapp_accounts") return { data: account, error: null };
      if (op.table === "contacts" && op.kind === "upsert")
        return opts.contactError
          ? { data: null, error: { message: "contact boom" } }
          : {
              data: { id: "c1", opt_in_status: "unknown", created_at: "2020-01-01T00:00:00Z" },
              error: null,
            };
      if (op.table === "conversations" && op.kind === "select")
        return { data: { id: "cv1", unread_count: 0 }, error: null };
      if (op.table === "messages" && op.kind === "upsert")
        return opts.insertError
          ? { data: null, error: { message: "insert boom" } }
          : { data: [], error: null };
      if (op.table === "messages" && op.kind === "select")
        return {
          data: { id: "m-out", status: "sent", type: "template", conversation_id: "cv1" },
          error: null,
        };
      if (op.table === "webhook_events" && op.kind === "select")
        return { data: { error: opts.priorError ?? null }, error: null };
      return undefined;
    });
  const eventUpdate = (db: ReturnType<typeof world>) =>
    db.ops.filter((o) => o.table === "webhook_events" && o.kind === "update").at(-1)!.payload as {
      processed_at: string | null;
      error: string | null;
    };

  it("a failed contact upsert: the status in the same event is still applied and the event stays retryable", async () => {
    const db = world({ contactError: true });
    await processWebhookPayload(
      db.supabase,
      "ev1",
      payload([inbound("wamid.in1", "919800000001")], [status]),
    );
    const statusWrite = db.ops.find((o) => o.table === "messages" && o.kind === "update");
    expect((statusWrite!.payload as { status: string }).status).toBe("delivered");
    const done = eventUpdate(db);
    expect(done.processed_at).toBeNull();
    expect(done.error).toMatch(
      /^retry:1 1 failed: message wamid\.in1: contact upsert failed: contact boom/,
    );
  });

  it("a failed message insert is not treated as a duplicate", async () => {
    const db = world({ insertError: true });
    await processWebhookPayload(
      db.supabase,
      "ev1",
      payload([inbound("wamid.in1", "919800000001")], []),
    );
    expect(db.ops.some((o) => o.table === "conversations" && o.kind === "update")).toBe(false);
    expect(eventUpdate(db).error).toMatch(/message insert failed: insert boom/);
    expect(eventUpdate(db).processed_at).toBeNull();
  });

  it("gives up after the last attempt so an event can't loop forever", async () => {
    const db = world({
      contactError: true,
      priorError: `retry:${WEBHOOK_MAX_ATTEMPTS - 1} earlier`,
    });
    await processWebhookPayload(
      db.supabase,
      "ev1",
      payload([inbound("wamid.in1", "919800000001")], []),
    );
    const done = eventUpdate(db);
    expect(done.processed_at).not.toBeNull();
    expect(done.error).toMatch(new RegExp(`^gave_up:${WEBHOOK_MAX_ATTEMPTS} `));
  });

  it("unchanged: a clean event is marked processed with no error; an unknown number keeps its marker", async () => {
    const db = world({});
    await processWebhookPayload(db.supabase, "ev1", payload([], [status]));
    expect(eventUpdate(db)).toMatchObject({ error: null });
    expect(eventUpdate(db).processed_at).not.toBeNull();

    const quiet = fakeDb(() => undefined);
    await finishEvent(quiet.supabase, "ev2", [], "unknown_phone_number_id");
    expect(quiet.ops[0]!.payload).toMatchObject({ error: "unknown_phone_number_id" });
    expect(webhookAttempts("retry:3 x")).toBe(3);
    expect(webhookAttempts("unknown_phone_number_id")).toBe(0);
  });
});

// ------------------------------------------------ (A) which runs are scoped
describe("(A) toolSubject: customer chats are scoped, owner and playground runs are not", () => {
  it("a run on a customer chat is scoped to its contact and conversation", () => {
    expect(toolSubject({ conversationId: "cv", contactId: "c" })).toEqual({
      contactId: "c",
      conversationId: "cv",
    });
    expect(toolSubject({ conversationId: "cv", contactId: null })).toEqual({
      contactId: null,
      conversationId: "cv",
    });
  });
  it("unchanged: the owner's onboarding chat and runs with no chat keep workspace scope", () => {
    expect(
      toolSubject({ channel: "onboarding", conversationId: "cv", contactId: null }),
    ).toBeUndefined();
    expect(toolSubject({})).toBeUndefined();
  });
});
