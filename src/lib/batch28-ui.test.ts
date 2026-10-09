import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fakeDb } from "./test-support/fake-db";

/**
 * Batch 28 item 7 — the small UI fixes found on aidwar.in (8 Oct). The
 * "Waiting for you" banner (item 1) and campaign counts (item 8) have their
 * own tests in batch28-handoff / batch28-campaigns.
 */

const src = (path: string) => readFileSync(join(import.meta.dirname, "..", path), "utf8");

describe("AI employee page", () => {
  it("'Aiden isn't set up yet' only while nothing has been read", async () => {
    const { hasReadSomething } = await import("../components/aiden-setup-card");
    expect(hasReadSomething([])).toBe(false);
    expect(hasReadSomething([{ status: "pending", item_count: 0 }, { status: "syncing", item_count: 0 }])).toBe(false);
    expect(hasReadSomething([{ status: "ready", item_count: 0 }])).toBe(true);
    expect(hasReadSomething([{ status: "error", item_count: 7 }])).toBe(true);
    expect(src("components/aiden-setup-card.tsx")).toMatch(/if \(!handoff \|\| !sourcesLoaded \|\| hasReadSomething\(sources\)\) return null;/);
    // The server's card check says the same (7 items + a read site showed the card).
    expect(src("routes/api/onboarding/start.ts")).toMatch(/\.or\("item_count\.gt\.0,status\.eq\.ready"\)/);
  });

  it("switched off for the workspace: that state shows first and Draft / Replying wait until it is on", () => {
    const page = src("routes/app/employee.tsx");
    expect(page.indexOf("I'm switched off here")).toBeLessThan(page.indexOf('id="mode-heading"'));
    expect(page).toMatch(/const locked = !aiEnabled && option\.key !== "off";/);
    expect(page).toMatch(/disabled=\{!canConfigure \|\| locked\}/);
    expect(page).toMatch(/!aiEnabled \? "Switched off"/);
  });
});

describe("Inbox", () => {
  it("a thread opens on its newest messages (it loaded the oldest 500)", async () => {
    const { latestThreadMessages, THREAD_MESSAGE_LIMIT } = await import("../components/inbox/inbox-utils");
    const newestFirst = [{ id: "m3", created_at: "3" }, { id: "m2", created_at: "2" }, { id: "m1", created_at: "1" }];
    const db = fakeDb(() => ({ data: newestFirst, error: null }));
    const rows = await latestThreadMessages(db.supabase as never, "cv1");
    expect(rows.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    const op = db.ops[0]!;
    expect(db.has(op, "order", "created_at", { ascending: false })).toBe(true);
    expect(db.has(op, "limit", THREAD_MESSAGE_LIMIT)).toBe(true);
  });

  it("scrolls to the newest message once the chat has loaded, also when the new chat has as many messages", () => {
    const thread = src("components/inbox/chat-thread.tsx");
    expect(thread).toMatch(/\}, \[messages\.length, lastMessageId, conversation\.id, loading\]\);/);
    expect(thread).toMatch(/if \(loading\) return;/);
  });

  it("the newest open wins and the ?c= link never overrides a click (the ignored first click)", () => {
    const view = src("components/inbox/inbox-view.tsx");
    expect(view).toMatch(/const seq = \+\+openSeq\.current;/);
    expect(view).toMatch(/if \(seq !== openSeq\.current\) return;/);
    expect(view).toMatch(/if \(activeIdRef\.current === null\) void openConversation\(wanted\);/);
    expect(view).not.toMatch(/\.order\("created_at", \{ ascending: true \}\)\s*\.limit\(500\)/);
  });
});

describe("Home", () => {
  it("'today' starts at local midnight, the boundary Analytics uses", async () => {
    const { localDayStartIso } = await import("./local-day");
    // 00:30 IST on 9 Oct = 19:00 UTC on 8 Oct: today began at 18:30 UTC on 8 Oct.
    expect(localDayStartIso("Asia/Kolkata", new Date("2026-10-08T19:00:00Z"))).toBe("2026-10-08T18:30:00.000Z");
    // 23:59 IST on 8 Oct.
    expect(localDayStartIso("Asia/Kolkata", new Date("2026-10-08T18:29:00Z"))).toBe("2026-10-07T18:30:00.000Z");
    expect(localDayStartIso("UTC", new Date("2026-10-08T23:59:59Z"))).toBe("2026-10-08T00:00:00.000Z");
  });

  it("'Conversations today' counts chats with a customer message today, from the messages (as Analytics)", async () => {
    const { getHomeSummary } = await import("./home.server");
    const db = fakeDb((op) => {
      if (op.table === "organizations") return { data: { timezone: "Asia/Kolkata" }, error: null };
      if (op.table === "conversations") return { data: null, error: null, count: 1 };
      return { data: [], error: null, count: 0 };
    });
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-08T19:00:00Z") });
    try {
      const out = await getHomeSummary(db.supabase, "org-1");
      expect(out.today.conversations).toBe(1);
    } finally {
      vi.useRealTimers();
    }
    const q = db.ops.find((o) => o.table === "conversations")!;
    expect(q.select?.[0]).toBe("id, messages!inner(id)");
    expect(db.has(q, "eq", "messages.direction", "inbound")).toBe(true);
    expect(db.has(q, "gte", "messages.created_at", "2026-10-08T18:30:00.000Z")).toBe(true);
  });

  it("credits show two decimals, the same as Billing", async () => {
    const { money } = await import("./billing");
    expect(money(98.76)).toBe("₹98.76");
    expect(money(99)).toBe("₹99.00");
    const home = src("routes/app/index.tsx");
    expect(home).toMatch(/const credits = data\.credits \? money\(data\.credits\.balance/);
    expect(home).not.toMatch(/maximumFractionDigits: 0,\s*\}\)\.format\(data\.credits\.balance\)/);
  });
});

describe("Flows page", () => {
  it("a flow that is off says its messages are ready, never 'switched on'", async () => {
    const { flowStepsLabel } = await import("./flows");
    expect(flowStepsLabel(false, 2, 2)).toBe("2 messages ready");
    expect(flowStepsLabel(false, 1, 2)).toBe("1 message ready");
    expect(flowStepsLabel(true, 2, 2)).toBe("2 of 2 messages switched on");
    expect(src("components/flows/flows-view.tsx")).toMatch(/flowStepsLabel\(flow\.is_enabled,/);
  });
});
