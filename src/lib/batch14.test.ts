import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  checkCaption,
  descriptionFacts,
  isSkuLike,
  productFacts,
  readableName,
  rupees,
} from "./product-facts";
import { stripReferenceLeaks, stripReferences } from "./ai-run.server";
import { memoryDb } from "./test-support/memory-db";
import {
  CONV,
  ORG,
  PRODUCTS,
  zooriWorld,
  type Case,
  type ModelCtx,
} from "./test-support/zoori-replay";

/**
 * Batch 14 — Aiden follows the merchant's instructions; code may block an
 * unsafe fact but never writes, appends or reorders reply text.
 * The 23-conversation regression set lives in batch14-replay.test.ts; these
 * are the parts on their own.
 */

vi.mock("@/lib/feature-flags.server", () => ({
  enabledFlags: async () => new Set(["ai_features", "catalog"]),
}));
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
      const tool = offered().find((t) => t.name === name)!;
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

const chevron = PRODUCTS.find((p) => p["title"] === "The Gilded Chevron")!;
const architect = PRODUCTS.find((p) => p["title"] === "The Architect")!;
const earrings = PRODUCTS.find((p) => p["sku"] === "ZERN-0188")!;
const milgrain = PRODUCTS.find((p) => p["sku"] === "ZLRG-0002")!;

// ------------------------------------------------------------ product facts
describe("product facts given to the model", () => {
  it("whole rupees, Indian grouping", () => {
    expect(rupees(19603.91)).toBe("₹19,604");
    expect(rupees("1250000")).toBe("₹12,50,000");
    expect(rupees(0)).toBeNull();
    expect(rupees(null)).toBeNull();
  });

  it("a SKU-like title also gets a readable name from the description", () => {
    expect(isSkuLike("ZERN-0188")).toBe(true);
    expect(isSkuLike("ZLRG - 0001")).toBe(true);
    expect(isSkuLike("The Gilded Chevron", "ZLRG-0001")).toBe(false);
    expect(readableName(earrings)).toBe("Diamond & Pink Sapphire Gold Earrings");
    // Only the description's own phrase when it has no materials line.
    expect(
      readableName({
        category: "earrings",
        description: "Discover the Zoori Ruby & Diamond Gold Earrings, crafted…",
      }),
    ).toBe("Zoori Ruby & Diamond Gold Earrings");
    expect(readableName({ category: "rings", description: "" })).toBeNull();
  });

  it("metal, stones, purity and weight come out of the description", () => {
    expect(descriptionFacts(milgrain["description"])).toEqual({
      metal: "Gold",
      stones: ["Diamond"],
      purity: "18K",
      weight: "0.85 g",
    });
    expect(descriptionFacts(earrings["description"]).stones).toEqual(["Diamond", "Pink Sapphire"]);
  });

  it("the model sees every field it may use, the price in whole rupees, never a picture address", () => {
    expect(productFacts(chevron)).toEqual({
      product_id: chevron["id"],
      title: "The Gilded Chevron",
      sku: "ZLRG-0001",
      category: "rings",
      gender: "female",
      price: "₹19,604",
      availability: "in_stock",
      link: chevron["product_url"],
      has_photo: true,
    });
    const e = productFacts(earrings);
    expect(e).toMatchObject({
      title: "ZERN-0188",
      name: "Diamond & Pink Sapphire Gold Earrings",
      metal: "Gold",
      weight: "2.80 g",
      price: "₹48,640",
      has_photo: false,
    });
    expect(JSON.stringify(e)).not.toMatch(/image_url|storage\/images/);
  });
});

// --------------------------------------------------------------- captions
describe("captions: only the price and link are the server's business", () => {
  it("the product's own price in paise is written in whole rupees", () => {
    expect(checkCaption("The Gilded Chevron — ₹19,603.91", chevron)).toEqual({
      caption: "The Gilded Chevron — ₹19,604",
      changes: ["price_rounded"],
    });
    expect(checkCaption("Gilded Chevron for Rs. 19604 only!", chevron).caption).toBe(
      "Gilded Chevron for ₹19,604 only!",
    );
  });
  it("a different price becomes the real one; a second one goes", () => {
    expect(checkCaption("The Architect — ₹26,000", architect)).toEqual({
      caption: "The Architect — ₹26,446",
      changes: ["price_replaced"],
    });
    expect(checkCaption("The Architect ₹26,446 (was ₹30,000)", architect).caption).toBe(
      "The Architect ₹26,446 (was)",
    );
    expect(
      checkCaption("The Architect ₹26,446 (was ₹30,000)", { ...architect, compare_at_price: 30000 })
        .caption,
    ).toBe("The Architect ₹26,446 (was ₹30,000)");
  });
  it("a product without a price: any price goes, none is invented", () => {
    expect(checkCaption("Petal Band — ₹12,500", { price: null, product_url: null }).caption).toBe(
      "Petal Band",
    );
  });
  it("a link must be the product's page: www/https variants are the same page, anything else becomes it or goes", () => {
    expect(
      checkCaption(
        `Chevron\nhttps://www.myzoori.com/product-detail/a17c9b39-247c-451a-8063-09d9da502d9a/`,
        chevron,
      ).caption,
    ).toBe(`Chevron\n${String(chevron["product_url"])}`);
    expect(
      checkCaption("Architect https://myzoori.com/products/the-architect", architect).caption,
    ).toBe(`Architect ${String(architect["product_url"])}`);
    expect(
      checkCaption(`See ${String(architect["product_url"])} or https://evil.example/x`, architect)
        .caption,
    ).toBe(`See ${String(architect["product_url"])} or`);
    expect(
      checkCaption("Petal https://myzoori.com/p", { price: null, product_url: "" }).caption,
    ).toBe("Petal");
  });
  it("digits inside the link are never read as a price", () => {
    const c = `The Gilded Chevron — ₹19,604\n${String(chevron["product_url"])}`;
    expect(checkCaption(c, chevron)).toEqual({ caption: c, changes: [] });
  });
  it("a caption over 1,024 characters is cut at a sentence, never mid-word; nothing is added", () => {
    const long = `${"A lovely ring for every day. ".repeat(40)}End`;
    const out = checkCaption(long, chevron);
    expect(out.caption.length).toBeLessThanOrEqual(1024);
    expect(out.caption.endsWith("every day.")).toBe(true);
    expect(out.changes).toContain("caption_shortened");
  });
});

// ------------------------------------------------------------- references
describe("reference cleanup: removes only, never adds", () => {
  it("the live 'Item 6.' and its cousins", () => {
    expect(stripReferenceLeaks("It offers rings in BIS-hallmarked gold. Item 6.")).toBe(
      "It offers rings in BIS-hallmarked gold.",
    );
    expect(stripReferenceLeaks("Hallmarked gold (Item 2), certified stones [Items 3, 4].")).toBe(
      "Hallmarked gold, certified stones.",
    );
    expect(
      stripReferenceLeaks("No showroom markup (Source: About Zoori).\nWant to see rings?"),
    ).toBe("No showroom markup.\nWant to see rings?");
    expect(stripReferenceLeaks("Lifelong maintenance.\nSource: About Zoori, item 6")).toBe(
      "Lifelong maintenance.",
    );
    expect(stripReferences("20-day returns [2]. Free maintenance (1).", 6)).toBe(
      "20-day returns. Free maintenance.",
    );
  });
  it("a bare document id goes; the same id inside a link stays", () => {
    expect(stripReferenceLeaks("See doc 4c1f6b2e-1111-2222-3333-444455556666 for that.")).toBe(
      "See doc for that.",
    );
    const link =
      "Order here: https://myzoori.com/product-detail/a17c9b39-247c-451a-8063-09d9da502d9a";
    expect(stripReferenceLeaks(link)).toBe(link);
  });
  it("unchanged: list options, ring sizes and ordinary numbers stay exactly as written", () => {
    for (const text of [
      "(1) Order online — size at checkout.\n(2) Our team confirms here.",
      "Your ring size (12).",
      "Order item 2 shipped yesterday? Let me check.",
      "Prices start at ₹16,805.",
    ]) {
      expect(stripReferences(text, 6)).toBe(text);
    }
  });
});

// ---------------------------------------------------- send_products handler
describe("send_products: checks, never sends", () => {
  const ctx = (rows = PRODUCTS) => ({
    supabase: memoryDb({ products: rows }).supabase,
    organizationId: ORG,
    actorUserId: null,
    initiatedBy: "ai" as const,
  });
  const handler = async () => (await import("./ai-tools.server")).AI_TOOL_HANDLERS["sendProducts"]!;

  it("queues the products in the model's order with its captions (price/link checked)", async () => {
    const out = await (
      await handler()
    )(ctx(), {
      products: [
        { product_id: architect["id"], caption: "The Architect — ₹26,000" },
        { product_id: chevron["id"], caption: "Chevron, my favourite 💛" },
        { product_id: architect["id"], caption: "again" },
      ],
    });
    expect(out.ok).toBe(true);
    const products = (out.data as { products: Array<Record<string, unknown>> }).products;
    expect(products.map((p) => [p["title"], p["caption"]])).toEqual([
      ["The Architect", "The Architect — ₹26,446"],
      ["The Gilded Chevron", "Chevron, my favourite 💛"],
    ]);
    expect(products[0]!["caption_changes"]).toEqual(["price_replaced"]);
    expect(products[1]!["send"]).toMatchObject({
      imageUrl: chevron["image_url"],
      productUrl: chevron["product_url"],
    });
  });

  it("a hidden product or another workspace's id is never sent; none left is an error the model can fix", async () => {
    const rows = PRODUCTS.map((p) =>
      p["id"] === architect["id"] ? { ...p, is_visible: false } : p,
    );
    const partly = await (
      await handler()
    )(ctx(rows), {
      products: [
        { product_id: architect["id"], caption: "x" },
        { product_id: chevron["id"], caption: "y" },
        { product_id: "not-ours", caption: "z" },
      ],
    });
    expect((partly.data as { products: unknown[]; skipped: string[] }).skipped).toEqual([
      architect["id"],
      "not-ours",
    ]);
    const none = await (
      await handler()
    )(ctx(rows), { products: [{ product_id: "not-ours", caption: "z" }] });
    expect(none).toMatchObject({ ok: false });
  });
});

// ----------------------------------------------------- the reply, in order
beforeAll(() => {
  process.env["LOVABLE_API_KEY"] = "test-key";
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function reply(
  model: (ctx: ModelCtx) => {
    text?: string;
    calls?: Array<{ name: string; args: Record<string, unknown> }>;
  },
  extra: Partial<Case> = {},
) {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-06T10:20:00Z") });
  const world = zooriWorld({ id: "unit", ask: extra.ask ?? "show me rings", model, ...extra });
  vi.stubGlobal("fetch", world.fetchStub);
  const { runAgentOnInbound } = await import("./ai-agent.server");
  const outcome = await runAgentOnInbound(
    world.supabase,
    world.args as Parameters<typeof runAgentOnInbound>[1],
  );
  return { outcome, ...world.result(), supabase: world.supabase };
}
const send = (items: Array<{ id: unknown; caption: string }>) => ({
  name: "send_products",
  args: { products: items.map((i) => ({ product_id: i.id, caption: i.caption })) },
});

describe("the reply goes out exactly as the model ordered it", () => {
  it("pictures first, then the words, when the model wrote nothing before them", async () => {
    const r = await reply((ctx) =>
      ctx.step === 0
        ? { calls: [send([{ id: chevron["id"], caption: "Chevron" }])] }
        : { text: 'Like it?\n{"needs_owner": false}' },
    );
    expect(r.sent.map((s) => [s.type, s.text])).toEqual([
      ["image", "Chevron"],
      ["text", "Like it?"],
    ]);
  });

  it("only pictures: still an answer (not 'nothing to say'), nothing added", async () => {
    const r = await reply((ctx) =>
      ctx.step === 0
        ? {
            text: '{"needs_owner": false}',
            calls: [send([{ id: chevron["id"], caption: "Chevron" }])],
          }
        : { text: "" },
    );
    expect(r.status).toBe("ok");
    expect(r.sent.map((s) => s.type)).toEqual(["image"]);
  });

  it("two sets of pictures, each after the words written with it; a product without a photo goes as its caption", async () => {
    // This model sends without searching. An ask the early catalogue search
    // (Batch 15C) finds nothing for keeps it that way: with "show me rings"
    // the early rings search would count as the run's search, and the
    // only-offer-what-search-found guard rightly drops the unsearched
    // "And earrings:" line.
    const r = await reply(
      (ctx) => {
        if (ctx.step === 0)
          return { text: "Rings:", calls: [send([{ id: chevron["id"], caption: "Chevron" }])] };
        if (ctx.step === 1)
          return {
            text: "And earrings:",
            calls: [send([{ id: earrings["id"], caption: "Pink sapphire earrings" }])],
          };
        return { text: "Which one?" };
      },
      { ask: "what do you have" },
    );
    expect(r.sent.map((s) => [s.type, s.text])).toEqual([
      ["text", "Rings:"],
      ["image", "Chevron"],
      ["text", "And earrings:"],
      ["text", "Pink sapphire earrings"],
      ["text", "Which one?"],
    ]);
  });

  it("an id the model got wrong is answered to the model — the chat is not handed over", async () => {
    const r = await reply((ctx) => {
      if (ctx.step === 0) return { calls: [send([{ id: "made-up", caption: "x" }])] };
      if (ctx.step === 1) return { calls: [send([{ id: chevron["id"], caption: "Chevron" }])] };
      return { text: "Like it?" };
    });
    expect(r.status).toBe("ok");
    expect(r.sent.map((s) => s.text)).toEqual(["Chevron", "Like it?"]);
  });

  it("a caption's guessed number or promise is blocked like the reply's (no promise line in a caption)", async () => {
    const r = await reply((ctx) =>
      ctx.step === 0
        ? {
            calls: [
              send([
                {
                  id: chevron["id"],
                  caption:
                    "The Gilded Chevron — ₹19,604. Gross weight 4.75 g. Free same-day delivery across India!",
                },
              ]),
            ],
          }
        : { text: "Like it?" },
    );
    expect(r.sent.map((s) => s.text)).toEqual(["The Gilded Chevron — ₹19,604.", "Like it?"]);
    expect(r.gapFiled).toBe(true);
  });

  it("the model's reply-to product is the one stored on Aiden's own picture", async () => {
    const r = await reply(() => ({ text: "Noted!" }), {
      ask: "this one",
      history: [
        {
          direction: "outbound",
          type: "image",
          body: "Some caption",
          media_url: "https://cdn/x.jpg",
          meta: "wamid.mine",
          metadata: { kind: "ai_product", product_id: String(architect["id"]) },
        },
      ],
      replyTo: "wamid.mine",
    });
    expect(r.systems[0]).toContain("WhatsApp reply to your picture of The Architect");
    expect(r.systems[0]).toContain('"price":"₹26,446"');
  });

  it("a reply to a plain text, or to a customer's own message, changes nothing", async () => {
    const plain = await reply(() => ({ text: "Sure." }), {
      ask: "yes",
      history: [{ direction: "outbound", body: "Want to see rings?", meta: "wamid.text" }],
      replyTo: "wamid.text",
    });
    expect(plain.systems[0]).not.toContain("WhatsApp reply to your picture");
  });

  it("Aiden's pictures carry the product id, so a later reply-to finds it", async () => {
    const r = await reply((ctx) =>
      ctx.step === 0
        ? { calls: [send([{ id: chevron["id"], caption: "Chevron" }])] }
        : { text: "Like it?" },
    );
    const { data } = await r.supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", CONV)
      .eq("type", "image");
    expect((data as Array<{ metadata: Record<string, unknown> }>).map((m) => m.metadata)).toEqual([
      { kind: "ai_product", product_id: chevron["id"] },
    ]);
  });
});

describe("pictures are offered only where they can reach a customer", () => {
  it("the owner's onboarding chat and a teammate's draft are never offered send_products", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-06T10:20:00Z") });
    const { executeRun } = await import("./ai-run.server");
    for (const opts of [
      { task: "agent_reply" as const, channel: "onboarding" as const },
      { task: "suggest_reply" as const },
    ]) {
      const world = zooriWorld({
        id: "unit",
        ask: "show me rings",
        model: () => ({ text: "Here you go." }),
      });
      vi.stubGlobal("fetch", world.fetchStub);
      await executeRun(world.supabase, {
        organizationId: ORG,
        input: "show me rings",
        useTools: true,
        ...opts,
      });
      const r = world.result();
      expect(r.toolsOffered).toContain("catalog_search");
      expect(r.toolsOffered).not.toContain("send_products");
      expect(r.systems[0]).not.toMatch(/send_products/);
    }
  });
});

describe("unchanged: the flows 'Show products' captions", () => {
  it("an item without a model caption is captioned name — price (and link) as before", async () => {
    const { productCaption } = await import("./product-pictures.server");
    expect(
      productCaption(
        {
          title: "Tiered Vertex",
          imageUrl: "x",
          price: 49196.55,
          currency: "INR",
          productUrl: "https://z/p",
        },
        true,
      ),
    ).toBe("Tiered Vertex — ₹49,197\nhttps://z/p");
  });
});
