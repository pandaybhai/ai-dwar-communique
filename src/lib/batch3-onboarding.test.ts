import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";

const h = vi.hoisted(() => ({
  sent: [] as Array<{ body: string; metadata?: Record<string, unknown> | undefined }>,
}));
vi.mock("@/lib/scripts.server", () => ({ getScript: async (_s: unknown, key: string) => key }));
vi.mock("@/lib/owner-replies.server", () => ({
  onboardingChannelFor: async () => null,
  ownerOrganizationIds: async () => [],
  memberOrganizationIds: async () => [],
  orgNames: async () => new Map(),
  prefixFor: () => "",
  withPrefix: (_p: string, t: string) => t,
  recordOnboardingGap: async () => {},
}));
vi.mock("@/lib/service-text.server", () => {
  const send = async (_s: unknown, a: { body: string; metadata?: Record<string, unknown> | undefined }) => {
    h.sent.push({ body: a.body, metadata: a.metadata });
    return { ok: true, messageId: "m", error: null };
  };
  return { sendServiceText: send, sendServiceImage: send, sendServiceButtons: send, sendServiceList: send };
});
vi.mock("@/lib/onboarding-cards.server", () => ({ renderCard: async () => null }));

import { CODE_RE, isBareReference } from "./teach-guard";
import { codeVerdict, handleMerchantInbound, WRONG_CODE_LIMIT } from "./merchant-channel.server";

const OWNER = "919800000001";
const STRANGER = "919800000009";

beforeEach(() => {
  h.sent.length = 0;
});

describe("(1) onboarding codes: format", () => {
  it("new six-character codes are read whole, never as their first four", () => {
    expect("my code is AD-ABCD23".match(CODE_RE)?.[0]).toBe("AD-ABCD23");
    expect("ad-abcd23".match(CODE_RE)?.[0]).toBe("ad-abcd23");
  });
  it("unchanged: existing four-character codes still match", () => {
    expect("Hi Aiden, my code is AD-CMCP".match(CODE_RE)?.[0]).toBe("AD-CMCP");
    expect(isBareReference("AD-CMCP")).toBe(true);
    expect(isBareReference("AD-CMCP7K")).toBe(true);
  });
  it("five or seven characters are not a code", () => {
    expect("AD-ABCDE".match(CODE_RE)).toBeNull();
    expect("AD-ABCDEFG".match(CODE_RE)).toBeNull();
  });
});

describe("(1) onboarding codes: what a code may bind", () => {
  const s = (status: string, phone = `+${OWNER}`, extra: Record<string, unknown> = {}) => ({
    status,
    phone,
    wa_id: OWNER,
    expires_at: null as string | null,
    ...extra,
  });
  it("a completed session is never handed to another number", () => {
    expect(codeVerdict(s("completed"), STRANGER)).toBe("reject");
  });
  it("a completed session continues for its own number", () => {
    expect(codeVerdict(s("completed"), OWNER)).toBe("continue");
  });
  it("expired sessions and lapsed unused codes bind nothing", () => {
    expect(codeVerdict(s("expired"), OWNER)).toBe("reject");
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(codeVerdict(s("pending", `+${OWNER}`, { expires_at: past }), OWNER)).toBe("reject");
    expect(codeVerdict(null, OWNER)).toBe("reject");
  });
  it("unchanged (24 Sep): an active session binds, from any number", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(codeVerdict(s("pending", `+${OWNER}`, { expires_at: future }), STRANGER)).toBe("bind");
    for (const status of ["bound", "learning", "ready", "tested", "connected"]) {
      expect(codeVerdict(s(status), STRANGER)).toBe("bind");
    }
    // expires_at only governs a code nobody has used yet.
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(codeVerdict(s("ready", `+${OWNER}`, { expires_at: past }), STRANGER)).toBe("bind");
  });
});

describe("(1) onboarding codes: the inbound path", () => {
  const session = (status: string) => ({
    id: "sess-1",
    organization_id: "org-owner",
    user_id: "u-owner",
    phone: `+${OWNER}`,
    wa_id: OWNER,
    code: "AD-CMCP",
    status,
    step: "answering",
    source_id: null,
    pending_question: null,
    pending_asked_at: null,
    suggested_questions: null,
    expires_at: null,
  });

  const world = (opts: { status: string; wrongCodes?: number; lockNotes?: number }) =>
    fakeDb((op: FakeOp) => {
      if (op.table === "messages" && op.kind === "select") {
        const kind = op.filters.find(([n, a]) => n === "eq" && a[0] === "metadata->>kind")?.[1][1];
        const n = kind === "wrong_code" ? (opts.wrongCodes ?? 0) : kind === "code_locked" ? (opts.lockNotes ?? 0) : 0;
        return { data: Array.from({ length: n }, (_, i) => ({ id: `m${i}` })), error: null };
      }
      if (op.table === "onboarding_sessions" && op.kind === "select") {
        const byCode = op.filters.some(([n, a]) => n === "eq" && a[0] === "code");
        if (byCode) return { data: session(opts.status), error: null };
        return { data: [], error: null };
      }
      if (op.table === "onboarding_sessions" && op.kind === "update") {
        return { data: [{ id: "sess-1" }], error: null };
      }
      return undefined;
    });

  const inbound = (db: ReturnType<typeof world>, waId: string, body: string) =>
    handleMerchantInbound(db.supabase, {
      organizationId: "org-platform",
      accountId: "acc",
      phoneNumberId: "pn",
      accessToken: "t",
      waId,
      conversationId: `conv-${waId}`,
      contactId: "c",
      body,
    });

  const phoneWrites = (db: ReturnType<typeof world>) =>
    db.ops.filter(
      (op) =>
        op.table === "onboarding_sessions" &&
        op.kind === "update" &&
        Object.prototype.hasOwnProperty.call(op.payload as object, "phone"),
    );

  it("a stranger with a completed session's code is told it doesn't match, and nothing is rebound", async () => {
    const db = world({ status: "completed" });
    await inbound(db, STRANGER, "Hi Aiden, my code is AD-CMCP");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.metadata).toEqual({ kind: "wrong_code" });
    expect(db.ops.some((op) => op.table === "onboarding_sessions" && op.kind === "update")).toBe(false);
  });

  it("after five wrong codes in an hour codes aren't looked up; one polite note, then quiet", async () => {
    const db = world({ status: "ready", wrongCodes: WRONG_CODE_LIMIT });
    await inbound(db, STRANGER, "AD-CMCP");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.metadata).toEqual({ kind: "code_locked" });
    expect(h.sent[0]!.body).toMatch(/try again in an hour/);
    expect(db.ops.some((op) => op.table === "onboarding_sessions")).toBe(false);

    h.sent.length = 0;
    const again = world({ status: "ready", wrongCodes: WRONG_CODE_LIMIT + 1, lockNotes: 1 });
    await inbound(again, STRANGER, "AD-CMCP");
    expect(h.sent).toHaveLength(0);
  });

  it("four wrong codes still allow a lookup", async () => {
    const db = world({ status: "ready", wrongCodes: WRONG_CODE_LIMIT - 1 });
    await inbound(db, OWNER, "AD-CMCP");
    expect(db.ops.some((op) => op.table === "onboarding_sessions" && op.kind === "select")).toBe(true);
  });

  it("unchanged (24 Sep): a valid code from a different phone rebinds an active session", async () => {
    const db = world({ status: "ready" });
    await inbound(db, STRANGER, "Hi Aiden, my code is AD-CMCP");
    const writes = phoneWrites(db);
    expect(writes).toHaveLength(1);
    expect((writes[0]!.payload as { phone: string }).phone).toBe(`+${STRANGER}`);
    expect(h.sent.some((m) => m.body.startsWith("Connected"))).toBe(true);
  });

  it("the owner's own number can still use the code of its completed session", async () => {
    const db = world({ status: "completed" });
    await inbound(db, OWNER, "AD-CMCP");
    expect(phoneWrites(db)).toHaveLength(0);
    expect(h.sent.some((m) => m.metadata?.["kind"] === "wrong_code")).toBe(false);
    expect(h.sent.some((m) => m.body.startsWith("Connected"))).toBe(true);
  });
});
