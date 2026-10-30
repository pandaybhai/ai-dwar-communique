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
    expect(aidenTyping(chat, inbound, "replying", NOW).until).toBe(NOW - 5_000 + AIDEN_TYPING_MS);
    // Draft or Off: Aiden doesn't send, so it never "types".
    expect(aidenTyping(chat, inbound, "draft", NOW).typing).toBe(false);
    expect(aidenTyping(chat, inbound, "off", NOW).typing).toBe(false);
    expect(aidenTyping(chat, inbound, null, NOW).typing).toBe(false);
    // A person holds the chat, or it waits for a person, or it is closed.
    expect(aidenTyping({ ...chat, assigned_to: "u1" }, inbound, "replying", NOW).typing).toBe(
      false,
    );
    expect(aidenTyping({ ...chat, needs_human: true }, inbound, "replying", NOW).typing).toBe(
      false,
    );
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
      aidenTyping(
        chat,
        [{ direction: "inbound", created_at: at(AIDEN_TYPING_MS) }],
        "replying",
        NOW,
      ).typing,
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
    const stop = liveHomeReload(
      "org-1",
      () => undefined,
      (m) => seen.push(m),
    );
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
    for (const cls of [
      ".nd-rise",
      ".nd-dots > i",
      ".nd-pop",
      ".nd-spark",
      ".nd-lift",
      ".animate-pulse::after",
    ])
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

describe("Classic pieces inside Aiden Workspace (Mark all unknown, the drawer, page numbers, Analytics)", () => {
  it("without the new props, Classic draws main's markup byte for byte", async () => {
    // Classic has no shell section (the new_design suite fakes one for every page).
    vi.resetModules();
    vi.doMock("@/components/shell/section-tabs", async (orig) => ({
      ...(await orig<typeof import("@/components/shell/section-tabs")>()),
      useShellSection: () => null,
    }));
    vi.doMock("@/lib/whatsapp-client", () => ({
      callApi: async () => ({ data: null, error: null }),
    }));
    vi.doMock("@/integrations/aidwar/client", () => ({ aidwar: {} }));
    const { createHash } = await import("node:crypto");
    const { Inbox } = await import("lucide-react");
    const B = await import("@/components/contacts/bulk-opt-in");
    const D = await import("@/components/contacts/contact-drawer");
    const P = await import("@/components/data-pagination");
    const C = await import("@/components/analytics/chart-card");
    const consent = { opt_in_source: "import", opted_in_at: "2026-10-01T10:00:00Z" };
    const out: string[] = [];
    out.push(
      renderToStaticMarkup(<B.MarkAllUnknownOptedIn organizationId="o" onDone={() => {}} />),
    );
    for (const [current, value] of [
      ["unknown", "unknown"],
      ["unknown", "opted_out"],
      ["opted_in", "opted_in"],
      ["opted_out", "opted_out"],
    ] as const)
      out.push(
        renderToStaticMarkup(
          <D.OptInField current={current} value={value} consent={consent} onChange={() => {}} />,
        ),
      );
    for (const [page, total] of [
      [0, 0],
      [0, 2410],
      [3, 2410],
      [96, 2410],
    ])
      out.push(
        renderToStaticMarkup(
          <P.Pagination page={page!} pageSize={25} total={total!} onPageChange={() => {}} />,
        ),
      );
    for (const props of [{ loading: true }, { isEmpty: true }, {}])
      out.push(
        renderToStaticMarkup(
          <C.ChartCard
            title="Messages"
            description="Sent and read"
            emptyIcon={Inbox}
            emptyTitle="Nothing yet"
            emptyDescription="Send one"
            {...props}
          >
            <i>chart</i>
          </C.ChartCard>,
        ),
      );
    for (const props of [
      { loading: true },
      { rateText: "41%", rateLabel: "read", deltaText: "+3%", direction: 1 as const },
      {},
    ])
      out.push(renderToStaticMarkup(<C.MetricCard label="Delivered" value={12345} {...props} />));
    // Recorded from main (8e9ad6a) with the same props: Classic is unchanged.
    expect(createHash("sha256").update(out.join("\n")).digest("hex")).toBe(
      "640ecc0b5927fc2c6504ad5aebeba2bf5b5e7179860680303d9f6d8574f14a44",
    );
    vi.doUnmock("@/lib/whatsapp-client");
    vi.doUnmock("@/integrations/aidwar/client");
    vi.doUnmock("@/components/shell/section-tabs");
    vi.resetModules();
  });

  it("Aiden Workspace hands them its words; the requests stay the same", async () => {
    const { markAllCopy, drawerCopy } = await import("@/components/customers-v2/copy");
    const { PAGINATION_WORDS } = await import("@/components/design-v2/copy");
    const { Pagination } = await import("@/components/data-pagination");
    const { OptInField } = await import("@/components/contacts/contact-drawer");
    const page = renderToStaticMarkup(
      <Pagination
        page={0}
        pageSize={25}
        total={2410}
        onPageChange={() => {}}
        words={PAGINATION_WORDS}
      />,
    );
    expect(page).toContain("Showing 1 to 25 of 2,410");
    expect(page).toContain("phone:h-11");
    const field = renderToStaticMarkup(
      <OptInField
        current="opted_out"
        value="opted_out"
        consent={null}
        onChange={() => {}}
        words={drawerCopy.optIn}
      />,
    );
    expect(field).toContain("Said no to messages");
    expect(field).toContain("by replying START");
    expect(markAllCopy.button).toBe("Mark everyone with no answer as said yes");
    // The WhatsApp consent sentence is kept word for word.
    expect(markAllCopy.body).toContain(
      "WhatsApp requires consent, so do this only if these people agreed to hear from you.",
    );
    const bulk = src("components/contacts/bulk-opt-in.tsx");
    expect(bulk).toContain('body: { action: "count_unknown", organization_id: organizationId },');
    expect(bulk).toContain('body: { action: "all_unknown", organization_id: organizationId },');
    const view = src("components/customers-v2/new-contacts-view.tsx");
    expect(view).toContain("words={markAllCopy}");
    expect(view).toContain("words={drawerCopy}");
    expect(view).toContain("words={PAGINATION_WORDS}");
    // Analytics reads the new shell's section (null in Classic), never the flag hook.
    for (const f of [
      "routes/app/analytics.tsx",
      "components/analytics/analytics-view.tsx",
      "components/analytics/chart-card.tsx",
    ])
      expect(src(f)).toContain("useShellSection() !== null");
  });
});
