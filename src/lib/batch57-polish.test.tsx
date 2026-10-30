import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Batch 57 — Aiden Workspace polish, motion and copy. The new moments are
 * worked out from what each screen already reads (no new read, write or send),
 * Classic is untouched, and reduced motion shows every final state at once.
 */

const src = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");

describe("Aiden is typing (Inbox)", () => {
  const chat = { status: "open", needs_human: false, assigned_to: null } as const;
  const NOW = Date.parse("2026-10-30T10:00:00Z");
  const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

  it("shows only while a customer's newest message waits in a chat Aiden answers, in Replying", async () => {
    const { aidenTyping, AIDEN_TYPING_MS } = await import("@/components/inbox/v2/inbox-v2");
    const inbound = [{ direction: "inbound", created_at: at(5_000) }];
    expect(aidenTyping(chat, inbound, "replying", NOW).typing).toBe(true);
    expect(aidenTyping(chat, inbound, "replying", NOW).until).toBe(
      NOW - 5_000 + AIDEN_TYPING_MS,
    );
    // Draft or Off: Aiden doesn't send, so it never "types".
    expect(aidenTyping(chat, inbound, "draft", NOW).typing).toBe(false);
    expect(aidenTyping(chat, inbound, "off", NOW).typing).toBe(false);
    expect(aidenTyping(chat, inbound, null, NOW).typing).toBe(false);
    // A person holds the chat, or it waits for a person, or it is closed.
    expect(aidenTyping({ ...chat, assigned_to: "u1" }, inbound, "replying", NOW).typing).toBe(false);
    expect(aidenTyping({ ...chat, needs_human: true }, inbound, "replying", NOW).typing).toBe(false);
    expect(aidenTyping({ ...chat, status: "closed" }, inbound, "replying", NOW).typing).toBe(false);
    // The reply has gone out: the newest message is ours.
    expect(
      aidenTyping(
        chat,
        [...inbound, { direction: "outbound", created_at: at(1_000) }],
        "replying",
        NOW,
      ).typing,
    ).toBe(false);
    // Too long ago: never left typing for ever.
    expect(
      aidenTyping(chat, [{ direction: "inbound", created_at: at(AIDEN_TYPING_MS) }], "replying", NOW)
        .typing,
    ).toBe(false);
    expect(aidenTyping(chat, [], "replying", NOW).typing).toBe(false);
  });
});

describe("Home's greeting", () => {
  it("greets by first name at the time of day in the workspace's timezone", async () => {
    const { greetingFor, partOfDay, firstNameOf } = await import("./greeting");
    // 03:30 UTC is 09:00 in Kolkata, 20:30 the evening before in Los Angeles.
    const t = new Date("2026-10-30T03:30:00Z");
    expect(greetingFor("Riya Kapoor", "Asia/Kolkata", t)).toBe("Good morning, Riya");
    expect(greetingFor("Riya Kapoor", "America/Los_Angeles", t)).toBe("Good evening, Riya");
    expect(greetingFor(null, "Asia/Kolkata", t)).toBe("Good morning");
    expect(firstNameOf("riya@kesar.example")).toBeNull();
    expect(partOfDay(12)).toBe("Good afternoon");
    expect(partOfDay(17)).toBe("Good evening");
    expect(partOfDay(2)).toBe("Good evening");
    // An unknown zone falls back to the browser's clock instead of throwing.
    expect(greetingFor("Asha", "Not/AZone", t)).toMatch(/^Good (morning|afternoon|evening), Asha$/);
  });
});

describe("Home's live typing dots", () => {
  it("come from Home's existing realtime subscription; nothing new is read", async () => {
    const channels: Array<{ onMessage: (p: { new: unknown }) => void }> = [];
    vi.doMock("@/lib/inbox-realtime", () => ({
      subscribeInboxChanges: (
        _topic: string,
        _org: string,
        h: { onMessage: (p: { new: unknown }) => void },
      ) => {
        channels.push(h);
        return () => undefined;
      },
    }));
    const { liveHomeReload } = await import("@/components/home-v2/use-new-home");
    const seen: Array<{ conversationId: string; direction: string }> = [];
    const stop = liveHomeReload("org-1", () => undefined, (m) => seen.push(m));
    channels[0]!.onMessage({ new: { direction: "inbound", conversation_id: "c1" } });
    channels[0]!.onMessage({ new: { direction: "outbound", conversation_id: "c1" } });
    expect(seen).toEqual([
      { conversationId: "c1", direction: "inbound" },
      { conversationId: "c1", direction: "outbound" },
    ]);
    stop();
    vi.doUnmock("@/lib/inbox-realtime");
  });
});

describe("no new write, send or read path", () => {
  it("the polish pieces only draw", () => {
    const files = [
      "components/design-v2/typing-dots.tsx",
      "components/design-v2/sparkle.tsx",
      "components/design-v2/sticky-action.tsx",
      "components/magicui/confetti-burst.tsx",
      "components/home-v2/copy.ts",
      "components/inbox/v2/copy.ts",
      "lib/greeting.ts",
    ].map(src);
    for (const code of files) {
      expect(code).not.toMatch(/aidwar\.|callApi|fetch\(|\.from\("|\.rpc\(|send-message/);
    }
  });

  it("no new npm dependency (motion and tw-animate-css were already installed)", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["canvas-confetti"]).toBeUndefined();
    expect(pkg.dependencies["motion"]).toBeDefined();
  });

  it("every Batch 57 animation stops under reduced motion", () => {
    const css = src("styles.css");
    const reduced = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    for (const cls of [".nd-rise", ".nd-dots > i", ".nd-pop", ".nd-spark", ".nd-lift", '[data-slot="skeleton"]::after'])
      expect(reduced, cls).toContain(cls);
    // Only transform and opacity move (no transition: all anywhere new).
    expect(css).not.toMatch(/transition:\s*all/);
  });
});

describe("shared pieces render their final state under reduced motion", () => {
  it("typing dots are labelled, the sparkle chip still shows its words", async () => {
    vi.doMock("motion/react", async (orig) => ({
      ...(await orig<typeof import("motion/react")>()),
      useReducedMotion: () => true,
    }));
    const { TypingDots, SparkleChip } = await import("@/components/design-v2");
    expect(renderToStaticMarkup(<TypingDots />)).toContain('aria-label="Aiden is typing"');
    const chip = renderToStaticMarkup(<SparkleChip>New order today: ₹4,200</SparkleChip>);
    expect(chip).toContain("New order today: ₹4,200");
    expect(chip).not.toContain("nd-spark");
    vi.doUnmock("motion/react");
  });
});
