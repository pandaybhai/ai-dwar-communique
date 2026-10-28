import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type MemoryDb, type Row } from "./test-support/memory-db";

/**
 * Batch 35 item 7 (live, safety) — a question Aiden files as Unanswered is
 * quiet: dashboard only. It never enters the owner's WhatsApp waiting list on
 * the AiDwar number, and nothing the owner says there reaches a customer
 * unless the owner explicitly picked that one waiting item. Right after the
 * owner is told a customer is waiting, their plain message is not saved as a
 * business fact (which every customer would then hear) and goes nowhere.
 */

const h = vi.hoisted(() => ({
  sent: [] as Array<{ to: string; body: string; conversationId: string }>,
  facts: [] as string[],
  corrections: [] as string[],
  db: null as null | import("./test-support/memory-db").MemoryDb,
}));
vi.mock("@/lib/scripts.server", () => ({ getScript: async (_s: unknown, key: string) => key }));
vi.mock("@/lib/service-text.server", () => {
  const send = async (_s: unknown, a: { to: string; body: string; conversationId: string }) => {
    h.sent.push({ to: a.to, body: a.body, conversationId: a.conversationId });
    return { ok: true, messageId: "m", error: null };
  };
  return {
    sendServiceText: send,
    sendServiceImage: send,
    sendServiceButtons: send,
    sendServiceList: send,
  };
});
vi.mock("@/lib/onboarding-cards.server", () => ({ renderCard: async () => null }));
vi.mock("@/lib/knowledge.server", () => ({
  saveFact: async (_s: unknown, _o: string, f: { text: string }) => {
    h.facts.push(f.text);
    return { ok: true };
  },
  saveCorrection: async (_s: unknown, _o: string, c: { answer: string }) => {
    h.corrections.push(c.answer);
    return { ok: true };
  },
}));
vi.mock("@/lib/ai-tasks.server", () => ({
  classifyBusinessFact: async () => ({ isFact: true, topic: "delivery" }),
  merchantAnswer: async () => ({ output: "ok", status: "ok" }),
}));
vi.mock("@/lib/whatsapp-numbers.server", () => ({
  getWhatsAppConnection: async () => ({
    connection: { accountId: "acc-shop", wabaId: "w", phoneNumberId: "pn-shop", accessToken: "t" },
    error: null,
  }),
}));

import { handleMerchantInbound } from "./merchant-channel.server";
import { handleOwnerAnswer, loadPendingReplies, recordCustomerGap } from "./owner-replies.server";

const OWNER = "919800000001";
const CUSTOMER_PHONE = "+919811111111";
const now = () => new Date().toISOString();

function world(extra: Record<string, Row[]> = {}): MemoryDb {
  return memoryDb({
    organizations: [{ id: "org-shop", name: "Shop" }],
    organization_members: [{ organization_id: "org-shop", user_id: "u-owner", role: "owner" }],
    profiles: [{ id: "u-owner", phone: `+${OWNER}`, full_name: "Asha" }],
    onboarding_sessions: [
      {
        id: "sess",
        organization_id: "org-shop",
        user_id: "u-owner",
        phone: `+${OWNER}`,
        wa_id: OWNER,
        code: "AD-ABCD",
        status: "ready",
        step: "answering",
        created_at: now(),
        last_inbound_at: now(),
      },
    ],
    contacts: [{ id: "cust", organization_id: "org-shop", phone: CUSTOMER_PHONE }],
    conversations: [
      {
        id: "conv-cust",
        organization_id: "org-shop",
        contact_id: "cust",
        whatsapp_account_id: "acc-shop",
        last_customer_message_at: now(),
        needs_human: false,
      },
    ],
    ...extra,
  });
}

async function ownerSays(db: MemoryDb, body: string, interactiveId: string | null = null) {
  await handleMerchantInbound(db.supabase, {
    organizationId: "org-platform",
    accountId: "acc-platform",
    phoneNumberId: "pn-platform",
    accessToken: "t",
    waId: OWNER,
    conversationId: "conv-owner",
    contactId: "c-owner",
    body,
    interactiveId,
  });
}

const toCustomer = () =>
  h.sent.filter((s) => s.conversationId === "conv-cust" || s.to === CUSTOMER_PHONE.slice(1));

beforeEach(() => {
  h.sent.length = 0;
  h.facts.length = 0;
  h.corrections.length = 0;
});

describe("an Unanswered item never reaches the owner's waiting list", () => {
  it("filed silently, it is on the dashboard table but not in the owner's WhatsApp list", async () => {
    const db = world();
    expect(
      await recordCustomerGap(db.supabase, {
        organizationId: "org-shop",
        conversationId: "conv-cust",
        contactId: "cust",
        question: "Do you deliver to Pune on Sunday?",
        aiRunId: null,
      }),
    ).toBe(true);
    const row = db.rows("pending_owner_replies")[0]!;
    expect(row).toMatchObject({ source: "customer", notify: "silent" });
    row["status"] = "pending"; // the column's default in the database
    expect(await loadPendingReplies(db.supabase, OWNER)).toEqual([]);
  });

  it("the owner's next ordinary message goes to no customer and answers nothing", async () => {
    const db = world({
      pending_owner_replies: [
        {
          id: "gap-1",
          organization_id: "org-shop",
          owner_phone: `+${OWNER}`,
          conversation_id: "conv-cust",
          contact_id: "cust",
          question: "Pune on Sunday?",
          source: "customer",
          notify: "silent",
          status: "pending",
          created_at: now(),
        },
      ],
    });
    await ownerSays(db, "We are closed on Sunday");
    expect(toCustomer()).toEqual([]);
    expect(h.corrections).toEqual([]);
    expect(db.rows("pending_owner_replies")[0]!["status"]).toBe("pending");
  });
});

describe("only an explicitly picked item is answered", () => {
  const ping = (over: Row = {}): Row => ({
    id: "q-1",
    organization_id: "org-shop",
    owner_phone: `+${OWNER}`,
    conversation_id: "conv-cust",
    contact_id: "cust",
    question: "Is the blue one in stock?",
    source: "customer",
    notify: "ping",
    status: "pending",
    created_at: now(),
    selected_at: null,
    ...over,
  });
  const fns = (replies: string[]) => ({
    reply: async (t: string) => replies.push(t),
    list: async (t: string) => replies.push(t),
  });

  it("the only open item, not picked: the owner is asked to pick it; nothing is saved or sent", async () => {
    const db = world({ pending_owner_replies: [ping()] });
    const replies: string[] = [];
    const consumed = await handleOwnerAnswer(db.supabase, {
      ownerPhone: OWNER,
      body: "Yes, 3 left in stock",
      ...fns(replies),
    });
    expect(consumed).toBe(true);
    expect(replies).toEqual(["Which one is this for?"]);
    expect(h.corrections).toEqual([]);
    expect(toCustomer()).toEqual([]);
  });

  it("picked: that one item's customer gets the answer (unchanged)", async () => {
    const db = world({ pending_owner_replies: [ping({ selected_at: now() })] });
    const replies: string[] = [];
    await handleOwnerAnswer(db.supabase, {
      ownerPhone: OWNER,
      body: "Yes, 3 left in stock",
      ...fns(replies),
    });
    expect(h.corrections).toEqual(["Yes, 3 left in stock"]);
    expect(toCustomer().map((s) => s.body)).toEqual(["Yes, 3 left in stock"]);
    expect(db.rows("pending_owner_replies")[0]!["status"]).toBe("answered");
  });

  it("a silent or onboarding row is never offered, even when picked", async () => {
    const db = world({
      pending_owner_replies: [
        ping({ notify: "silent", selected_at: now() }),
        ping({ id: "q-2", source: "onboarding", selected_at: now() }),
      ],
    });
    expect(await loadPendingReplies(db.supabase, OWNER)).toEqual([]);
  });
});

describe("after the owner is told a customer is waiting", () => {
  const alerted = (whatsapp: string[]) => ({
    conversations: [
      {
        id: "conv-cust",
        organization_id: "org-shop",
        contact_id: "cust",
        whatsapp_account_id: "acc-shop",
        last_customer_message_at: now(),
        needs_human: true,
        handoff_alert_at: now(),
        handoff_alert_result: { at: now(), reminder: false, whatsapp, email: null, skipped: null },
      },
    ],
  });

  it("their plain message is not saved as a business fact and is sent to no one", async () => {
    const db = world(alerted([`+${OWNER}`]));
    await ownerSays(db, "Tell her the blue one is 1500");
    expect(h.facts).toEqual([]);
    expect(toCustomer()).toEqual([]);
    expect(h.sent.map((s) => s.body)).toEqual(["owner_reply_held"]);
  });

  it("unchanged: with no customer waiting on the owner, a fact is saved as before", async () => {
    expect(
      await (async () => {
        const db = world();
        await ownerSays(db, "We deliver across Pune in 2 days");
        return h.facts;
      })(),
    ).toEqual(["We deliver across Pune in 2 days"]);
    expect(toCustomer()).toEqual([]);
  });

  it("an alert that went to staff phones, not the owner, doesn't hold the owner's facts", async () => {
    const db = world(alerted(["+919822222222"]));
    await ownerSays(db, "We deliver across Pune in 2 days");
    expect(h.facts).toEqual(["We deliver across Pune in 2 days"]);
  });
});
