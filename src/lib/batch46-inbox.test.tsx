import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Batch 46 — the Inbox in the new design (docs/design/preview.html #inbox),
 * behind `new_design`. These lock: the tabs map onto the classic filters, the
 * 24-hour chip's edges, take over / hand back use only the classic writes,
 * the phone's back arrow, a long list stays windowed, and with the flag off
 * the route still renders the classic Inbox.
 */

const h = vi.hoisted(() => ({ newDesign: false }));
vi.mock("@/lib/new-design", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/new-design")>()),
  useNewDesign: () => h.newDesign,
}));
vi.mock("@/hooks/use-feature-flag", () => ({
  useFeatureFlag: () => ({ enabled: true, loading: false }),
}));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ can: () => true, reasonFor: () => null, loading: false }),
}));
vi.mock("@/lib/org-context", () => ({ useOrg: () => ({}) }));
vi.mock("@/components/inbox/inbox-view", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/inbox/inbox-view")>()),
  InboxView: () => <div data-testid="classic-inbox" />,
}));
vi.mock("@/components/inbox/v2/new-inbox-view", () => ({
  NewInboxView: () => <div data-testid="new-inbox" />,
}));
vi.mock("@/components/onboarding/inbox-tour", () => ({ InboxTour: () => null }));

import {
  filterChats,
  initialView,
  inView,
  isAidenChat,
  phonePane,
  productCaption,
  tabLabel,
  takeoverPlan,
  windowChip,
  type InboxView,
} from "@/components/inbox/v2/inbox-v2";
import type { ConversationRow } from "@/components/inbox/inbox-utils";

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const row = (over: Partial<ConversationRow> & { id: string }): ConversationRow => ({
  status: "open",
  assigned_to: null,
  whatsapp_account_id: "n1",
  last_message_at: null,
  last_customer_message_at: null,
  unread_count: 0,
  needs_human: false,
  contact: { id: `c-${over.id}`, name: `Name ${over.id}`, phone: `+9100000${over.id}` },
  preview: null,
  ...over,
});

const ME = "me";
const chats: ConversationRow[] = [
  row({ id: "1", needs_human: true }), // waiting, unassigned
  row({ id: "2", needs_human: true, assigned_to: "neha", status: "closed" }), // waiting + closed
  row({ id: "3" }), // Aiden on it
  row({ id: "4", assigned_to: ME }), // taken over by me
  row({ id: "5", status: "closed" }), // done
  row({ id: "6", assigned_to: "neha", unread_count: 2, whatsapp_account_id: "n2" }),
];

/** The classic InboxView's filter, as written in inbox-view.tsx (Batch 39). */
function classic(c: ConversationRow, filter: "all" | "needs_human" | "open" | "closed" | "mine") {
  if (filter === "needs_human" && !c.needs_human) return false;
  if (filter === "open" && c.status !== "open") return false;
  if (filter === "closed" && c.status !== "closed") return false;
  if (filter === "mine" && c.assigned_to !== ME) return false;
  return true;
}

describe("tabs map onto the existing Inbox filters", () => {
  it("Waiting for you = needs_human, Done = closed; All, Open, Assigned to me are the classic filters", () => {
    const pairs: Array<[InboxView, "all" | "needs_human" | "open" | "closed" | "mine"]> = [
      ["waiting", "needs_human"],
      ["done", "closed"],
      ["all", "all"],
      ["open", "open"],
      ["mine", "mine"],
    ];
    for (const [view, filter] of pairs) {
      expect(chats.filter((c) => inView(c, view, ME)).map((c) => c.id)).toEqual(
        chats.filter((c) => classic(c, filter)).map((c) => c.id),
      );
    }
    // The classic filter still reads exactly so (so the mapping above is the real one).
    const view = src("components/inbox/inbox-view.tsx");
    expect(view).toContain(`if (filter === "needs_human" && !c.needs_human) return false;`);
    expect(view).toContain(`if (filter === "closed" && c.status !== "closed") return false;`);
  });

  it("Aiden on it = open, nobody waiting, nobody holding it (the chats Aiden answers)", () => {
    expect(chats.filter((c) => inView(c, "aiden", ME)).map((c) => c.id)).toEqual(["3"]);
    expect(isAidenChat(row({ id: "x", status: "pending" }))).toBe(false);
    // ai-agent.server.ts skips exactly these: an assigned chat and one waiting on a person.
    const agent = src("lib/ai-agent.server.ts");
    expect(agent).toContain(`reason: "assigned_to_human"`);
    expect(agent).toContain(`reason: "awaiting_human"`);
  });

  it("only says Aiden is on it when Aiden replies in the workspace", () => {
    expect(tabLabel("aiden", "replying")).toBe("Aiden on it");
    expect(tabLabel("aiden", null)).toBe("Aiden on it");
    expect(tabLabel("aiden", "off")).toBe("Nobody on it");
    expect(tabLabel("aiden", "draft")).toBe("Nobody on it");
    expect(tabLabel("waiting", "off")).toBe("Waiting for you");
    expect(tabLabel("done", "replying")).toBe("Done");
  });

  it("search, number and quick filters work as before on top of a tab", () => {
    const base = {
      view: "all" as InboxView,
      userId: ME,
      numberId: "all",
      quick: new Set<"unread" | "unassigned">(),
      search: "",
    };
    expect(filterChats(chats, { ...base, numberId: "n2" }).map((c) => c.id)).toEqual(["6"]);
    expect(filterChats(chats, { ...base, quick: new Set(["unread"]) }).map((c) => c.id)).toEqual([
      "6",
    ]);
    expect(
      filterChats(chats, { ...base, quick: new Set(["unassigned"]) }).map((c) => c.id),
    ).toEqual(["1", "3", "5"]);
    expect(filterChats(chats, { ...base, search: "name 4" }).map((c) => c.id)).toEqual(["4"]);
    expect(filterChats(chats, { ...base, search: "+91000005" }).map((c) => c.id)).toEqual(["5"]);
    expect(
      filterChats(chats, { ...base, view: "waiting", search: "name 2" }).map((c) => c.id),
    ).toEqual(["2"]);
  });

  it("opens on Waiting for you when someone waits, else on every chat", () => {
    expect(initialView(chats)).toBe("waiting");
    expect(initialView([row({ id: "9" })])).toBe("all");
    expect(initialView([])).toBe("all");
  });
});

describe("the 24-hour window chip", () => {
  const now = Date.parse("2026-10-29T12:00:00.000Z");
  const before = (ms: number) => new Date(now - ms).toISOString();
  const H = 3_600_000;

  it("counts down in hours, then minutes", () => {
    expect(windowChip(before(3 * H), now)).toMatchObject({
      open: true,
      closing: false,
      text: "Free replies for 21 more hours",
    });
    expect(windowChip(before(60_000), now).text).toBe("Free replies for 23 more hours");
    expect(windowChip(before(23 * H - 60_000), now).text).toBe("Free replies for 1 more hour");
    expect(windowChip(before(23 * H), now)).toMatchObject({
      text: "Free replies for 1 more hour",
      closing: true,
    });
    expect(windowChip(before(23 * H + 60_000), now)).toMatchObject({
      text: "Free replies for 59 more minutes",
      closing: true,
    });
    expect(windowChip(before(24 * H - 60_000), now).text).toBe("Free replies for 1 more minute");
  });

  it("exactly 24 hours is still open (every send path's rule), one millisecond later it is closed", () => {
    expect(windowChip(before(24 * H), now)).toMatchObject({
      open: true,
      text: "Free replies for less than a minute",
    });
    expect(windowChip(before(24 * H + 1), now)).toEqual({
      open: false,
      closing: false,
      text: "Window closed: send a template",
      minutesLeft: 0,
    });
  });

  it("closed when the customer never wrote, or the time is unreadable", () => {
    expect(windowChip(null, now).open).toBe(false);
    expect(windowChip(undefined, now).open).toBe(false);
    expect(windowChip("not a date", now).open).toBe(false);
    expect(windowChip(null, now).text).toBe("Window closed: send a template");
  });
});

describe("take over / hand back use the existing per-chat switch", () => {
  it("take over = assign to me; hand back = unassign and Mark as handled, only what is set", () => {
    expect(takeoverPlan({ assigned_to: null, needs_human: false }, ME)).toEqual({
      action: "take_over",
      label: "Take over from Aiden",
      writes: [{ assigned_to: ME }],
    });
    expect(takeoverPlan({ assigned_to: "neha", needs_human: false }, ME)).toMatchObject({
      action: "hand_back",
      label: "Hand back to Aiden",
      writes: [{ assigned_to: null }],
    });
    expect(takeoverPlan({ assigned_to: null, needs_human: true }, ME)?.writes).toEqual([
      { needs_human: false, needs_human_reason: null, handover_state: null },
    ]);
    expect(takeoverPlan({ assigned_to: ME, needs_human: true }, ME)?.writes).toEqual([
      { assigned_to: null },
      { needs_human: false, needs_human_reason: null, handover_state: null },
    ]);
    expect(takeoverPlan({ assigned_to: null, needs_human: false }, null)).toBeNull();
  });

  it("the new Inbox writes nothing the classic Inbox doesn't: same updates, same shared actions", () => {
    const classicView = src("components/inbox/inbox-view.tsx");
    const actions = src("lib/inbox-actions.ts");
    const hook = src("components/inbox/v2/use-inbox.ts");
    const updates = (code: string) =>
      [...code.matchAll(/\.update\((\{[^)]*\})\)/g)].map((m) => m[1]!.replace(/\s+/g, " "));
    // The hook's own updates are exactly the classic view's (unread, Mark as handled, close).
    expect(updates(hook)).toHaveLength(3);
    expect(updates(hook).sort()).toEqual(updates(classicView).sort());
    // Assign, text send and live updates: the helpers the classic Inbox and Home use (Batch 45).
    for (const shared of ["assignConversation(", "sendInboxText(", "subscribeInboxChanges("]) {
      expect(hook).toContain(shared);
      expect(classicView).toContain(shared);
    }
    expect(updates(actions)).toEqual(["{ assigned_to: assignee }"]);
    // No insert, upsert, delete or RPC of its own; its one endpoint is the classic template send.
    expect(hook).not.toMatch(/\.(insert|upsert|delete|rpc|channel)\(/);
    expect([...hook.matchAll(/"\/api\/[^"]+"/g)].map((m) => m[0])).toEqual([
      '"/api/whatsapp/send-message"',
    ]);
    expect(classicView).toContain('message_type: "template"');
    // Take over / hand back go only through the classic assign and Mark-as-handled writes.
    const takeover = hook.slice(
      hook.indexOf("const handleTakeover"),
      hook.indexOf("const handleToggleStatus"),
    );
    expect(takeover).toContain("takeoverPlan(");
    expect(takeover).toContain("handleAssign(");
    expect(takeover).toContain("handleResolveNeedsHuman(");
    expect(takeover).not.toContain(".update(");
    expect(takeover).not.toContain("callApi");
  });

  it("Aiden still skips a chat a person holds or one waiting on a person (the switch the buttons use)", () => {
    const agent = src("lib/ai-agent.server.ts");
    expect(agent).toContain("if (convo?.assigned_to) {");
    expect(agent).toContain("if (convo?.needs_human === true) {");
  });
});

describe("the phone layout", () => {
  it("shows the list first, the chat once one is open, and back returns to the list", () => {
    expect(phonePane(null)).toBe("list");
    expect(phonePane("c1")).toBe("chat");
    const view = src("components/inbox/v2/new-inbox-view.tsx");
    expect(view).toContain("onBack={() => setActiveId(null)}");
    // The bars step aside only inside an open chat on a phone.
    expect(view).toContain(`if (activeId && isPhone) root.setAttribute("data-chat-open", "");`);
    expect(view).toContain(`pane === "chat" ? "phone:hidden" : "flex"`);
  });

  it("the chat header has a back arrow on a phone only, and Take over is full width there", async () => {
    const { ChatPane } = await import("@/components/inbox/v2/chat-pane");
    const html = renderToStaticMarkup(
      <ChatPane
        conversation={row({ id: "1", last_customer_message_at: new Date().toISOString() })}
        messages={[]}
        members={[]}
        loading={false}
        sending={false}
        organizationId={null}
        userId={ME}
        aidenMode="replying"
        numberLabel={null}
        wabaId={null}
        onSend={async () => true}
        onSendTemplate={async () => true}
        onBack={() => {}}
        onAssign={() => {}}
        onToggleStatus={() => {}}
        onResolveNeedsHuman={() => {}}
        onTakeover={async () => {}}
        assignOpen={false}
        onAssignOpenChange={() => {}}
        onToggleDetails={() => {}}
      />,
    );
    expect(html).toMatch(
      /aria-label="Back to chats"[^>]*>|class="[^"]*wide:hidden[^"]*"[^>]*aria-label="Back to chats"/,
    );
    expect(html.match(/data-takeover="take_over"/g)).toHaveLength(2);
    expect(html).toContain("w-full wide:hidden");
    expect(html).toContain("hidden wide:inline-flex");
    expect(html).toContain("Free replies for 23 more hours");
    expect(html).toContain("Type a message, or / for templates");
  });
});

describe("a long list stays windowed", () => {
  it("1,200 chats draw only the rows on screen", async () => {
    const { ChatList, CHAT_ROW } = await import("@/components/inbox/v2/chat-list");
    const rows = Array.from({ length: 1200 }, (_, i) => row({ id: String(i) }));
    const html = renderToStaticMarkup(
      <ChatList
        rows={rows}
        members={[]}
        activeId={null}
        highlightIndex={-1}
        onOpen={() => {}}
        loading={false}
        totalLoaded={1200}
        viaLabel={() => null}
        aidenMode="replying"
      />,
    );
    const drawn = html.match(/<li /g)?.length ?? 0;
    expect(drawn).toBeGreaterThan(5);
    expect(drawn).toBeLessThan(40);
    expect(html).toContain(`height:${1200 * CHAT_ROW}px`);
    expect(html).toContain('aria-setsize="1200"');
    // Aiden's badge on the chats Aiden answers.
    expect(html).toContain(">Aiden</span>");
  });
});

describe("messages", () => {
  it("Aiden's replies are labelled Aiden, a product picture is a product card", async () => {
    const { MessageItem } = await import("@/components/inbox/v2/message-item");
    const msg = (over: Record<string, unknown>) =>
      ({
        id: "m",
        conversation_id: "c",
        direction: "outbound",
        type: "text",
        body: "Hello",
        media_url: null,
        media_mime: null,
        template_name: null,
        status: "read",
        error_detail: null,
        created_at: "2026-10-28T10:00:00Z",
        metadata: null,
        ...over,
      }) as never;
    const ai = renderToStaticMarkup(
      <MessageItem
        message={msg({})}
        organizationId="o"
        aiRun={{ question: "q", reply: "Hello", taughtOn: null }}
        teammate={null}
        fresh={false}
      />,
    );
    expect(ai).toContain(">Aiden</span>");
    expect(ai).toContain("Read");
    const person = renderToStaticMarkup(
      <MessageItem
        message={msg({ sent_by: "u" })}
        organizationId="o"
        aiRun={null}
        teammate="Riya"
        fresh={false}
      />,
    );
    expect(person).toContain(">Riya</span>");
    const product = renderToStaticMarkup(
      <MessageItem
        message={msg({
          type: "image",
          body: "Silk scarf — ₹1,200",
          media_url: "https://cdn.example/p.png",
          media_mime: "image/png",
          metadata: { kind: "ai_product" },
        })}
        organizationId="o"
        aiRun={null}
        teammate={null}
        fresh={false}
      />,
    );
    expect(product).toContain("<b");
    expect(product).toContain("Silk scarf");
    expect(product).toContain("₹1,200");
    const failed = renderToStaticMarkup(
      <MessageItem
        message={msg({ status: "failed" })}
        organizationId="o"
        aiRun={null}
        teammate={null}
        fresh={false}
      />,
    );
    expect(failed).toContain('aria-label="Failed to send"');
    expect(productCaption("Name only")).toEqual({ title: "Name only", detail: null });
    expect(productCaption("A — B\nC")).toEqual({ title: "A", detail: "B\nC" });
  });
});

describe("flag off: today's Inbox", () => {
  it("the route renders the classic Inbox with the flag off and the new one with it on", async () => {
    const { Route } = await import("../routes/app/inbox");
    const Page = (
      Route as unknown as {
        options: { component: React.ComponentType & { preload?: () => Promise<void> } };
      }
    ).options.component;
    await Page.preload?.();
    h.newDesign = false;
    const off = renderToStaticMarkup(<Page />);
    expect(off).toContain("classic-inbox");
    expect(off).not.toContain("new-inbox");
    h.newDesign = true;
    const on = renderToStaticMarkup(<Page />);
    expect(on).toContain("new-inbox");
    expect(on).not.toContain("classic-inbox");
  });

  it("the classic Inbox files only gained exports (no behaviour change)", () => {
    const view = src("components/inbox/inbox-view.tsx");
    expect(view).toContain("export function InboxView()");
    expect(view).not.toContain("v2/");
    for (const f of [
      "inbox-view.tsx",
      "chat-thread.tsx",
      "conversation-list.tsx",
      "contact-panel.tsx",
    ]) {
      expect(src(`components/inbox/${f}`)).not.toMatch(/new-design|useNewDesign|inbox\/v2/);
    }
  });
});
