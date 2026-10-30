import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { fakeDb, type FakeOp } from "./test-support/fake-db";

/**
 * Batch 51, gap 1 — Approve / Decline on a "Needs you" item. The decision is
 * the owner's own words through the Unanswered list's existing request
 * (/api/ai/knowledge "answer_gap"): saved as a correction, sent word for word
 * by deliverToCustomer, logged as ai_answer_corrected with which button was
 * pressed. No code writes customer reply text, and with nothing filed under
 * Unanswered (or without the permissions) the Batch 45/46 buttons are as before.
 */

const h = vi.hoisted(() => ({
  db: null as null | ReturnType<typeof import("./test-support/fake-db").fakeDb>,
  denied: [] as string[],
  logged: [] as Array<{ action: string; details: Record<string, unknown> }>,
  corrections: [] as Array<{ question: string; answer: string }>,
  sent: [] as Array<{ body: string; to: string }>,
}));

vi.mock("@/lib/whatsapp-api.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp-api.server")>()),
  requireOrgMember: async () => ({
    supabase: h.db!.supabase,
    organizationId: "org-51",
    userId: "owner-1",
    role: "owner",
  }),
  requirePermission: async (_auth: unknown, key: string) =>
    h.denied.includes(key)
      ? Response.json({ error: "You don't have permission." }, { status: 403 })
      : null,
  logServerActivity: async (
    _db: unknown,
    _org: string,
    _user: string,
    action: string,
    details: Record<string, unknown>,
  ) => {
    h.logged.push({ action, details });
  },
}));
vi.mock("@/lib/knowledge.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/knowledge.server")>()),
  saveCorrection: async (_db: unknown, _org: string, c: { question: string; answer: string }) => {
    h.corrections.push({ question: c.question, answer: c.answer });
    return { ok: true };
  },
}));
vi.mock("@/lib/whatsapp-numbers.server", () => ({
  getWhatsAppConnection: async () => ({
    connection: { accountId: "acc", wabaId: "waba", phoneNumberId: "pn", accessToken: "t" },
    error: null,
  }),
}));
vi.mock("@/lib/service-text.server", () => ({
  sendServiceText: async (_db: unknown, a: { body: string; to: string }) => {
    h.sent.push({ body: a.body, to: a.to });
    return { ok: true };
  },
  sendServiceList: async () => ({ ok: true }),
}));

import { Route as KnowledgeRoute } from "../routes/api/ai/knowledge";
import {
  canDecide,
  decisionRequest,
  DecisionButtons,
  DecisionForm,
} from "@/components/inbox/v2/owner-decision";

type Post = (a: { request: Request }) => Promise<Response>;
const post = (KnowledgeRoute as unknown as { options: { server: { handlers: { POST: Post } } } })
  .options.server.handlers.POST;

const GAP = {
  id: "gap-1",
  organization_id: "org-51",
  owner_phone: "919800000000",
  conversation_id: "cv-1",
  contact_id: "ct-1",
  question: "Can I get 10% off on 3 kurtas?",
  source: "customer",
  status: "pending",
  selected_at: null,
  created_at: new Date().toISOString(),
  reminded_at: null,
};

function world(windowOpen = true) {
  h.logged = [];
  h.corrections = [];
  h.sent = [];
  h.db = fakeDb((op: FakeOp) => {
    if (op.table === "pending_owner_replies" && op.kind === "select")
      return { data: GAP, error: null };
    if (op.table === "conversations" && op.kind === "select")
      return {
        data: {
          id: "cv-1",
          organization_id: "org-51",
          contact_id: "ct-1",
          whatsapp_account_id: "acc",
          last_customer_message_at: windowOpen
            ? new Date().toISOString()
            : new Date(Date.now() - 30 * 3600_000).toISOString(),
        },
        error: null,
      };
    if (op.table === "contacts") return { data: { phone: "+91 98111 22233" }, error: null };
    return undefined;
  });
  return h.db;
}

const OWNER_WORDS = "Yes Priya, 10% is fine on three. Use code PRIYA10 at checkout.";

const call = (body: Record<string, unknown>) =>
  post({
    request: new Request("http://x/api/ai/knowledge", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  });

describe("a decision goes through the existing owner-answer path", () => {
  it("Approve: the request is the Unanswered list's answer_gap with the owner's words as typed", () => {
    expect(
      decisionRequest({
        organizationId: "org-51",
        replyId: "gap-1",
        answer: `  ${OWNER_WORDS}\n`,
        decision: "approve",
      }),
    ).toEqual({
      organization_id: "org-51",
      action: "answer_gap",
      reply_id: "gap-1",
      answer: OWNER_WORDS,
      decision: "approve",
    });
  });

  it("the server saves the correction, sends exactly the owner's words, clears needs_human and logs the decision", async () => {
    const db = world();
    const res = await call(
      decisionRequest({
        organizationId: "org-51",
        replyId: "gap-1",
        answer: OWNER_WORDS,
        decision: "approve",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, delivered: true });
    expect(h.corrections).toEqual([{ question: GAP.question, answer: OWNER_WORDS }]);
    // The only text that reaches the customer is what the owner wrote.
    expect(h.sent).toEqual([{ body: OWNER_WORDS, to: "919811122233" }]);
    const cleared = db.ops.find((o) => o.table === "conversations" && o.kind === "update");
    expect(cleared?.payload).toEqual({
      needs_human: false,
      needs_human_reason: null,
      handover_state: null,
    });
    const answered = db.ops.find((o) => o.table === "pending_owner_replies" && o.kind === "update");
    expect(answered?.payload).toMatchObject({ status: "answered", answer: OWNER_WORDS });
    expect(h.logged).toEqual([
      {
        action: "ai_answer_corrected",
        details: { from: "needs_you", decision: "approve", conversation_id: "cv-1" },
      },
    ]);
  });

  it("Decline is the same path; the log says decline", async () => {
    world();
    await call(
      decisionRequest({
        organizationId: "org-51",
        replyId: "gap-1",
        answer: "Sorry, no discounts this week.",
        decision: "decline",
      }),
    );
    expect(h.sent.map((s) => s.body)).toEqual(["Sorry, no discounts this week."]);
    expect(h.logged[0]!.details).toMatchObject({ from: "needs_you", decision: "decline" });
  });

  it("no words, no send: the server refuses an empty answer", async () => {
    world();
    const res = await call(
      decisionRequest({
        organizationId: "org-51",
        replyId: "gap-1",
        answer: "   ",
        decision: "approve",
      }),
    );
    expect(res.status).toBe(400);
    expect(h.sent).toEqual([]);
    expect(h.corrections).toEqual([]);
  });

  it("window closed: saved, nothing sent (deliverToCustomer's own rule)", async () => {
    world(false);
    const res = await call(
      decisionRequest({
        organizationId: "org-51",
        replyId: "gap-1",
        answer: OWNER_WORDS,
        decision: "approve",
      }),
    );
    expect(await res.json()).toEqual({ ok: true, delivered: false });
    expect(h.sent).toEqual([]);
    expect(h.corrections).toHaveLength(1);
  });

  it("the Unanswered list's own answer is logged exactly as before", async () => {
    world();
    await call({
      organization_id: "org-51",
      action: "answer_gap",
      reply_id: "gap-1",
      answer: OWNER_WORDS,
    });
    expect(h.logged).toEqual([{ action: "ai_answer_corrected", details: { from: "unanswered" } }]);
  });

  it("answer_gap keeps its own permission (ai.configure): no permission, no send", async () => {
    world();
    h.denied = ["ai.configure"];
    const res = await call(
      decisionRequest({
        organizationId: "org-51",
        replyId: "gap-1",
        answer: OWNER_WORDS,
        decision: "approve",
      }),
    );
    h.denied = [];
    expect(res.status).toBe(403);
    expect(h.sent).toEqual([]);
  });
});

describe("the buttons and the box", () => {
  it("only someone who can reply in the chat and teach Aiden sees Approve / Decline", () => {
    const can = (keys: string[]) => (k: string) => keys.includes(k);
    expect(canDecide(can(["inbox.reply", "ai.configure"]))).toBe(true);
    expect(canDecide(can(["inbox.reply"]))).toBe(false);
    expect(canDecide(can(["ai.configure"]))).toBe(false);
  });

  it("the box starts empty: it never suggests a reply", () => {
    const html = renderToStaticMarkup(
      <DecisionForm
        organizationId="org-51"
        gap={{ id: "gap-1", question: GAP.question }}
        decision="approve"
        who="Priya"
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain("Approve: tell Priya in your own words");
    expect(html).toContain(`They asked: “${GAP.question}”`);
    expect(html).toMatch(/<textarea[^>]*><\/textarea>/);
    expect(html).not.toMatch(/placeholder=/);
    expect(html).toContain("Sent exactly as you write it");
    const buttons = renderToStaticMarkup(<DecisionButtons onPick={() => {}} />);
    expect(buttons).toContain(">Approve<");
    expect(buttons).toContain(">Decline<");
  });

  it("no new send path: owner-decision.tsx only calls knowledgeApi(decisionRequest(...))", () => {
    const code = readFileSync("src/components/inbox/v2/owner-decision.tsx", "utf8");
    expect(code).toContain("knowledgeApi<{ delivered?: boolean }>(\n      decisionRequest(");
    for (const banned of [
      "sendInboxText",
      "send-message",
      "callApi(",
      "sendServiceText",
      ".insert(",
      ".update(",
    ])
      expect(code).not.toContain(banned);
  });
});

describe("Home's Needs you card", () => {
  it("without a decision to make it is the Batch 45 card (Reply to …, Open the inbox)", async () => {
    const { NeedsYou } = await import("@/components/home-v2/replying-view");
    const items = [
      {
        key: "c-1",
        conversationId: "c1",
        who: "Rohan Das",
        question: "Can I get a refund?",
        at: new Date().toISOString(),
      },
    ];
    const html = renderToStaticMarkup(<NeedsYou items={items} total={2} />);
    expect(html).toContain("Reply to Rohan");
    expect(html).toContain("Open the inbox");
    expect(html).not.toContain(">Approve<");
    // canDecide alone isn't enough: the decision needs the open Unanswered item (read on mount).
    const still = renderToStaticMarkup(
      <NeedsYou items={items} total={2} organizationId="org-51" canDecide />,
    );
    expect(still).toContain("Reply to Rohan");
  });

  it("the Inbox's note and header use the same component; Mark as handled stays", () => {
    const pane = readFileSync("src/components/inbox/v2/chat-pane.tsx", "utf8");
    expect(pane).toContain("<DecisionButtons");
    expect(pane).toContain("<DecisionForm");
    expect(pane).toContain("Reply myself");
    expect(pane).toContain("Mark as handled");
  });
});
