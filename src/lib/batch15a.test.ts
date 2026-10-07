import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";
import { memoryDb, type Row } from "./test-support/memory-db";
import { inboundPayload, latencyWorld } from "./test-support/latency-world";
import { CASES, ORG, PRODUCTS, zooriWorld, type Case } from "./test-support/zoori-replay";

/**
 * Batch 15A — speed and safety.
 *  (1a) the burst wait is a platform setting, 1 s by default (was a fixed 5 s);
 *  (1b) Aiden's stages land on webhook_events.timing; a run's tool calls reuse
 *       the tools brokered at its start; the first branded card is drawn while
 *       the model writes its closing words;
 *  (1c) the first product goes at once, the rest together;
 *  (1d) read receipt + typing dots as soon as a live reply is coming;
 *  (2)  clock times, days and durations need a source, like numbers;
 *  (3)  platform rules v3 (prompt only);
 *  (4)  the reader takes a gender only when the page says it, never over one set;
 *  (5)  a product read on www.… updates its no-www row (or same SKU) instead of
 *       a refused insert.
 * The live-calibrated before/after timings are in batch15a-bench.test.ts.
 */

vi.mock("@/lib/feature-flags.server", () => ({
  enabledFlags: async () => new Set(["ai_features", "catalogs", "flows_v2"]),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ------------------------------------------------------------------ (1a)
describe("(1a) the burst wait: a platform setting, 1 s by default", () => {
  const settingsDb = (reply: { data: unknown; error: { message: string } | null }) =>
    fakeDb((op) => (op.table === "platform_settings" ? reply : undefined));

  it("no column yet (migration not applied), no row or a failed read: 1 s", async () => {
    const { burstWindowMs, resetBurstWindowCache } = await import("./whatsapp-webhook.server");
    for (const reply of [
      {
        data: null,
        error: { message: "column platform_settings.ai_burst_wait_ms does not exist" },
      },
      { data: null, error: null },
      { data: { ai_burst_wait_ms: "fast" }, error: null },
      { data: { ai_burst_wait_ms: 999_999 }, error: null },
    ]) {
      resetBurstWindowCache();
      expect(await burstWindowMs(settingsDb(reply).supabase)).toBe(1000);
    }
  });

  it("the saved value is used, read at most once a minute", async () => {
    const { burstWindowMs, resetBurstWindowCache } = await import("./whatsapp-webhook.server");
    resetBurstWindowCache();
    const db = settingsDb({ data: { ai_burst_wait_ms: 2500 }, error: null });
    expect(await burstWindowMs(db.supabase, 1_000_000)).toBe(2500);
    expect(await burstWindowMs(db.supabase, 1_030_000)).toBe(2500);
    expect(db.ops.filter((o) => o.table === "platform_settings")).toHaveLength(1);
    await burstWindowMs(db.supabase, 1_061_000);
    expect(db.ops.filter((o) => o.table === "platform_settings")).toHaveLength(2);
    resetBurstWindowCache();
  });

  it("coalesceBurst waits 1 s by default (was 5 s)", async () => {
    vi.useFakeTimers();
    const { coalesceBurst } = await import("./whatsapp-webhook.server");
    const db = fakeDb((op) => (op.table === "messages" ? { data: [], error: null } : undefined));
    const out = coalesceBurst(db.supabase, {
      conversationId: "cv",
      messageId: "m1",
      occurredAt: new Date().toISOString(),
      body: "rings?",
    });
    await vi.advanceTimersByTimeAsync(990);
    expect(db.ops).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(20);
    await out;
    expect(db.ops).toHaveLength(1);
  });

  it("the migration adds the column (default 1000, 0–10000) and nothing else", () => {
    const sql = readFileSync("supabase/aidwar-migrations/20261020_ai_burst_wait.sql", "utf8");
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS ai_burst_wait_ms integer NOT NULL DEFAULT 1000/);
    expect(sql).toMatch(/BETWEEN 0 AND 10000/);
    expect(sql.replace(/--.*$/gm, "")).not.toMatch(/\bUPDATE\b|\bDELETE\b|\bDROP\b/i);
  });
});

// ------------------------------------------------------- Aiden end to end
async function reply(c: Case, opts: { graphMs?: number; flags?: string[] } = {}) {
  const world = zooriWorld(c);
  const starts: Array<{ at: number; type: string }> = [];
  const t0 = Date.now();
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url).includes("graph.facebook.com")) {
      starts.push({
        at: Date.now() - t0,
        type: String((JSON.parse(String(init?.body ?? "{}")) as { type?: string }).type),
      });
      if (opts.graphMs) await new Promise((r) => setTimeout(r, opts.graphMs));
    }
    return world.fetchStub(String(url), init);
  });
  const marks: string[] = [];
  const timer = { mark: (s: string) => marks.push(s), span: () => {} };
  let typing = 0;
  const { runAgentOnInbound } = await import("./ai-agent.server");
  const outcome = await runAgentOnInbound(world.supabase, {
    ...(world.args as Parameters<typeof runAgentOnInbound>[1]),
    timer,
    onWillReply: () => (typing += 1),
  });
  return { outcome, marks, typing, starts, ...world.result() };
}
const showMe = CASES.find((c) => c.id === "show-me-products")!;

describe("(1b) where the time goes: Aiden's stages on the webhook timing", () => {
  it("gates, run, first send, first photo — in that order — then ai_done (the webhook's)", async () => {
    process.env["LOVABLE_API_KEY"] = "test-key";
    const r = await reply(showMe);
    // First occurrence of each, as the webhook's timer keeps them.
    const firsts = r.marks.filter((m, i) => m.startsWith("ai_") && r.marks.indexOf(m) === i);
    expect(firsts).toEqual(["ai_gates", "ai_run", "ai_first_send", "ai_first_photo"]);
  });

  it("the timing record measures Aiden's first send like a flow's", async () => {
    const { replyTimer } = await import("./reply-timing");
    let now = 0;
    const { timer, result } = replyTimer(300, () => now);
    now = 1200;
    timer.mark("burst");
    now = 9000;
    timer.mark("ai_run");
    now = 9400;
    timer.mark("ai_first_send");
    now = 9900;
    timer.mark("ai_first_photo");
    now = 10500;
    timer.mark("ai_done");
    const out = result("wamid.x", "ai");
    expect(out.received_to_send_ms).toBe(9700);
    expect(out.ms).toMatchObject({
      burst: 1200,
      ai_run: 7800,
      ai_first_send: 400,
      ai_first_photo: 500,
      ai_done: 600,
    });
  });

  it("a run's tool calls reuse the tools brokered at its start (no permission reads per call)", async () => {
    const { invokeTool, AI_TOOL_HANDLERS: _h } = await import("./ai-tools.server");
    const { allAiTools } = await import("./feature-registry");
    const brokered = allAiTools()
      .filter((t) => t.name === "catalog_search")
      .map(({ flag_key: _flag, ...tool }) => tool);
    const mem = memoryDb({ products: PRODUCTS });
    const fake = fakeDb(() => undefined);
    const supabase = {
      from: (t: string) => (t === "products" ? mem.supabase.from(t) : fake.supabase.from(t)),
      rpc: fake.supabase.rpc,
    } as never;
    const ctx = {
      supabase,
      organizationId: ORG,
      actorUserId: null,
      principal: { kind: "agent" as const },
      initiatedBy: "ai" as const,
    };
    const out = await invokeTool(ctx, "catalog_search", { category: "rings" }, { brokered });
    expect(out.ok).toBe(true);
    const tables = fake.ops.map((o) => o.table);
    expect(tables).not.toContain("role_permissions");
    expect(tables).not.toContain("organization_ai_settings");
    // Not offered → refused, exactly as the broker would.
    expect((await invokeTool(ctx, "lookup_order", {}, { brokered })).ok).toBe(false);
  });
});

describe("(1b) the first branded card is drawn while the model writes its closing words", () => {
  it("drawn once, before the run returns; the send reuses it", async () => {
    vi.doMock("@/lib/feature-flags.server", () => ({
      enabledFlags: async () => new Set(["ai_features", "catalogs", "cards"]),
    }));
    vi.resetModules();
    process.env["LOVABLE_API_KEY"] = "test-key";
    process.env["AIDWAR_SUPABASE_URL"] = "https://cards.supabase.co";
    process.env["AIDWAR_SUPABASE_SERVICE_ROLE_KEY"] = "k";
    const world = zooriWorld(showMe);
    const events: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/storage/v1/object/public/")) return new Response(null, { status: 404 });
      if (u.includes("/functions/v1/render-card")) {
        events.push("render");
        return new Response(
          JSON.stringify({ url: "https://cards.supabase.co/card-1.png", cached: true }),
        );
      }
      if (u.includes("/chat/completions")) {
        const body = String(init?.body ?? "");
        if (body.includes('"role":"tool"') && body.includes("send_products"))
          events.push("closing_turn");
      }
      if (u.includes("graph.facebook.com"))
        events.push(
          `send:${String((JSON.parse(String(init?.body ?? "{}")) as { type?: string }).type)}`,
        );
      return world.fetchStub(u, init);
    });
    const { runAgentOnInbound } = await import("./ai-agent.server");
    await runAgentOnInbound(world.supabase, world.args as Parameters<typeof runAgentOnInbound>[1]);
    // Drawn once — by the head start, not by the send (which reuses it).
    expect(events.filter((e) => e === "render")).toHaveLength(1);
    expect(events.indexOf("render")).toBeLessThan(events.indexOf("send:image"));
    expect(world.result().sent.filter((s) => s.type === "image")[0]!.link).toBe(
      "https://cards.supabase.co/card-1.png",
    );
    // Back to this file's flags for the tests after it.
    vi.doMock("@/lib/feature-flags.server", () => ({
      enabledFlags: async () => new Set(["ai_features", "catalogs", "flows_v2"]),
    }));
    vi.resetModules();
  });
});

describe("(1c) the first product goes at once, the rest together", () => {
  it("picture 2 and 3 start together once picture 1 is accepted; the closing words wait for all", async () => {
    process.env["LOVABLE_API_KEY"] = "test-key";
    const r = await reply(showMe, { graphMs: 60 });
    const types = r.starts.map((s) => s.type);
    expect(types).toEqual(["text", "image", "image", "image", "text"]);
    const [, p1, p2, p3, closing] = r.starts;
    expect(p2!.at - p1!.at).toBeGreaterThanOrEqual(55);
    expect(Math.abs(p3!.at - p2!.at)).toBeLessThan(30);
    expect(closing!.at - p3!.at).toBeGreaterThanOrEqual(55);
    expect(r.sent.filter((s) => s.type === "image").map((s) => s.text.split(" — ")[0])).toEqual([
      "The Gilded Chevron",
      "Industrial Sparkle/ The Urban Edge",
      "The Allure Orbit/The Willow Vine",
    ]);
  });
});

// ------------------------------------------------------------------ (1d)
describe("(1d) read receipt + typing dots as soon as a live reply is coming", () => {
  it("once, after the gates pass", async () => {
    process.env["LOVABLE_API_KEY"] = "test-key";
    const r = await reply(CASES.find((c) => c.id === "who-are-you")!);
    expect(r.typing).toBe(1);
  });

  it("not when a person owns the thread (no reply is coming)", async () => {
    const world = zooriWorld(CASES[0]!);
    const gate = Promise.resolve({
      assigned_to: "user-1",
      needs_human: false,
      last_customer_message_at: new Date().toISOString(),
    });
    let typing = 0;
    const { runAgentOnInbound } = await import("./ai-agent.server");
    const out = await runAgentOnInbound(world.supabase, {
      ...(world.args as Parameters<typeof runAgentOnInbound>[1]),
      gate,
      onWillReply: () => (typing += 1),
    });
    expect(out).toMatchObject({ acted: false, reason: "assigned_to_human" });
    expect(typing).toBe(0);
  });

  it("the call: mark read + typing indicator for that message (Cloud API)", async () => {
    const { showTyping } = await import("./whatsapp-webhook.server");
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response("{}");
    });
    showTyping(Promise.resolve({ accessToken: "tok" }), "pn", "wamid.in");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([
      {
        url: "https://graph.facebook.com/v25.0/pn/messages",
        body: {
          messaging_product: "whatsapp",
          status: "read",
          message_id: "wamid.in",
          typing_indicator: { type: "text" },
        },
      },
    ]);
  });

  it("the webhook shows the dots on a customer's number once Aiden is going to answer", async () => {
    const w = latencyWorld({
      org: "org-typing",
      rttMs: 0,
      graphMs: 0,
      waitingRun: false,
      override: (op: FakeOp) => {
        if (op.table === "ai_agents")
          return { data: { id: "agent-1", mode: "replying" }, error: null };
        if (op.table === "feature_flags")
          return { data: [{ key: "ai_features", default_enabled: true }], error: null };
        if (op.table === "organization_ai_settings")
          return { data: { ai_enabled: true }, error: null };
        if (op.table === "conversations" && op.kind === "select")
          return {
            data: {
              id: "cv1",
              contact_id: "c1",
              unread_count: 0,
              assigned_to: null,
              needs_human: false,
              last_customer_message_at: new Date().toISOString(),
              whatsapp_account_id: "acc-org-typing",
              contacts: { phone: "+919800000001" },
            },
            error: null,
          };
        return undefined;
      },
    });
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url).includes("graph.facebook.com"))
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return w.fetchStub(url, init);
    });
    const { processWebhookPayload } = await import("./whatsapp-webhook.server");
    await processWebhookPayload(
      w.supabase,
      "ev-typing",
      inboundPayload({ id: "wamid.hi", type: "text", text: { body: "who are you?" } }),
    );
    expect(bodies.find((b) => b["typing_indicator"])).toMatchObject({
      status: "read",
      message_id: "wamid.hi",
    });
  }, 20_000);
});

// ------------------------------------------------------------------- (2)
describe("(2) clock times, days and durations need a source, like numbers", () => {
  const SOURCES = [
    "Showroom open Monday to Saturday, 10:30 AM – 8:00 PM. 20-Day Free Returns. Delivery in 5-7 working days.",
    "Never promise same-day delivery.",
  ];
  it("what the material states passes, in any spelling", async () => {
    const { unsupportedTimeFacts } = await import("./ai-run.server");
    for (const a of [
      "We're open 10:30 am to 8 pm, Monday to Saturday.",
      "Open Mon–Sat, 10:30 AM–8:00 PM.",
      "Delivery takes 5–7 days.",
      "20-day returns, no questions asked.",
    ])
      expect(unsupportedTimeFacts(a, SOURCES), a).toEqual([]);
  });
  it("what it doesn't is found — a negated source line supports nothing", async () => {
    const { unsupportedTimeFacts } = await import("./ai-run.server");
    expect(unsupportedTimeFacts("Open Sunday 11am-6pm too.", SOURCES)).toEqual([
      "11am",
      "6pm",
      "Sunday",
    ]);
    expect(unsupportedTimeFacts("We deliver same day!", SOURCES)).toEqual(["same day"]);
    expect(unsupportedTimeFacts("Delivery takes 2-3 days, open 24 hours.", SOURCES)).toEqual([
      "2-3 days",
      "24 hours",
    ]);
    expect(unsupportedTimeFacts("10:00 to 20:00, shanivar bhi.", SOURCES)).toEqual(["10:00"]);
  });
  it("no false alarms on ordinary words", async () => {
    const { unsupportedTimeFacts } = await import("./ai-run.server");
    expect(
      unsupportedTimeFacts(
        "Ring size (12). Daily wear, a sun-kissed glow — sat on a 3.05 g band.",
        SOURCES,
      ),
    ).toEqual([]);
  });

  it("an invented timing is removed from the reply (Batch 5 confirm rule unchanged) and filed for the owner", async () => {
    process.env["LOVABLE_API_KEY"] = "test-key";
    const r = await reply({
      id: "timing",
      ask: "showroom timing?",
      model: () => ({
        text: 'Our Somajiguda showroom is open 11 am to 9 pm, all days of the week.\nWhich showroom suits you?\n{"needs_owner": false}',
      }),
    });
    const all = r.sent.map((s) => s.text).join("\n");
    expect(all).not.toMatch(/11 am|9 pm|all days/);
    expect(all).toMatch(/Which showroom suits you\?/);
    expect(r.gapFiled).toBe(true);
  });

  it("captions too: a delivery promise in a caption goes, the rest of the caption stays", async () => {
    process.env["LOVABLE_API_KEY"] = "test-key";
    const chevron = PRODUCTS.find((p) => p["title"] === "The Gilded Chevron")!;
    const r = await reply({
      id: "caption-time",
      ask: "rings",
      model: (ctx) =>
        ctx.step === 0
          ? {
              calls: [
                {
                  name: "send_products",
                  args: {
                    products: [
                      {
                        product_id: chevron["id"],
                        caption: "The Gilded Chevron — ₹19,604. Delivered in 2 days.",
                      },
                    ],
                  },
                },
              ],
            }
          : { text: "Like it?" },
    });
    expect(r.sent.find((s) => s.type === "image")!.text).toBe("The Gilded Chevron — ₹19,604.");
  });
});

// ------------------------------------------------------------------- (3)
describe("(3) platform rules v3: the line is in the prompt, nowhere in code", () => {
  const LINE =
    "If something isn't in the material you were given, never say the business doesn't have it — say you'll check, or ask what they're looking for.";
  it("built-in rules carry it; the migration moves only an untouched v2", async () => {
    const { FALLBACK_AGENT_RULES } = await import("./ai-brief.server");
    expect(FALLBACK_AGENT_RULES).toContain(LINE);
    const sql = readFileSync(
      "supabase/aidwar-migrations/20261021_agent_rules_v3_never_say_none.sql",
      "utf8",
    );
    expect(sql).toContain(LINE.replace(/'/g, "''"));
    expect(sql).toMatch(/AND content = E'This business''s own instructions come first/);
    expect(sql.replace(/--.*$/gm, "")).not.toMatch(/\bDELETE\b|\bDROP\b|\bINSERT\b/i);
  });
});

// ------------------------------------------------------------------- (4)
describe("(4) the reader takes a gender only when the page says it", () => {
  it("plain words in the shelf, title, description or code; both or neither → none", async () => {
    const { genderHint } = await import("./product-extract.server");
    expect(genderHint("Gents Signet Ring")).toBe("male");
    expect(genderHint(null, null, "Signet", "A bold ring for him in 18K gold.")).toBe("male");
    expect(genderHint("Men's Kada")).toBe("male");
    expect(genderHint(null, "MENS-RING-01")).toBe("male");
    expect(genderHint("Ladies Bracelet")).toBe("female");
    expect(genderHint("Women’s studs")).toBe("female");
    expect(genderHint(null, null, "Halo", "Perfect for her anniversary")).toBe("female");
    expect(genderHint("Couple bands for him and for her")).toBeNull();
    expect(genderHint("The Gilded Chevron", "ZLRG-0001", "Metal: Gold, Diamond")).toBeNull();
    expect(genderHint("Womens and mens collection")).toBeNull();
  });

  const page = (
    title: string,
    description: string,
  ) => `<!doctype html><html><head><title>${title}</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"${title}","description":"${description}","image":["https://shop.example/p.jpg"],"sku":"SKU-1","offers":{"@type":"Offer","price":"25000","priceCurrency":"INR"}}</script>
</head><body><h1>${title}</h1><p>${"Handcrafted in 18K gold. ".repeat(6)}</p></body></html>`;

  it("a read sets it from the page", async () => {
    const { extractProduct } = await import("./product-extract.server");
    expect(
      extractProduct(page("Gents Onyx Ring", "Bold."), "https://shop.example/p/1")?.gender,
    ).toBe("male");
    expect(
      extractProduct(page("Orbit Ring", "Made for her."), "https://shop.example/p/2")?.gender,
    ).toBe("female");
    expect(
      extractProduct(page("Orbit Ring", "18K gold."), "https://shop.example/p/3")?.gender,
    ).toBeNull();
  });

  it("a gender already set is never changed by a read", async () => {
    const { saveCrawledProducts } = await import("./product-extract.server");
    const db = memoryDb({
      products: [
        {
          id: "p1",
          organization_id: ORG,
          external_id: "https://z/p/1",
          source: "crawl",
          gender: "female",
        },
      ],
    });
    const draft = {
      externalId: "https://z/p/1",
      title: "Gents Ring",
      price: 1,
      currency: "INR",
      imageUrl: null,
      productUrl: "https://z/p/1",
      category: "rings",
      gender: "male",
      availability: "in_stock" as const,
      sku: null,
      brand: null,
    };
    await saveCrawledProducts(db.supabase, ORG, [draft]);
    expect(db.rows("products")[0]!["gender"]).toBe("female");
    const fresh = memoryDb({
      products: [
        {
          id: "p2",
          organization_id: ORG,
          external_id: "https://z/p/2",
          source: "crawl",
          gender: null,
        },
      ],
    });
    await saveCrawledProducts(fresh.supabase, ORG, [{ ...draft, externalId: "https://z/p/2" }]);
    expect(fresh.rows("products")[0]!["gender"]).toBe("male");
  });
});

// ------------------------------------------------------------------- (5)
describe("(5) a product read on www.… updates its old no-www row (same SKU) instead of a refused insert", () => {
  const draft = {
    externalId: "https://www.myzoori.com/product-detail/a17c9b39-247c-451a-8063-09d9da502d9a",
    title: "The Gilded Chevron",
    price: 19800,
    currency: "INR",
    imageUrl: "https://www.myzoori.com/storage/images/products/a17c9b39/zlrg-0001.jpg",
    productUrl: "https://www.myzoori.com/product-detail/a17c9b39-247c-451a-8063-09d9da502d9a",
    category: "rings",
    gender: null,
    availability: "in_stock" as const,
    sku: "ZLRG-0001",
    brand: null,
  };
  const old: Row = {
    id: "8431b39b",
    organization_id: ORG,
    source: "crawl",
    external_id: "https://myzoori.com/product-detail/a17c9b39-247c-451a-8063-09d9da502d9a",
    product_url: "https://myzoori.com/product-detail/a17c9b39-247c-451a-8063-09d9da502d9a",
    sku: "ZLRG-0001",
    price: 19603.91,
    gender: "female",
    image_url: null,
  };

  it("the live case: same SKU on the no-www row → updated in place and moved to the www address; gender kept", async () => {
    const { saveCrawledProducts } = await import("./product-extract.server");
    const db = memoryDb({ products: [{ ...old }] });
    expect(await saveCrawledProducts(db.supabase, ORG, [draft])).toBe(1);
    const rows = db.rows("products");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "8431b39b",
      external_id: draft.externalId,
      product_url: draft.productUrl,
      price: 19800,
      gender: "female",
    });
  });

  it("Batch 21 (was Batch 13A's own row): no SKU → the same page's no-www row is updated and moved, never a second row", async () => {
    const { saveCrawledProducts } = await import("./product-extract.server");
    const db = memoryDb({ products: [{ ...old, sku: null }] });
    await saveCrawledProducts(db.supabase, ORG, [{ ...draft, sku: null }]);
    expect(db.rows("products")).toHaveLength(1);
    expect(db.rows("products")[0]).toMatchObject({ external_id: draft.externalId, product_url: draft.productUrl });
  });

  it("same SKU at another address: that row is the product", async () => {
    const { saveCrawledProducts } = await import("./product-extract.server");
    const db = memoryDb({ products: [{ ...old, external_id: "https://myzoori.com/p/old-slug" }] });
    await saveCrawledProducts(db.supabase, ORG, [draft]);
    expect(db.rows("products")).toHaveLength(1);
    expect(db.rows("products")[0]).toMatchObject({
      id: "8431b39b",
      external_id: draft.externalId,
      price: 19800,
    });
  });

  it("unchanged: a shop platform's product with that SKU is never overwritten by a page read", async () => {
    const { saveCrawledProducts } = await import("./product-extract.server");
    const db = memoryDb({
      products: [{ ...old, source: "shopify", external_id: "gid://shopify/Product/1" }],
    });
    expect(await saveCrawledProducts(db.supabase, ORG, [draft])).toBe(0);
    expect(db.rows("products")[0]).toMatchObject({ source: "shopify", price: 19603.91 });
  });

  it("a refused insert is logged, never silent", async () => {
    const { saveCrawledProducts } = await import("./product-extract.server");
    const errors: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a));
    const db = fakeDb((op) =>
      op.table === "products" && op.kind === "insert"
        ? { data: null, error: { code: "23505", message: "duplicate key" } }
        : op.table === "products"
          ? { data: null, error: null }
          : undefined,
    );
    expect(await saveCrawledProducts(db.supabase, ORG, [{ ...draft, sku: null }])).toBe(0);
    expect(errors.some((e) => String(e[0]).includes("product insert failed"))).toBe(true);
    vi.restoreAllMocks();
  });
});
