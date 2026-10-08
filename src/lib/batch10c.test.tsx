import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { fakeDb, type FakeOp } from "./test-support/fake-db";
import { engineTranscript, liveShapes } from "./test-support/live-flows";
import {
  MAX_FILLED_TAG,
  isBusinessOpen,
  parseDateAnswer,
  pickBranch,
  safeTimezone,
  tagOfNode,
  validateAnswer,
  validateGraph,
  type FlowGraph,
  type RunContext,
} from "./flow-graph";
import { simReply, simStart } from "./flow-simulator";
import { STARTERS } from "./flow-starters";
import { automationsNavHidden } from "./automations";
import { sheetAppendUrl } from "./flow-connections.server";

/**
 * Batch 10C:
 *  Cards — (2) a card already stored for the same values is reused, never
 *  drawn again (memory, then storage); (4) every real render is recorded on
 *  ai_usage through the service client, never a reuse, never a wallet debit;
 *  (3) the inbox shows a picture without words as just the picture.
 *  Flows — (5) Tag step {{variables}}; (6) business hours in the workspace's
 *  timezone, Google Sheets values RAW, date answers validated; (7) the three
 *  Automations as Flows templates, and the Automations menu rule.
 *  (Cards page previews, draft save errors and atomic publish: batch10c-routes.test.ts;
 *   every live flow unchanged: batch10c-replay.test.ts.)
 */

const h = vi.hoisted(() => ({ usage: null as null | ReturnType<typeof import("./test-support/fake-db").fakeDb> }));
vi.mock("@/lib/feature-flags.server", () => ({ enabledFlags: async () => new Set(["flows_v2"]) }));
vi.mock("@/lib/whatsapp-webhook.server", async (orig) => ({
  ...(await orig<typeof import("./whatsapp-webhook.server")>()),
  getServiceClient: () => h.usage!.supabase,
}));

const NOW = new Date("2026-10-05T05:30:00Z"); // Monday 11:00 in Asia/Kolkata
const ctx = (vars: Record<string, unknown> = {}, extra: Partial<RunContext> = {}): RunContext => ({
  vars,
  contact: { name: "Asha", phone: "919800000001", attributes: {} },
  tags: [],
  now: NOW,
  timezone: "Asia/Kolkata",
  ...extra,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env["AIDWAR_SUPABASE_URL"];
  delete process.env["AIDWAR_SUPABASE_SERVICE_ROLE_KEY"];
});

// ------------------------------------------------------------------ (2) + (4) card reuse and usage

describe("cards: reuse a stored card; record only real renders", () => {
  const STORED = (org: string) => `https://render.test/storage/v1/object/public/onboarding-cards/org/${org}/`;
  let renders: Array<Record<string, unknown>>;
  let heads: string[];
  beforeEach(() => {
    process.env["AIDWAR_SUPABASE_URL"] = "https://render.test";
    process.env["AIDWAR_SUPABASE_SERVICE_ROLE_KEY"] = "service-key";
    renders = [];
    heads = [];
    // ai_usage_add fails here, so usage is written row by row (the on-error path).
    h.usage = fakeDb(
      () => undefined,
      (c) => (c.name === "ai_usage_add" ? { data: null, error: { message: "timeout" } } : undefined),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  const brandDb = (branding: Record<string, unknown> = {}) =>
    fakeDb((op: FakeOp) => (op.table === "organizations" ? { data: { name: "Zoori", branding }, error: null } : undefined));
  const stub = (opts: { stored: boolean; cached?: boolean }) =>
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        heads.push(String(url));
        return opts.stored ? new Response(null, { status: 200, headers: { "content-type": "image/png" } }) : new Response(null, { status: 400 });
      }
      renders.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({ url: `${STORED("x")}drawn.png`, ...(opts.cached ? { cached: true } : {}) }));
    });
  const usageRows = () => h.usage!.ops.filter((o) => o.table === "ai_usage" && o.kind !== "select").map((o) => o.payload as Record<string, unknown>);

  it("a card already in storage (e.g. after a restart) is reused: not drawn, not recorded", async () => {
    const { renderCustomerCard, cardCacheKey, storedCardUrl, loadCardBranding } = await import("./customer-cards.server");
    stub({ stored: true });
    const db = brandDb();
    const vars = { headline: "Weekend", offer: "20% off", validity: "", code: "FEST20" };
    const url = await renderCustomerCard(db.supabase, { organizationId: "org-c1", kind: "customer_offer", vars });
    const key = cardCacheKey("org-c1", "customer_offer", { ...(await loadCardBranding(db.supabase, "org-c1")), ...vars });
    expect(url).toBe(storedCardUrl("https://render.test", key));
    expect(url).toMatch(/^https:\/\/render\.test\/storage\/v1\/object\/public\/onboarding-cards\/org\/org-c1\/customer_offer-[a-z0-9]+\.png$/);
    expect(renders).toEqual([]);
    expect(usageRows()).toEqual([]);
  });

  it("a miss is drawn once and recorded once as card_render (service client, ₹0.10 cost, nothing billed); the repeat is free", async () => {
    const { renderCustomerCard } = await import("./customer-cards.server");
    stub({ stored: false });
    const db = brandDb();
    const args = { organizationId: "org-c2", kind: "customer_offer", vars: { headline: "Diwali", offer: "10% off" } };
    expect(await renderCustomerCard(db.supabase, args)).toContain("drawn.png");
    expect(await renderCustomerCard(db.supabase, args)).toContain("drawn.png");
    expect(renders).toHaveLength(1);
    expect(renders[0]).toMatchObject({ kind: "customer_offer", cacheKey: expect.stringMatching(/^org\/org-c2\/customer_offer-/), vars: { brand_name: "Zoori", headline: "Diwali" } });
    expect(heads).toHaveLength(1);
    const rows = usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ organization_id: "org-c2", task: "card_render", runs: 1, cost_amount: 0.1 });
    expect(rows[0]).not.toHaveProperty("billed_amount");
    // The caller's (member) client never writes usage: ai_usage is read-only to members.
    expect(db.ops.some((o) => o.table === "ai_usage")).toBe(false);
    expect(h.usage!.ops.some((o) => o.table === "wallet_ledger") || h.usage!.rpcs.some((r) => r.name !== "ai_usage_add")).toBe(false);
  });

  it("render-card answering cached (it found the file itself) is a reuse: not recorded", async () => {
    const { renderCustomerCard } = await import("./customer-cards.server");
    stub({ stored: false, cached: true });
    await renderCustomerCard(brandDb().supabase, { organizationId: "org-c3", kind: "customer_appointment", vars: { date: "Sat", time: "4 pm", place: "Bandra" } });
    expect(renders).toHaveLength(1);
    expect(usageRows()).toEqual([]);
  });

  it("new brand paint is a new card (the key includes the logo, name and colours)", async () => {
    const { renderCustomerCard } = await import("./customer-cards.server");
    stub({ stored: false });
    const vars = { headline: "Same", offer: "Same" };
    await renderCustomerCard(brandDb({ brand_primary: "#111111" }).supabase, { organizationId: "org-c4", kind: "customer_offer", vars });
    await renderCustomerCard(brandDb({ brand_primary: "#222222" }).supabase, { organizationId: "org-c4", kind: "customer_offer", vars });
    expect(renders).toHaveLength(2);
    expect(renders[0]!["cacheKey"]).not.toBe(renders[1]!["cacheKey"]);
  });

  it("a slow or broken storage lookup just draws the card (a card never blocks a message)", async () => {
    const { renderCustomerCard } = await import("./customer-cards.server");
    vi.stubGlobal("fetch", async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") throw new Error("network down");
      renders.push({});
      return new Response(JSON.stringify({ url: "https://render.test/x.png" }));
    });
    expect(await renderCustomerCard(brandDb().supabase, { organizationId: "org-c5", kind: "customer_offer", vars: { headline: "x" } })).toBe("https://render.test/x.png");
    expect(renders).toHaveLength(1);
  });

  it("findStoredCustomerCard looks, never draws", async () => {
    const { findStoredCustomerCard } = await import("./customer-cards.server");
    stub({ stored: false });
    expect(await findStoredCustomerCard(brandDb().supabase, { organizationId: "org-c6", kind: "customer_offer", vars: { headline: "x" } })).toBeNull();
    stub({ stored: true });
    expect(await findStoredCustomerCard(brandDb().supabase, { organizationId: "org-c6", kind: "customer_offer", vars: { headline: "x" } })).toContain("/onboarding-cards/org/org-c6/");
    expect(renders).toEqual([]);
    expect(usageRows()).toEqual([]);
  });
});

// ------------------------------------------------------------------ (3) inbox

describe("inbox: a picture without words is just the picture", () => {
  const row = (over: Record<string, unknown>) => ({
    id: "m1",
    conversation_id: "cv1",
    direction: "outbound" as const,
    type: "image",
    body: "",
    media_url: "https://render.test/card.png",
    media_mime: null,
    template_name: null,
    status: "sent",
    error_detail: null,
    created_at: "2026-10-05T05:30:00Z",
    ...over,
  });
  it("card / image with no caption: no [image] line, the picture has an alt text", async () => {
    const { Bubble } = await import("@/components/inbox/chat-thread");
    const html = renderToStaticMarkup(<Bubble message={row({})} organizationId="org" agentName="Aiden" />);
    expect(html).not.toContain("[image]");
    expect(html).toContain('alt="Picture"');
    expect(html).toContain('src="https://render.test/card.png"');
  });
  it("with a caption, the caption shows as before", async () => {
    const { Bubble } = await import("@/components/inbox/chat-thread");
    const html = renderToStaticMarkup(<Bubble message={row({ body: "Just for you" })} organizationId="org" agentName="Aiden" />);
    expect(html).toContain("Just for you");
  });
  it("a message with no picture and no words keeps its stand-in (nothing else to show)", async () => {
    const { Bubble } = await import("@/components/inbox/chat-thread");
    const html = renderToStaticMarkup(<Bubble message={row({ media_url: null, type: "sticker" })} organizationId="org" agentName="Aiden" />);
    expect(html).toContain("[sticker]");
  });
});

// ------------------------------------------------------------------ (5) tag variables

describe("Tag step {{variables}}", () => {
  it("a tag without {{ }} is returned exactly as written", () => {
    expect(tagOfNode({ tag: "WhatsApp lead" }, ctx())).toBe("WhatsApp lead");
    expect(tagOfNode({ tag: "  VIP  " }, ctx())).toBe("  VIP  ");
    expect(tagOfNode({ tag: "50% off_a" }, ctx())).toBe("50% off_a");
  });
  it("fills variables, tidies spaces, caps the length; all-empty is ''", () => {
    expect(tagOfNode({ tag: "lead-{{product}}-{{budget}}" }, ctx({ product: "Rings", budget: "Under 25k" }))).toBe("lead-Rings-Under 25k");
    expect(tagOfNode({ tag: "{{product}}" }, ctx())).toBe("");
    expect(tagOfNode({ tag: " {{ product }} " }, ctx({ product: "  Gold  rings " }))).toBe("Gold rings");
    expect(tagOfNode({ tag: "{{note}}" }, ctx({ note: "x".repeat(300) }))).toHaveLength(MAX_FILLED_TAG);
    expect(tagOfNode({ tag: "city-{{contact.city}}" }, ctx({}, { contact: { name: "A", phone: "1", attributes: { city: "Pune" } } }))).toBe("city-Pune");
  });
  it("validation: {{variables}} in a tag must be set earlier, like any other step", () => {
    const g: FlowGraph = {
      nodes: [
        { id: "start", type: "start", data: {} },
        { id: "t", type: "tag", data: { tag: "lead-{{product}}", action: "add" } },
        { id: "end", type: "end", data: {} },
      ],
      edges: [
        { id: "1", source: "start", target: "t", sourceHandle: "next" },
        { id: "2", source: "t", target: "end", sourceHandle: "next" },
      ],
    };
    expect(validateGraph(g).map((p) => p.message)).toEqual(["Variable {{product}} is never set."]);
  });

  // Zoori's live flow, with its tag step set to use the answers.
  const zoori = () => {
    const g = structuredClone(liveShapes().find((s) => s.flow === "zoori welcome flow")!.graph);
    return (tag: string) => {
      const c = structuredClone(g);
      c.nodes.find((n) => n.type === "tag")!.data["tag"] = tag;
      return c;
    };
  };

  it("simulator: lead-{{product}}-{{budget}} after the menus", () => {
    const g = zoori()("lead-{{product}}-{{budget}}");
    let s = simStart(g, "Asha");
    for (const r of ["Rings", "Diamond", "Under 25k"]) s = simReply(g, s, r);
    expect(s.ctx.tags).toEqual(["lead-Rings-Under 25k"]);
    expect(s.messages.some((m) => m.kind === "note" && m.text === 'Adds tag "lead-Rings-Under 25k"')).toBe(true);
  });

  it("engine: the filled tag is added; an empty one is skipped and noted; the flow carries on", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const engine = await import("./flow-engine.server");
    const make = zoori();
    const taps = [{ tap: 0 }, { tap: 0 }, { tap: 0 }];
    const filled = await engineTranscript(engine, make("lead-{{product}}-{{budget}}"), taps, "org-tag-1");
    expect(filled.contact.tags).toEqual(["lead-Rings-Under 25k"]);
    expect(filled.run.status).toBe("done");
    const empty = await engineTranscript(engine, make("{{nothing_here}}"), taps, "org-tag-2");
    expect(empty.contact.tags).toEqual([]);
    expect(empty.writes.some((w) => w.startsWith("tag"))).toBe(false);
    expect(empty.events.some((e) => e.endsWith(':tag_skipped {"reason":"empty_after_variables"}'))).toBe(true);
    expect(empty.run.status).toBe("done");
    expect(empty.contact.attributes).toEqual({ budget: "Under 25k", interest: "Rings", stone: "Diamond" });
    // The live tag, as written: unchanged.
    const live = await engineTranscript(engine, make("WhatsApp lead"), taps, "org-tag-3");
    expect(live.contact.tags).toEqual(["WhatsApp lead"]);
  });
});

// ------------------------------------------------------------------ (6) business hours, sheets, dates

describe("business hours use the workspace's timezone", () => {
  const AWAY = STARTERS.find((s) => s.key === "away_message")!.graph();

  it("Monday 11:00 IST is open in Kolkata; the same moment is Sunday 22:30 in Los Angeles — closed", () => {
    expect(isBusinessOpen(undefined, NOW, "Asia/Kolkata")).toBe(true);
    expect(isBusinessOpen(undefined, NOW, "America/Los_Angeles")).toBe(false);
  });
  it("an unknown timezone falls back to Asia/Kolkata instead of failing the run", () => {
    expect(safeTimezone("Mars/Olympus")).toBe("Asia/Kolkata");
    expect(safeTimezone("")).toBe("Asia/Kolkata");
    expect(safeTimezone("Europe/London")).toBe("Europe/London");
    expect(() => isBusinessOpen(undefined, NOW, "Mars/Olympus")).not.toThrow();
  });
  it("simulator: answers in the workspace's timezone (left out: Asia/Kolkata, as before)", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    expect(simStart(AWAY, "Asha").messages.map((m) => m.text)).toEqual(["Business hours → Open", "Flow ended."]);
    expect(simStart(AWAY, "Asha", { timezone: "America/Los_Angeles" }).messages.map((m) => m.text)).toEqual([
      "Business hours → Closed",
      "Thanks for your message! We're away right now and will reply as soon as we're back.",
      "Flow ended.",
    ]);
  });
  it("a Business hours branch condition reads the flow's own schedule (Flow settings), like the step", () => {
    const closedMonday = { days: { "1": null }, holidays: [] };
    const branches = [{ id: "open", match: "all" as const, conditions: [{ subject: "business_hours", op: "eq" as const, value: "open" }] }];
    expect(pickBranch(branches, ctx())).toBe("open"); // no schedule: the default hours, as before
    expect(pickBranch(branches, ctx({}, { businessHours: closedMonday }))).toBe("else");
  });
});

describe("Google Sheets step writes values as written", () => {
  it("RAW, with the tab name quoted", () => {
    const url = sheetAppendUrl("https://docs.google.com/spreadsheets/d/abc_123/edit#gid=0", "Leads 2026");
    expect(url).toBe(
      `https://sheets.googleapis.com/v4/spreadsheets/abc_123/values/${encodeURIComponent("'Leads 2026'!A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    );
    expect(url).not.toContain("USER_ENTERED");
    expect(sheetAppendUrl("abc", "")).toContain(encodeURIComponent("'Sheet1'!A1"));
    expect(sheetAppendUrl("abc", "Rao's")).toContain(encodeURIComponent("'Rao''s'!A1"));
  });
});

describe("date answers", () => {
  it("real dates give the same yyyy-mm-dd as before", () => {
    for (const [i, o] of [["25-12-2026", "2026-12-25"], ["25/12/26", "2026-12-25"], ["5.1.2027", "2027-01-05"], ["25 12 2026", "2026-12-25"], ["2026-12-25", "2026-12-25"], ["29-02-2028", "2028-02-29"], ["25 Dec 2026", "2026-12-25"], ["December 25, 2026", "2026-12-25"], ["25th December 2026", "2026-12-25"]] as const)
      expect(validateAnswer("date", i)).toBe(o);
  });
  it("anything that isn't a real date is asked again", () => {
    for (const i of ["1", "12", "110001", "31-02-2026", "29-02-2026", "31-04-2026", "12/13/2026", "5 Nov", "tomorrow", "Decx 25 2026", "25 Mayo 2026", "0-0-2026", "01-01-1800"]) expect(parseDateAnswer(i)).toBeNull();
  });
  it("other answer kinds are untouched", () => {
    expect(validateAnswer("pincode", "110001")).toBe("110001");
    expect(validateAnswer("number", "₹1,200")).toBe("1200");
    expect(validateAnswer(undefined, " hi ")).toBe("hi");
  });
});

// ------------------------------------------------------------------ (7) templates + menu

describe("Automations → Flows templates", () => {
  it("Flows > New offers Welcome message, Keyword reply and Away message, right after Blank", () => {
    expect(STARTERS.slice(0, 4).map((s) => s.name)).toEqual(["Blank flow", "Welcome message", "Keyword reply", "Away message"]);
    // Every older template is still there, unchanged in order.
    expect(STARTERS.slice(4).map((s) => s.key)).toEqual(["welcome_menu", "lead_qualification", "appointment", "order_status", "feedback"]);
  });
  // The simulator answers Business hours from the clock: pin it, so the away
  // message runs while Los Angeles is closed (Sunday 05:00 PDT) on any day the
  // suite runs, and stays silent while it is open (Wednesday 11:00 PDT).
  const LA_CLOSED = new Date("2026-10-11T12:00:00Z");
  const LA_OPEN = new Date("2026-10-14T18:00:00Z");
  afterEach(() => vi.useRealTimers());
  it.each(["welcome_message", "keyword_reply", "away_message"])("%s validates clean and sends one message", (key) => {
    vi.useFakeTimers({ toFake: ["Date"], now: LA_CLOSED });
    const g = STARTERS.find((s) => s.key === key)!.graph();
    expect(validateGraph(g)).toEqual([]);
    const s = simStart(g, "Asha", { timezone: key === "away_message" ? "America/Los_Angeles" : "Asia/Kolkata" });
    expect(s.done).toBe(true);
    expect(s.messages.filter((m) => m.kind === "text")).toHaveLength(1);
    expect(g.nodes.filter((n) => n.type === "text")).toHaveLength(1);
  });
  it("away_message sends nothing while the workspace is open", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: LA_OPEN });
    const s = simStart(STARTERS.find((s) => s.key === "away_message")!.graph(), "Asha", { timezone: "America/Los_Angeles" });
    expect(s.done).toBe(true);
    expect(s.messages.filter((m) => m.kind === "text")).toHaveLength(0);
  });
  it("the Automations menu hides only for a workspace known to have none", () => {
    expect(automationsNavHidden(0)).toBe(true);
    expect(automationsNavHidden(1)).toBe(false);
    expect(automationsNavHidden(null)).toBe(false);
  });
});
