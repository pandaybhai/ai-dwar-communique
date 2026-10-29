import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { fakeDb, type FakeOp } from "./test-support/fake-db";

/**
 * Batch 45 — the new Home (docs/design/preview.html #home). No live
 * database, WhatsApp or Meta: reads go to a fake query builder, the API to a
 * recorder, realtime to a fake channel.
 */

type Rows = Record<string, unknown[]>;
const h = vi.hoisted(() => ({
  rows: {} as Record<string, unknown[]>,
  calls: [] as Array<{ path: string; init: { method?: string; body?: unknown } }>,
  channels: [] as Array<{
    topic: string;
    on: Array<{ table: string; filter: string; cb: (p: { new: unknown }) => void }>;
    removed: boolean;
  }>,
  newDesign: false,
  db: null as ReturnType<typeof import("./test-support/fake-db").fakeDb> | null,
}));

const NOW = Date.parse("2026-10-29T10:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

function rowsFor(op: FakeOp): unknown[] {
  const all = (h.rows[op.table] ?? []) as Array<Record<string, unknown>>;
  // The few filters these reads lean on: task, user_id null, direction, needs_human.
  return all.filter((r) =>
    op.filters.every(([m, a]) => {
      const [col, val] = a as [string, unknown];
      if (m === "eq" && typeof col === "string" && !col.includes(".") && col in r) return r[col] === val;
      if (m === "is" && col === "user_id") return r["user_id"] === null;
      return true;
    }),
  );
}

function useRows(rows: Rows) {
  h.rows = rows;
  h.db = fakeDb(
    (op) => {
      const data = rowsFor(op);
      const head = (op.select?.[1] as { head?: boolean } | undefined)?.head;
      const single = op.filters.some(([m]) => m === "maybeSingle");
      return { data: head ? null : single ? (data[0] ?? null) : data, error: null, count: data.length };
    },
    () => ({ data: null, error: { message: "not in this test" } }),
  );
}

vi.mock("@/integrations/aidwar/client", () => ({
  aidwar: {
    from: (t: string) => h.db!.supabase.from(t),
    rpc: (n: string, a: Record<string, unknown>) => h.db!.supabase.rpc(n, a),
    channel: (topic: string) => {
      const ch = { topic, on: [] as (typeof h.channels)[number]["on"], removed: false };
      h.channels.push(ch);
      const api = {
        on: (_e: string, cfg: { table: string; filter: string }, cb: (p: { new: unknown }) => void) => {
          ch.on.push({ table: cfg.table, filter: cfg.filter, cb });
          return api;
        },
        subscribe: () => ch,
      };
      return api;
    },
    removeChannel: (ch: { removed: boolean }) => {
      ch.removed = true;
      return Promise.resolve("ok");
    },
    auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) },
  },
}));

const SUMMARY = {
  today: { conversations: 48, ai_answers: 41, escalations: 3 },
  credits: null,
  plan: { name: "Growth", status: "active", trial_days_left: null },
  waiting: [],
  learned: [],
  generated_at: ago(0),
};

vi.mock("@/lib/whatsapp-client", () => ({
  callApi: async (path: string, init: { method?: string; body?: unknown } = {}) => {
    h.calls.push({ path, init });
    if (path.startsWith("/api/home/summary")) return { data: SUMMARY, error: null, raw: SUMMARY };
    if (path === "/api/whatsapp/send-message") {
      const body = init.body as { body?: string };
      if (body.body === "fail please") return { data: null, error: "The 24-hour window has closed.", raw: null };
      return { data: { message_id: "m1" }, error: null, raw: null };
    }
    return { data: null, error: "not in this test", raw: null };
  },
}));

// Reduced motion, as some owners have it: every list item and every typed
// reply shows whole at once (and markup can be read without a browser).
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => true,
}));

vi.mock("@/lib/new-design", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/new-design")>()),
  useNewDesign: () => h.newDesign,
}));

const ACCESS = { aiPlan: true, campaigns: false, flows: true, revenue: false, billing: false, teammates: false };
const ORG = "org-1";

const contact = (id: string, name: string) => ({ id, name, phone: "+919800000000" });

beforeEach(() => {
  h.calls = [];
  h.channels = [];
  useRows({});
});
afterEach(() => {
  vi.useRealTimers();
});

describe("which Home: the mode Aiden really runs in", () => {
  it("homeModeFor follows the webhook's own rule", async () => {
    const { homeModeFor } = await import("./new-home");
    expect(homeModeFor({ aiPlan: true, aiEnabled: true, agentMode: "replying" })).toBe("replying");
    expect(homeModeFor({ aiPlan: true, aiEnabled: true, agentMode: "draft" })).toBe("draft");
    expect(homeModeFor({ aiPlan: true, aiEnabled: false, agentMode: "off" })).toBe("off");
    // A plan without AI is Off whatever the agent row says.
    expect(homeModeFor({ aiPlan: false, aiEnabled: true, agentMode: "replying" })).toBe("off");
    // AI switched off for the workspace (a row edited by hand) is Off, as the webhook treats it.
    expect(homeModeFor({ aiPlan: true, aiEnabled: false, agentMode: "replying" })).toBe("off");
    // No agent yet, no settings row, an unknown mode: Off.
    expect(homeModeFor({ aiPlan: true, aiEnabled: null, agentMode: null })).toBe("off");
    expect(homeModeFor({ aiPlan: true, aiEnabled: null, agentMode: "draft" })).toBe("draft");
    expect(homeModeFor({ aiPlan: true, aiEnabled: true, agentMode: "paused" })).toBe("off");
  });

  for (const [agentMode, aiEnabled, expected, reads, never] of [
    ["replying", true, "replying", "agent_reply", "suggest_reply"],
    ["draft", true, "draft", "suggest_reply", "agent_reply"],
    ["off", false, "off", "flow_runs", "ai_runs"],
  ] as const) {
    it(`ai_agents.mode "${agentMode}" gives the ${expected} Home and reads only its blocks`, async () => {
      useRows({
        ai_agents: [{ organization_id: ORG, is_default: true, mode: agentMode }],
        organization_ai_settings: [{ organization_id: ORG, ai_enabled: aiEnabled }],
      });
      const { loadNewHome } = await import("@/components/home-v2/use-new-home");
      const data = await loadNewHome(ORG, "Asia/Kolkata", ACCESS, NOW);
      expect(data.mode).toBe(expected);
      const ops = h.db!.ops;
      const touched = (needle: string) =>
        ops.some((o) => o.table === needle || (o.table === "ai_runs" && h.db!.has(o, "eq", "task", needle)));
      expect(touched(reads)).toBe(true);
      expect(touched(never)).toBe(false);
      // Every read is scoped to the workspace (RLS does the rest).
      for (const o of ops.filter((x) => ["ai_runs", "ai_agents", "flow_runs"].includes(x.table)))
        expect(h.db!.has(o, "eq", "organization_id", ORG)).toBe(true);
      // Read only: nothing written.
      expect(ops.every((o) => o.kind === "select")).toBe(true);
    });
  }

  it("a plan without AI is the Off Home and never reads Aiden's mode", async () => {
    useRows({ ai_agents: [{ organization_id: ORG, is_default: true, mode: "replying" }] });
    const { loadNewHome } = await import("@/components/home-v2/use-new-home");
    const data = await loadNewHome(ORG, "Asia/Kolkata", { ...ACCESS, aiPlan: false }, NOW);
    expect(data.mode).toBe("off");
    expect(h.db!.ops.some((o) => o.table === "ai_agents")).toBe(false);
  });
});

describe("free replies running out: windows closing within 2 hours", () => {
  it("counts from the last customer message; exactly 2 h is in, already closed is out", async () => {
    const { closingWindows, timeLeftLabel } = await import("./new-home");
    const at = (msLeft: number) => ago(24 * HOUR - msLeft);
    const out = closingWindows(
      [
        { conversationId: "exactly-2h", lastInboundAt: at(2 * HOUR) },
        { conversationId: "2h-and-1ms", lastInboundAt: at(2 * HOUR + 1) },
        { conversationId: "100-min", lastInboundAt: at(100 * MIN) },
        { conversationId: "closing-now", lastInboundAt: at(0) },
        { conversationId: "closed-1ms-ago", lastInboundAt: at(-1) },
        { conversationId: "closed-yesterday", lastInboundAt: ago(30 * HOUR) },
        { conversationId: "fresh", lastInboundAt: ago(5 * MIN) },
        { conversationId: "never-wrote", lastInboundAt: null },
      ],
      NOW,
    );
    expect(out.map((w) => w.conversationId)).toEqual(["closing-now", "100-min", "exactly-2h"]);
    expect(out.find((w) => w.conversationId === "exactly-2h")!.minutesLeft).toBe(120);
    expect(out.find((w) => w.conversationId === "100-min")!.minutesLeft).toBe(100);
    expect(out[0]!.closesAt).toBe(new Date(NOW).toISOString());
    expect(timeLeftLabel(100)).toBe("1 hour 40 minutes left");
    expect(timeLeftLabel(120)).toBe("2 hours left");
    expect(timeLeftLabel(0)).toBe("0 minutes left");
  });

  it("agrees with the send path's own window rule (isServiceWindowOpen)", async () => {
    const { closingWindows } = await import("./new-home");
    const { isServiceWindowOpen } = await import("./service-window");
    for (const left of [-1, 0, 1, HOUR, 2 * HOUR]) {
      const last = ago(24 * HOUR - left);
      const inCard = closingWindows([{ conversationId: "c", lastInboundAt: last }], NOW).length === 1;
      expect(inCard).toBe(isServiceWindowOpen({ last_customer_message_at: last }, NOW));
    }
  });

  it("reads each chat's newest customer message, not last_customer_message_at", async () => {
    useRows({
      conversations: [
        {
          id: "c1",
          status: "open",
          assigned_to: null,
          needs_human: false,
          last_message_at: ago(5 * MIN),
          contact: contact("k1", "Asha"),
          preview: [{ body: "Thanks", type: "text", direction: "outbound", created_at: ago(5 * MIN) }],
          last_in: [{ created_at: ago(23 * HOUR) }],
        },
      ],
    });
    const { loadOpenChats } = await import("./new-home-data");
    const chats = await loadOpenChats(ORG, NOW);
    expect(chats![0]!.lastInboundAt).toBe(ago(23 * HOUR));
    const op = h.db!.ops.find((o) => o.table === "conversations")!;
    expect(String(op.select?.[0])).toContain("last_in:messages(created_at)");
    expect(h.db!.has(op, "eq", "last_in.direction", "inbound")).toBe(true);
  });
});

describe("drafts: Send uses the Inbox's existing send", () => {
  it("sendDraftReply posts exactly what the Inbox composer posts", async () => {
    const { sendDraftReply } = await import("@/components/home-v2/drafts-view");
    const res = await sendDraftReply(ORG, { conversationId: "conv-9" }, "  Yes, we can deliver by Friday.  ");
    expect(res).toEqual({ sent: true, error: null });
    expect(h.calls).toEqual([
      {
        path: "/api/whatsapp/send-message",
        init: {
          body: {
            organization_id: ORG,
            conversation_id: "conv-9",
            message_type: "text",
            body: "Yes, we can deliver by Friday.",
          },
        },
      },
    ]);
  });

  it("sends nothing for empty words and passes the server's refusal through", async () => {
    const { sendDraftReply } = await import("@/components/home-v2/drafts-view");
    expect(await sendDraftReply(ORG, { conversationId: "c" }, "   ")).toEqual({ sent: false, error: null });
    expect(h.calls).toHaveLength(0);
    expect(await sendDraftReply(ORG, { conversationId: "c" }, "fail please")).toEqual({
      sent: false,
      error: "The 24-hour window has closed.",
    });
  });

  it("the Inbox and Home share one send and one assign (no second path)", () => {
    const src = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");
    const inbox = src("components/inbox/inbox-view.tsx");
    expect(inbox).toMatch(/sendInboxText\(orgId, activeConversation\.id, text\)/);
    expect(inbox).toMatch(/assignConversation\(orgId, activeConversation, assignee\)/);
    expect(inbox).not.toMatch(/"\/api\/whatsapp\/send-message",\s*\{\s*body:\s*\{[^}]*message_type: "text"/);
    const home = ["drafts-view.tsx", "off-view.tsx", "replying-view.tsx", "new-home.tsx", "use-new-home.ts"]
      .map((f) => src(`components/home-v2/${f}`))
      .join("\n");
    expect(home).not.toMatch(/send-message|\.update\(|\.insert\(|\.upsert\(|\.delete\(/);
    expect(src("components/home-v2/drafts-view.tsx")).toMatch(/sendInboxText\(organizationId, draft\.conversationId, body\)/);
  });

  it("ready drafts: Aiden's own (no user_id), latest per chat, gone once anything is sent", async () => {
    const { readyDrafts } = await import("./new-home");
    const runs = [
      { id: "r1", conversation_id: "a", input_summary: "Open Sunday?", output: "Yes, 11 to 8.", created_at: ago(10 * MIN) },
      { id: "r2", conversation_id: "a", input_summary: "And Monday?", output: "Monday too.", created_at: ago(2 * MIN) },
      { id: "r3", conversation_id: "b", input_summary: "Price?", output: "₹1,200.", created_at: ago(30 * MIN) },
      { id: "r4", conversation_id: "c", input_summary: "Hi", output: "  ", created_at: ago(1 * MIN) },
    ];
    const sent = new Map([["b", ago(20 * MIN)]]);
    expect(readyDrafts(runs, sent).map((d) => d.runId)).toEqual(["r2"]);
    useRows({
      ai_runs: [
        { id: "auto", organization_id: ORG, task: "suggest_reply", status: "ok", user_id: null, conversation_id: "a", input_summary: "Q", output: "Draft", created_at: ago(MIN) },
        { id: "manual", organization_id: ORG, task: "suggest_reply", status: "ok", user_id: "u1", conversation_id: "b", input_summary: "Q", output: "Mine", created_at: ago(MIN) },
      ],
      messages: [],
      conversations: [{ id: "a", contact: contact("k", "Asha") }],
    });
    const { loadReadyDrafts } = await import("./new-home-data");
    const drafts = await loadReadyDrafts(ORG, NOW);
    expect(drafts!.map((d) => d.runId)).toEqual(["auto"]);
    expect(drafts![0]!.contact?.name).toBe("Asha");
  });
});

describe("Aiden's feed: only replies that reached a customer", () => {
  it("skips background runs inside a chat (a photo described) and keeps one per chat", async () => {
    const { sentAidenReplies } = await import("./new-home");
    const runs = [
      { conversation_id: "a", output: "Yes, we deliver to Pune.", input_summary: "Pune?", sources: [], created_at: ago(2 * MIN) },
      { conversation_id: "a", output: "A gold ring on a red cloth.", input_summary: "Describe this picture.", sources: [], created_at: ago(3 * MIN) },
      { conversation_id: "b", output: "Open 11 to 8.", input_summary: "Sunday?", sources: [], created_at: ago(9 * MIN) },
      { conversation_id: "b", output: "Older answer.", input_summary: "Older?", sources: [], created_at: ago(40 * MIN) },
    ];
    const messages = [
      { conversation_id: "a", direction: "outbound" as const, body: "Yes, we deliver to Pune.", sent_by: null, metadata: null, created_at: ago(2 * MIN - 2000) },
      { conversation_id: "b", direction: "outbound" as const, body: "Open 11 to 8.", sent_by: null, metadata: null, created_at: ago(9 * MIN - 2000) },
      { conversation_id: "b", direction: "outbound" as const, body: "Older answer.", sent_by: null, metadata: null, created_at: ago(40 * MIN - 2000) },
      // A person's reply with the same words is not Aiden's.
      { conversation_id: "a", direction: "outbound" as const, body: "A gold ring on a red cloth.", sent_by: "u1", metadata: null, created_at: ago(MIN) },
    ];
    const feed = sentAidenReplies(runs, messages);
    expect(feed.map((f) => [f.conversationId, f.reply])).toEqual([
      ["a", "Yes, we deliver to Pune."],
      ["b", "Open 11 to 8."],
    ]);
  });
});

describe("live: realtime adds an item without a reload", () => {
  it("listens like the Inbox (messages + conversations, server-filtered by workspace) and re-reads", async () => {
    vi.useFakeTimers();
    const { liveHomeReload, SETTLE_MS } = await import("@/components/home-v2/use-new-home");
    const reload = vi.fn();
    const stop = liveHomeReload(ORG, reload);
    const ch = h.channels[0]!;
    expect(ch.topic).toBe(`home:${ORG}`);
    expect(ch.on.map((o) => [o.table, o.filter])).toEqual([
      ["messages", `organization_id=eq.${ORG}`],
      ["conversations", `organization_id=eq.${ORG}`],
    ]);
    // A burst of changes reads once.
    ch.on[0]!.cb({ new: { direction: "outbound" } });
    ch.on[1]!.cb({ new: {} });
    vi.advanceTimersByTime(400);
    expect(reload).toHaveBeenCalledTimes(1);
    // A customer's message: read now, and again once Aiden's reply or draft has landed.
    ch.on[0]!.cb({ new: { direction: "inbound" } });
    vi.advanceTimersByTime(400);
    expect(reload).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(reload).toHaveBeenCalledTimes(3);
    stop();
    expect(ch.removed).toBe(true);
    ch.on[0]!.cb({ new: { direction: "inbound" } });
    vi.advanceTimersByTime(SETTLE_MS * 2);
    expect(reload).toHaveBeenCalledTimes(3);
  });

  it("a reply Aiden sends after the page loaded appears in the feed on the next change", async () => {
    const reply = (cid: string, text: string, q: string, at: number) => ({
      run: { organization_id: ORG, task: "agent_reply", status: "ok", conversation_id: cid, output: text, input_summary: q, sources: [], created_at: ago(at) },
      msg: { conversation_id: cid, direction: "outbound", body: text, sent_by: null, metadata: null, created_at: ago(at - 1000) },
    });
    const first = reply("a", "Yes, open on Sunday.", "Sunday?", 10 * MIN);
    const base = {
      ai_agents: [{ organization_id: ORG, is_default: true, mode: "replying" }],
      organization_ai_settings: [{ organization_id: ORG, ai_enabled: true }],
      conversations: [{ id: "a", contact: contact("ka", "Asha Iyer") }, { id: "b", contact: contact("kb", "Rohan Das") }],
    };
    useRows({ ...base, ai_runs: [first.run], messages: [first.msg] });
    const { loadNewHome, liveHomeReload } = await import("@/components/home-v2/use-new-home");
    const { ReplyingView } = await import("@/components/home-v2/replying-view");
    let data = await loadNewHome(ORG, "Asia/Kolkata", ACCESS, NOW);
    const html = () => renderToStaticMarkup(<ReplyingView data={data} headline="Aiden is replying" stats={[]} />);
    expect(html()).toContain("Yes, open on Sunday.");
    expect(html()).not.toContain("We deliver to Pune");

    // Aiden answers a new customer; the realtime insert arrives.
    const second = reply("b", "We deliver to Pune in 2 days.", "Pune?", MIN);
    useRows({ ...base, ai_runs: [second.run, first.run], messages: [second.msg, first.msg] });
    vi.useFakeTimers();
    const reloaded = new Promise<void>((resolve) => {
      liveHomeReload(ORG, () => {
        void loadNewHome(ORG, "Asia/Kolkata", ACCESS, NOW).then((d) => {
          data = d;
          resolve();
        });
      });
    });
    h.channels.at(-1)!.on[0]!.cb({ new: { direction: "outbound", conversation_id: "b" } });
    vi.advanceTimersByTime(400);
    vi.useRealTimers();
    await reloaded;
    expect(data.feed!.map((f) => f.contact?.name)).toEqual(["Rohan Das", "Asha Iyer"]);
    expect(html()).toContain("We deliver to Pune in 2 days.");
    expect(html()).toContain("Rohan Das");
  });

  it("the Inbox keeps its own channel through the same helper", () => {
    const inbox = readFileSync(join(process.cwd(), "src/components/inbox/inbox-view.tsx"), "utf8");
    expect(inbox).toMatch(/subscribeInboxChanges\(`inbox:\$\{orgId\}`, orgId, \{/);
  });
});

describe("the three Homes, drawn", () => {
  const base = {
    mode: "replying" as const,
    aiEnabled: true,
    summary: SUMMARY,
    sales: { label: "Sales from chats", value: 184000, currency: "INR" },
    active: 3,
    feed: null,
    needsYou: null,
    drafts: null,
    draftsToday: null,
    openChats: null,
    flows: null,
    campaign: null,
    teammates: [],
  };

  it("replying: headline, the feed, what needs you, today", async () => {
    const { ReplyingView } = await import("@/components/home-v2/replying-view");
    const { replyingHeadline } = await import("./new-home");
    expect(replyingHeadline(3)).toBe("Aiden is replying to 3 customers");
    expect(replyingHeadline(1)).toBe("Aiden is replying to 1 customer");
    expect(replyingHeadline(0)).toBe("Aiden is on, no one is waiting");
    const html = renderToStaticMarkup(
      <ReplyingView
        data={{
          ...base,
          feed: [{ conversationId: "a", question: "Sunday?", reply: "Open 11 to 8.", at: ago(MIN), contact: contact("k", "Asha Iyer") }],
          needsYou: {
            items: [{ key: "c-1", conversationId: "c1", who: "Rohan Das", question: "Can I get a refund?", at: ago(MIN) }],
            total: 1,
          },
        }}
        headline={replyingHeadline(3)}
        stats={[{ label: "Chats", value: 48 }]}
      />,
    );
    expect(html).toContain("Aiden is replying to 3 customers");
    expect(html).toContain("Aiden has sent 41 replies today. One thing needs you.");
    expect(html).toContain("Open 11 to 8.");
    expect(html).toContain("Needs you");
    expect(html).toContain('href="/app/inbox?c=c1"');
    expect(html).toContain("Reply to Rohan");
    expect(html).toContain("Today");
    // Nothing waiting: no gold card at all.
    const calm = renderToStaticMarkup(
      <ReplyingView data={{ ...base, needsYou: { items: [], total: 0 } }} headline="x" stats={[]} />,
    );
    expect(calm).not.toContain("Needs you");
    expect(calm).toContain("Nothing needs you right now.");
  });

  it("drafts: the stack with Send, Edit and Write my own; All caught up when empty", async () => {
    const { DraftsView } = await import("@/components/home-v2/drafts-view");
    const { draftsHeadline } = await import("./new-home");
    const draft = (id: string, name: string) => ({
      runId: id,
      conversationId: `c-${id}`,
      question: `Question ${id}`,
      draft: `Draft ${id}`,
      at: ago(MIN),
      contact: contact(`k-${id}`, name),
    });
    const html = renderToStaticMarkup(
      <DraftsView
        data={{ ...base, mode: "draft", drafts: [draft("1", "Asha Iyer"), draft("2", "Rohan Das")] }}
        organizationId={ORG}
        canReply
        stats={[]}
        headlineFor={draftsHeadline}
        onSent={() => {}}
      />,
    );
    expect(html).toContain("2 replies are ready for you");
    expect(html).toContain("Draft 1");
    expect(html).toContain(">Send<");
    expect(html).toContain(">Edit<");
    expect(html).toContain(">Write my own<");
    // Only the top card is reachable; the one behind it is drawn but inert.
    expect(html.match(/>Send</g)).toHaveLength(1);
    expect(html).toMatch(/data-pos="1"[^>]*aria-hidden="true"/);
    const empty = renderToStaticMarkup(
      <DraftsView data={{ ...base, mode: "draft", drafts: [] }} organizationId={ORG} canReply stats={[]} headlineFor={draftsHeadline} onSent={() => {}} />,
    );
    expect(empty).toContain("All caught up");
    // Someone without inbox.reply sees the chat link, not Send.
    const viewer = renderToStaticMarkup(
      <DraftsView data={{ ...base, mode: "draft", drafts: [draft("1", "Asha Iyer")] }} organizationId={ORG} canReply={false} stats={[]} headlineFor={draftsHeadline} onSent={() => {}} />,
    );
    expect(viewer).not.toContain(">Send<");
    expect(viewer).toContain('href="/app/inbox?c=c-1"');
  });

  it("off: waiting oldest first, the gold card for closing windows, flows today, try draft mode", async () => {
    const { OffView } = await import("@/components/home-v2/off-view");
    const { waitingQueue, closingWindows, waitingHeadline } = await import("./new-home");
    const chat = (id: string, name: string, at: number, direction: string, lastIn: number | null) => ({
      id,
      status: "open",
      assigned_to: null,
      whatsapp_account_id: null,
      needs_human: false,
      last_message_at: ago(at),
      contact: contact(`k-${id}`, name),
      preview: { body: `Message from ${name}`, type: "text", direction, created_at: ago(at) },
      lastInboundAt: lastIn === null ? null : ago(lastIn),
    });
    const openChats = [
      chat("new", "Neha Menon", 3 * MIN, "inbound", 3 * MIN),
      chat("old", "Priya Reddy", 26 * MIN, "inbound", 26 * MIN),
      chat("answered", "Sana Iqbal", 10 * MIN, "outbound", 23 * HOUR),
    ];
    const queue = waitingQueue(openChats, NOW);
    expect(queue.map((w) => w.conversation.id)).toEqual(["old", "new"]);
    const closing = closingWindows(openChats.map((c) => ({ conversationId: c.id, lastInboundAt: c.lastInboundAt })), NOW);
    const props = {
      data: {
        ...base,
        mode: "off" as const,
        openChats,
        flows: { flows: [{ flowId: "f", name: "Welcome message", runs: 22 }], total: 22 },
      },
      organizationId: ORG,
      queue,
      closing,
      headlineFor: waitingHeadline,
      canReply: true,
      canAssign: false,
      stats: [],
    };
    const html = renderToStaticMarkup(<OffView {...props} tryDraft={() => {}} />);
    expect(html).toContain("2 customers are waiting");
    expect(html.indexOf("Priya Reddy")).toBeLessThan(html.indexOf("Neha Menon"));
    expect(html).toContain("nd-oldest");
    expect(html).toContain("Free replies running out");
    expect(html).toContain("1 chat loses the free 24-hour window within 2 hours.");
    expect(html).toContain("1 hour left");
    expect(html).toContain("Your flows today");
    expect(html).toContain("Welcome message");
    expect(html).toContain("Try Aiden in draft mode");
    // A plan without AI, or a role that can't change Aiden: no nudge.
    expect(renderToStaticMarkup(<OffView {...props} tryDraft={null} />)).not.toContain("Try Aiden in draft mode");
    expect(waitingHeadline(1)).toBe("1 customer is waiting");
  });
});

describe("flag off: today's Home, unchanged", () => {
  it("the route draws the Batch 41 Home when new_design is off and the new one only when on", async () => {
    const { Route } = await import("@/routes/app/index");
    // The router plugin splits the route's component out: load it, then ask it.
    const lazy = Route.options.component as unknown as {
      (props: object): { type: () => { type: { name: string } } };
      preload: () => Promise<void>;
    };
    await lazy.preload();
    const homeRoute = lazy({}).type;
    h.newDesign = false;
    expect(homeRoute().type.name).toBe("AppHome");
    h.newDesign = true;
    expect(homeRoute().type.name).toBe("NewHome");
    h.newDesign = false;
  });

  it("the Batch 41 Home's code is byte for byte what main had", () => {
    const file = readFileSync(join(process.cwd(), "src/routes/app/index.tsx"), "utf8");
    const classic = file.slice(file.indexOf("const SOURCE_LABEL"));
    expect(createHash("sha256").update(classic).digest("hex")).toBe(
      "e86666478cf7fc8cda532fb9e73cdf09afc5ad33fb21725c9e06bd17180e8cf1",
    );
  });
});
