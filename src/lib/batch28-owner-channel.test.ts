import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";

/**
 * Batch 28 items 5 and 6 on the AiDwar (onboarding) number.
 *
 *  6  A sender whose profile phone is an owner/member of a workspace is an
 *     owner, even when every onboarding session of theirs has expired (Vinay
 *     got the stranger greeting 3 times in 2 minutes).
 *  5  The typing dots go only when a reply goes (onWillReply), never for a
 *     message that gets no answer.
 */

const h = vi.hoisted(() => ({
  sent: [] as Array<{ body: string; metadata?: Record<string, unknown> | undefined }>,
  members: [] as string[],
}));
vi.mock("@/lib/scripts.server", () => ({ getScript: async (_s: unknown, key: string) => key }));
vi.mock("@/lib/owner-replies.server", () => ({
  onboardingChannelFor: async () => null,
  ownerOrganizationIds: async () => h.members,
  memberOrganizationIds: async () => h.members,
  orgNames: async () => new Map(),
  prefixFor: () => "",
  withPrefix: (_p: string, t: string) => t,
  recordOnboardingGap: async () => {},
  openPendingReplies: async () => [],
}));
vi.mock("@/lib/service-text.server", () => {
  const send = async (_s: unknown, a: { body: string; metadata?: Record<string, unknown> | undefined }) => {
    h.sent.push({ body: a.body, metadata: a.metadata });
    return { ok: true, messageId: "m", error: null };
  };
  return { sendServiceText: send, sendServiceImage: send, sendServiceButtons: send, sendServiceList: send };
});
vi.mock("@/lib/onboarding-cards.server", () => ({ renderCard: async () => null }));

import { handleMerchantInbound, KNOWN_OWNER_NOTE } from "./merchant-channel.server";

const VINAY = "919800000001";

beforeEach(() => {
  h.sent.length = 0;
  h.members = [];
});

const expiredSession = {
  id: "sess-old",
  organization_id: "org-vinay",
  user_id: "u-vinay",
  phone: `+${VINAY}`,
  wa_id: VINAY,
  code: "AD-CMCP",
  status: "expired",
  step: "answering",
  source_id: null,
  pending_question: null,
  pending_asked_at: null,
  suggested_questions: null,
  expires_at: null,
};

/** Sessions by status filter: only the "any status, in member orgs" read finds the expired one. */
function world(opts: { sessions?: Array<Record<string, unknown>>; greeted?: number; noted?: number } = {}) {
  return fakeDb((op: FakeOp) => {
    if (op.table === "messages" && op.kind === "select") {
      const kind = op.filters.find(([n, a]) => n === "eq" && a[0] === "metadata->>kind")?.[1][1];
      const n = kind === "stranger_greeting" ? (opts.greeted ?? 0) : kind === "known_owner" ? (opts.noted ?? 0) : 0;
      return { data: Array.from({ length: n }, (_, i) => ({ id: `m${i}` })), error: null };
    }
    if (op.table === "onboarding_sessions" && op.kind === "select") {
      const anyStatus = op.filters.some(([n, a]) => n === "in" && a[0] === "organization_id");
      return { data: anyStatus ? (opts.sessions ?? []) : [], error: null };
    }
    if (op.table === "onboarding_sessions" && op.kind === "update") return { data: [{ id: "sess-old" }], error: null };
    if (op.table === "organizations") return { data: { name: "Zoori" }, error: null };
    if (op.table === "profiles") return { data: { full_name: "Vinay P" }, error: null };
    return undefined;
  });
}

async function inbound(db: ReturnType<typeof world>, body: string, waId = VINAY) {
  let dots = 0;
  await handleMerchantInbound(db.supabase, {
    organizationId: "org-platform",
    accountId: "acc",
    phoneNumberId: "pn",
    accessToken: "t",
    waId,
    conversationId: `conv-${waId}`,
    contactId: "c",
    body,
    onWillReply: () => (dots += 1),
  });
  return dots;
}

describe("item 6 — known owners are never greeted as strangers", () => {
  it("all sessions expired, but the profile phone owns a workspace: answered as an owner, no stranger greeting", async () => {
    h.members = ["org-vinay"];
    const db = world({ sessions: [expiredSession] });
    const dots = await inbound(db, "hi");
    expect(h.sent.some((m) => m.metadata?.["kind"] === "stranger_greeting")).toBe(false);
    expect(h.sent.map((m) => m.body)).toEqual(["Here and ready. Ask me anything about Zoori."]);
    expect(dots).toBe(1);
    // The expired row is used in memory only: its status is never rewritten.
    const statusWrites = db.ops.filter((o) => o.table === "onboarding_sessions" && o.kind === "update" && "status" in (o.payload as object));
    expect(statusWrites).toEqual([]);
  });

  it("three messages in two minutes: three owner answers, zero stranger greetings", async () => {
    h.members = ["org-vinay"];
    for (let i = 0; i < 3; i++) await inbound(world({ sessions: [expiredSession] }), "hi");
    expect(h.sent.filter((m) => m.metadata?.["kind"] === "stranger_greeting")).toHaveLength(0);
  });

  it("a member with no setup session at all gets one short note a day, not the stranger greeting", async () => {
    h.members = ["org-vinay"];
    expect(await inbound(world(), "hi")).toBe(1);
    expect(h.sent).toEqual([{ body: KNOWN_OWNER_NOTE, metadata: { kind: "known_owner" } }]);
    h.sent.length = 0;
    expect(await inbound(world({ noted: 1 }), "hi again")).toBe(0);
    expect(h.sent).toEqual([]);
  });

  it("unchanged: a phone that belongs to no workspace still gets the stranger greeting", async () => {
    expect(await inbound(world(), "hi", "919800000009")).toBe(1);
    expect(h.sent.map((m) => m.metadata?.["kind"])).toEqual(["stranger_greeting"]);
  });
});

describe("item 5 — the dots only go with a reply", () => {
  it("a stranger past the greeting limit gets no reply and no dots", async () => {
    expect(await inbound(world({ greeted: 3 }), "hi", "919800000009")).toBe(0);
    expect(h.sent).toEqual([]);
  });

  it("the webhook no longer shows the dots on the onboarding number before routing", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "whatsapp-webhook.server.ts"), "utf8");
    const calls = [...src.matchAll(/showTyping\(connectionP/g)];
    // Two: Aiden's onWillReply and the merchant channel's onWillReply — both via later().
    expect(calls).toHaveLength(2);
    expect([...src.matchAll(/onWillReply: \(\) => later\(showTyping\(/g)]).toHaveLength(2);
  });
});
