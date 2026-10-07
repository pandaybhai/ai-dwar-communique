import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { zooriWorld, type Case, type Replay } from "./test-support/zoori-replay";

/**
 * Batch 16 — Aiden never goes silent when it doesn't know.
 *
 * Item 1: not knowing files the question for the merchant and keeps Aiden
 * on the chat (no needs_human); a customer asking for a person still hands
 * the chat over; a flow's Assign step (needs_human) still silences Aiden.
 * Same Zoori world as the Batch 14 replay — only the model is scripted.
 */

vi.mock("@/lib/feature-flags.server", () => ({
  enabledFlags: async () => new Set(["ai_features", "catalog"]),
}));

// The catalogue tools run for real against the Zoori rows; only the
// permission broker around them is stubbed (the agent role holds catalog.view).
vi.mock("@/lib/ai-tools.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("./ai-tools.server")>();
  const { allAiTools } = await import("./feature-registry");
  const offered = () =>
    allAiTools()
      .filter((t) => t.name === "catalog_search" || t.name === "send_products")
      .map(({ flag_key: _flag, ...tool }) => tool);
  return {
    ...real,
    brokerTools: async () => offered(),
    invokeTool: async (
      ctx: Parameters<typeof real.invokeTool>[0],
      name: string,
      args: Record<string, unknown>,
    ) => {
      const tool = offered().find((t) => t.name === name);
      if (!tool)
        return {
          ok: false,
          error: "That tool isn't available to you in this workspace.",
          latencyMs: 1,
          activityLogId: null,
          arguments: args,
          resultSummary: {},
        };
      // As invokeTool does: a brokered call (Batch 14.1 gender rule).
      const out = await real.AI_TOOL_HANDLERS[tool.handler]!({ ...ctx, brokered: true }, args);
      return {
        ...out,
        latencyMs: 1,
        activityLogId: null,
        arguments: args, // The broker's own trace summary (older builds, recorded as baselines, have none).
        resultSummary: typeof real.summarise === "function" ? real.summarise(out) : {},
      };
    },
  };
});

beforeAll(() => {
  process.env["LOVABLE_API_KEY"] = "test-key";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllGlobals());

async function replay(c: Case, gate?: Record<string, unknown>): Promise<{ r: Replay; outcome: Record<string, unknown> }> {
  const world = zooriWorld(c);
  vi.stubGlobal("fetch", world.fetchStub);
  const { runAgentOnInbound } = await import("./ai-agent.server");
  const args = { ...(world.args as Parameters<typeof runAgentOnInbound>[1]), ...(gate ? { gate: Promise.resolve(gate) } : {}) };
  const outcome = (await runAgentOnInbound(world.supabase, args)) as unknown as Record<string, unknown>;
  vi.unstubAllGlobals();
  return { r: world.result(), outcome };
}

describe("Batch 16 item 1: not knowing never silences Aiden", () => {
  it("no source: the only words left are the promise — sent, filed for the merchant, no hand-off", async () => {
    const { r } = await replay({
      id: "b16-no-source",
      ask: "do you do custom engraving on rings?",
      model: () => ({ text: 'Let me confirm that for you.\n{"needs_owner": true}' }),
    });
    expect(r.status).toBe("ok");
    expect(r.gapFiled).toBe(true);
    expect(r.handedOff ?? false).toBe(false);
    expect(r.sent.map((s) => s.text)).toEqual(["Let me confirm that for you."]);
  });

  it("the v4 rule's answer (no detail, closest thing, keep going) goes out as written, no hand-off", async () => {
    const words = "I don't have engraving details yet — you can reach the showroom team on the number on our website. Want to see our rings meanwhile?";
    const { r } = await replay({
      id: "b16-keep-talking",
      ask: "do you do custom engraving on rings?",
      model: () => ({ text: `${words}\n{"needs_owner": true}` }),
    });
    expect(r.status).toBe("ok");
    expect(r.handedOff ?? false).toBe(false);
    expect(r.sent.map((s) => s.text)).toEqual([words]);
  });

  it("nothing to say at all: filed for the merchant, Aiden stays on (no needs_human, no hand-over line)", async () => {
    const { r, outcome } = await replay({
      id: "b16-nothing",
      ask: "silver rings under 2000",
      model: () => ({ text: '{"needs_owner": true}' }),
    });
    expect(outcome["sent"]).toBe(false);
    expect(r.handedOff ?? false).toBe(false);
    expect(r.gapFiled).toBe(true);
    expect(r.sent).toEqual([]);
  });

  it("the customer asks for a person: still handed over (needs_human, the workspace's hand-over line)", async () => {
    const { r } = await replay({
      id: "b16-person",
      ask: "can I talk to a person please",
      model: () => ({ text: 'Sure, happy to help!\n{"needs_owner": false}' }),
    });
    expect(r.status).toBe("escalated");
    expect(r.escalation).toBe("asked_for_person");
    expect(r.handedOff).toBe(true);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.text).toMatch(/^Let me get someone from the team/);
  });

  it("a flow's Assign step (needs_human on the chat) still silences Aiden", async () => {
    const { r, outcome } = await replay(
      { id: "b16-flow-assign", ask: "Rings", model: () => ({ text: "should never run" }) },
      { assigned_to: null, needs_human: true, last_customer_message_at: new Date().toISOString() },
    );
    expect(outcome).toEqual({ acted: false, reason: "awaiting_human" });
    expect(r.sent).toEqual([]);
  });

  it("asksForPerson: person asks in English and Hinglish, not product questions about people", async () => {
    const { asksForPerson, isHandOffSignal } = await import("./ai-run.server");
    for (const q of ["Can I speak to a human please?", "agent please", "talk to someone", "kisi se baat karni hai", "please call me back", "connect me to the owner", "mujhe call karo"])
      expect(asksForPerson(q), q).toBe(true);
    for (const q of ["Rings", "30k", "return policy", "show me products", "is this ring good for a person with small fingers?", "designs"])
      expect(asksForPerson(q), q).toBe(false);
    expect(isHandOffSignal("no_source")).toBe(false);
    expect(isHandOffSignal("unsupported_number")).toBe(false);
    expect(isHandOffSignal("question_repeated")).toBe(false);
    expect(isHandOffSignal("asked_for_person")).toBe(true);
    expect(isHandOffSignal("merchant_rule")).toBe(true);
  });

  it("agent_rules v4: the colleague line is gone, the keep-talking line is in (code and migration agree)", async () => {
    const { FALLBACK_AGENT_RULES } = await import("./ai-brief.server");
    expect(FALLBACK_AGENT_RULES).not.toMatch(/colleague will follow up/);
    expect(FALLBACK_AGENT_RULES.split("\n").at(-1)).toBe(
      "If you don't have a detail, say so plainly, offer the closest thing you can (similar products, or the shop's contact details from the material) and keep the conversation going.",
    );
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(new URL("../../supabase/aidwar-migrations/20261023_agent_rules_v4_keep_talking.sql", import.meta.url), "utf8");
    const v4 = /SET content = E'([\s\S]*?)',\n/.exec(sql)![1]!.replace(/''/g, "'").replace(/\\n/g, "\n");
    expect(v4).toBe(FALLBACK_AGENT_RULES);
    expect(sql).toMatch(/AND content = E'[\s\S]*say a colleague will follow up\.';/);
  });
});

describe("Batch 16 item 2: hand-off alerts go to staff, never the business's own number", () => {
  const ORG = "81c234b2-569f-40be-ad71-96c046de5d12";
  const OWN = "+91 98000 00098";

  async function world(opts: { phones?: string[]; email?: string | null; ownerPhone?: string; waiting?: boolean }) {
    const { fakeDb } = await import("./test-support/fake-db");
    return fakeDb((op) => {
      if (op.table === "organization_ai_settings")
        return { data: { handoff_alert_phones: opts.phones ?? [], handoff_alert_email: opts.email ?? null, handoff_alert_hours: null }, error: null };
      if (op.table === "whatsapp_accounts") return { data: [{ display_phone_number: OWN }], error: null };
      if (op.table === "organizations") return { data: { name: "Zoori", timezone: "Asia/Kolkata" }, error: null };
      if (op.table === "organization_members") return { data: [{ user_id: "u1" }], error: null };
      if (op.table === "profiles") return { data: { phone: opts.ownerPhone ?? "+919800000098" }, error: null };
      if (op.table === "conversations" && op.kind === "select" && opts.waiting)
        return { data: [{ id: "c1", organization_id: ORG, needs_human_reason: "asked_for_person", needs_human_question: "call me" }], error: null };
      if (op.table === "conversations" && op.kind === "select")
        return { data: { contacts: { name: "Asha", phone: "+919800000001" } }, error: null };
      return undefined;
    });
  }

  it("saving the business's own number is refused with a plain explanation", async () => {
    const { validateAlertSettings } = await import("./handoff-alerts.server");
    const own = ["+91 98000 00098"];
    for (const typed of ["+919800000098", "09800000098", "98000 00098"]) {
      const r = validateAlertSettings({ phones: [typed] }, own);
      expect(r.ok, typed).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/this business's own WhatsApp number/);
    }
    const ok = validateAlertSettings({ phones: ["+91 98765 43210", ""], email: "team@example.com" }, own);
    expect(ok).toEqual({ ok: true, settings: { phones: ["+919876543210"], email: "team@example.com" } });
    expect(validateAlertSettings({ phones: ["+919876543210", "+919876543211", "+919876543212"] }, own).ok).toBe(false);
    expect(validateAlertSettings({ phones: [], email: "not-an-email" }, own).ok).toBe(false);
  });

  it("no staff saved and the owner's phone is the business number: nothing is sent to it", async () => {
    const { sendHandoffAlert } = await import("./handoff-alerts.server");
    const db = await world({});
    const whatsapp: string[] = [];
    const out = await sendHandoffAlert(
      db.supabase,
      { organizationId: ORG, conversationId: "c1", reason: "asked_for_person" },
      { channelFor: async (p) => ({ to: p }), sendWhatsApp: async (c) => (whatsapp.push((c as unknown as { to: string }).to), true) },
    );
    expect(whatsapp).toEqual([]);
    expect(out.refused).toEqual(["+919800000098"]);
    expect(out.skipped).toBe("no_staff_contact");
  });

  it("a hand-off alerts the staff number from the platform number, not the shop's own", async () => {
    const { sendHandoffAlert } = await import("./handoff-alerts.server");
    const db = await world({ phones: ["+919876543210"] });
    const sent: Array<{ to: string; body: string }> = [];
    const out = await sendHandoffAlert(
      db.supabase,
      { organizationId: ORG, conversationId: "c1", reason: "asked_for_person", question: "can I talk to a person" },
      { channelFor: async (p) => ({ to: p }), sendWhatsApp: async (c, body) => (sent.push({ to: (c as unknown as { to: string }).to, body }), true) },
    );
    expect(out.whatsapp).toEqual(["+919876543210"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatch(/Zoori.*Asha is waiting for you/);
    expect(db.ops.some((o) => o.table === "conversations" && o.kind === "update" && "handoff_alert_at" in (o.payload as object))).toBe(true);
    // never needs_human cleared
    expect(db.ops.some((o) => o.kind === "update" && (o.payload as Record<string, unknown>)["needs_human"] === false)).toBe(false);
  });

  it("WhatsApp can't reach the staff member (no open chat): the email goes instead", async () => {
    const { sendHandoffAlert } = await import("./handoff-alerts.server");
    const db = await world({ phones: ["+919876543210"], email: "team@example.com" });
    const emails: string[] = [];
    const out = await sendHandoffAlert(
      db.supabase,
      { organizationId: ORG, conversationId: "c1", reason: "flow_assign" },
      { channelFor: async () => null, sendEmail: async (to) => (emails.push(to), true) },
    );
    expect(out.whatsapp).toEqual([]);
    expect(emails).toEqual(["team@example.com"]);
  });

  it("one reminder after 30 minutes, only inside business hours", async () => {
    const { remindWaitingHandoffs } = await import("./handoff-alerts.server");
    const deps = { channelFor: async (p: string) => ({ to: p }), sendWhatsApp: async () => true };
    // Wednesday 11:00 IST — open.
    const open = await world({ phones: ["+919876543210"], waiting: true });
    expect(await remindWaitingHandoffs(open.supabase, new Date("2026-10-07T05:30:00Z"), deps)).toBe(1);
    const reminded = open.ops.find((o) => o.table === "conversations" && o.kind === "update");
    expect(Object.keys(reminded!.payload as object)).toEqual(["handoff_reminded_at"]);
    expect(open.has(open.ops.find((o) => o.table === "conversations" && o.kind === "select")!, "is", "handoff_reminded_at", null)).toBe(true);
    // Sunday — closed: no reminder yet.
    const closed = await world({ phones: ["+919876543210"], waiting: true });
    expect(await remindWaitingHandoffs(closed.supabase, new Date("2026-10-11T05:30:00Z"), deps)).toBe(0);
  });
});

describe("Batch 16 item 3: one product search — hidden products never come back", () => {
  it("catalog_search, the store's search_products (now catalogSearch) and the flows pool all skip is_visible=false", async () => {
    const { PRODUCTS } = await import("./test-support/zoori-replay");
    const { memoryDb } = await import("./test-support/memory-db");
    const real = await vi.importActual<typeof import("./ai-tools.server")>("./ai-tools.server");
    const rings = PRODUCTS.filter((p) => /ring/i.test(String(p["category"] ?? "")));
    expect(rings.length).toBeGreaterThan(1);
    const hiddenIds = new Set(rings.slice(1).map((p) => p["id"]));
    const rows = PRODUCTS.map((p) => (hiddenIds.has(p["id"]) ? { ...p, is_visible: false } : p));
    const ctx = {
      supabase: memoryDb({ products: rows }).supabase,
      organizationId: "81c234b2-569f-40be-ad71-96c046de5d12",
      actorUserId: null,
      initiatedBy: "ai" as const,
    };
    const ids = (out: { data?: unknown }) => ((out.data as Array<Record<string, unknown>> | undefined) ?? []).map((r) => r["id"]);
    const calls = [
      real.AI_TOOL_HANDLERS["catalogSearch"]!(ctx, { category: "rings", limit: 25 }),
      real.AI_TOOL_HANDLERS["catalogSearch"]!({ ...ctx, brokered: true }, { query: String(rings[1]!["title"]), limit: 25 }),
      real.AI_TOOL_HANDLERS["catalogSearch"]!(ctx, { category: "rings", pool: true, limit: 100, order: "price_asc" }),
      real.AI_TOOL_HANDLERS["searchProducts"]!(ctx, { query: String(rings[1]!["title"]) }),
      real.AI_TOOL_HANDLERS["searchProducts"]!(ctx, { query: "ring", limit: 20 }),
    ];
    for (const out of await Promise.all(calls)) {
      for (const id of ids(out)) expect(hiddenIds.has(id)).toBe(false);
    }
  });

  it("no second product search is left: the only title/ilike product query in the AI tools is gone", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./ai-tools.server.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/\.from\("products"\)[\s\S]{0,200}\.ilike\("title"/);
    // every row-returning product read in the tools carries the visibility rule
    const reads = src.split('.from("products")').slice(1).map((s) => s.slice(0, 600));
    for (const r of reads) expect(r).toMatch(/is_visible/);
  });
});

describe("Batch 16 item 5: a card not ready in ~1 s never holds the product photo", () => {
  it("slow card: the plain photo goes with the same caption within ~1 s; the card finishes for next time", async () => {
    process.env["AIDWAR_SUPABASE_URL"] = "https://db.example";
    process.env["AIDWAR_SUPABASE_SERVICE_ROLE_KEY"] = "svc";
    const { fakeDb } = await import("./test-support/fake-db");
    const db = fakeDb((op) => (op.table === "conversations" ? { data: { id: "conv-1", last_customer_message_at: new Date().toISOString() }, error: null } : undefined));
    const started = Date.now();
    const sends: Array<{ link: string; caption: string; at: number }> = [];
    let renders = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "HEAD") return new Response(null, { status: 404 });
      if (u.includes("/functions/v1/render-card")) {
        renders += 1;
        await new Promise((r) => setTimeout(r, 1600));
        return new Response(JSON.stringify({ url: "https://db.example/cards/drawn.png" }), { status: 200 });
      }
      if (u.includes("graph.facebook.com")) {
        const body = JSON.parse(String(init?.body)) as { image: { link: string; caption: string } };
        sends.push({ link: body.image.link, caption: body.image.caption, at: Date.now() - started });
        return new Response(JSON.stringify({ messages: [{ id: `wamid.${sends.length}` }] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    const { sendProductPictures, CARD_WAIT_MS } = await import("./product-pictures.server");
    const background: Promise<unknown>[] = [];
    const item = { title: "The Architect", imageUrl: "https://shop.example/architect.jpg", caption: "The Architect — ₹26,446", price: 26446, currency: "INR", productUrl: null };
    const args = {
      organizationId: "org-card",
      contactId: "c1",
      conversationId: "conv-1",
      to: "919800000001",
      phoneNumberId: "pn",
      accessToken: "tok",
      windowOpen: true,
      cards: true,
      items: [item],
      background: (w: Promise<unknown>) => background.push(w),
    } as unknown as Parameters<typeof sendProductPictures>[1];
    expect(CARD_WAIT_MS).toBe(1000);
    expect(await sendProductPictures(db.supabase, args)).toBe(1);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.link).toBe(item.imageUrl);
    expect(sends[0]!.caption).toBe(item.caption);
    expect(sends[0]!.at).toBeLessThan(1500);
    expect(background).toHaveLength(1);
    // The card finishes drawing in the background…
    await Promise.all(background);
    // …and the next customer gets the card itself, at once, without a new render.
    expect(await sendProductPictures(db.supabase, args)).toBe(1);
    expect(sends[1]!.link).toBe("https://db.example/cards/drawn.png");
    expect(sends[1]!.caption).toBe(item.caption);
    expect(renders).toBe(1);
  }, 10_000);
});
