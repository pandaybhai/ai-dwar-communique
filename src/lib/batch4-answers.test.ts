import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";

/**
 * Batch 4, items 2–4: what a customer reads.
 *  (2) citation markers never reach a customer;
 *  (3) policy wording must be what the retrieved material says;
 *  (4) a browse with nothing at the budget states what exists, with its price,
 *      offers only what the search returned, and adds no "let me confirm".
 */

// The catalogue tool runs for real (AI_TOOL_HANDLERS.catalogSearch); only the
// permission broker around it is stubbed.
vi.mock("@/lib/ai-tools.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("./ai-tools.server")>();
  const catalogTool = {
    name: "catalog_search",
    description: "browse",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    feature: "catalog",
    access: "read",
  };
  return {
    ...real,
    brokerTools: async () => [catalogTool],
    invokeTool: async (ctx: Parameters<typeof real.invokeTool>[0], name: string, args: Record<string, unknown>) => {
      const handler = real.AI_TOOL_HANDLERS["catalogSearch"]!;
      const out = await handler(ctx, args);
      return { ...out, latencyMs: 1, activityLogId: null, arguments: args, resultSummary: {} };
    },
  };
});

import {
  checkPolicyWording,
  closestShelfLine,
  executeRun,
  policyClaimSentences,
  stripCitationMarkers,
  unsearchedShelfOffers,
} from "./ai-run.server";
import { AI_TOOL_HANDLERS } from "./ai-tools.server";

// ------------------------------------------------------------------ (2)
describe("(2) citation markers are stripped from customer-facing replies", () => {
  it("removes the markers seen in live replies", () => {
    expect(stripCitationMarkers("We offer 20-day returns, no questions asked. [2]")).toBe(
      "We offer 20-day returns, no questions asked.",
    );
    expect(stripCitationMarkers("Riveted Chrono is ₹40,419.70. [1]  \nWhat's your ring size?")).toBe(
      "Riveted Chrono is ₹40,419.70.\nWhat's your ring size?",
    );
    expect(stripCitationMarkers("It's a gold ring [1][3], and customisable [2, 4].")).toBe(
      "It's a gold ring, and customisable.",
    );
    expect(stripCitationMarkers("Ships in 3 days 【2】 (source [5])")).toBe("Ships in 3 days");
    expect(stripCitationMarkers("Hallmarked gold [3†faq].")).toBe("Hallmarked gold.");
  });

  it("unchanged: brackets that aren't citations stay", () => {
    const text = "Tap one [buttons: Shop, Track]\n[Customer sent a picture: ring] see [the size guide](https://x.y/size)";
    expect(stripCitationMarkers(text)).toBe(text);
    expect(stripCitationMarkers("Size 12 ring, ₹16,805.")).toBe("Size 12 ring, ₹16,805.");
    expect(stripCitationMarkers("Bonjour ! Prix : 500  \nMerci")).toBe("Bonjour ! Prix : 500  \nMerci");
  });
});

// ------------------------------------------------------------------ (3)
// What the user reports the site says (short badges) vs what myzoori.com/faq
// actually says today (both retrieved in the live run on 29 Sep).
const BADGES = "[1] Home\nhttps://myzoori.com/\n3 Key Promises\n20-Day Free Returns\nLifelong Maintenance\nCertified, Real, Always";
const FAQ =
  "[2] FAQ\nhttps://myzoori.com/faq\nWhat's your return policy? We offer 20-day returns, no questions asked. If you don't love it, it doesn't belong in your life. " +
  "Do you charge for maintenance? No. Lifelong maintenance is free — no charge, no time limit, and no fine print.";
const LIVE_ANSWER = "We offer 20-day returns, no questions asked. Lifelong free maintenance is also included.";

describe("(3) policy wording must be supported by retrieved knowledge", () => {
  it("both sentences of the live answer are policy claims (the maintenance one used to slip past)", () => {
    expect(policyClaimSentences(LIVE_ANSWER)).toEqual([
      "We offer 20-day returns, no questions asked.",
      "Lifelong free maintenance is also included.",
    ]);
  });

  it("sources say only '20-Day Free Returns' and 'Lifelong Maintenance': the added promises are replaced by the source wording", () => {
    const check = checkPolicyWording(policyClaimSentences(LIVE_ANSWER), BADGES);
    expect(check.unsupported).toEqual([
      { sentence: "We offer 20-day returns, no questions asked.", qualifiers: ["no questions asked"], replacement: "20-Day Free Returns." },
      { sentence: "Lifelong free maintenance is also included.", qualifiers: ["free"], replacement: "Lifelong Maintenance." },
    ]);
    expect(check.undecided).toEqual([]);
  });

  it("unchanged: when the retrieved FAQ says exactly that, the answer stands", () => {
    const check = checkPolicyWording(policyClaimSentences(LIVE_ANSWER), `${BADGES}\n\n${FAQ}`);
    expect(check.unsupported).toEqual([]);
    expect(check.verbatim).toEqual(["We offer 20-day returns, no questions asked."]);
    // Supported wording, not verbatim: still goes to the model check as before.
    expect(check.undecided).toEqual(["Lifelong free maintenance is also included."]);
  });

  it("no promise word, or 'feel free': nothing decided here (model check as before)", () => {
    const check = checkPolicyWording(
      ["Returns are accepted within 20 days.", "Feel free to ask about delivery."],
      BADGES,
    );
    expect(check.unsupported).toEqual([]);
    expect(check.undecided).toHaveLength(2);
  });

  it("no source line for that policy: the sentence is dropped (no replacement)", () => {
    const check = checkPolicyWording(["Shipping is free across India."], BADGES);
    expect(check.unsupported).toEqual([
      { sentence: "Shipping is free across India.", qualifiers: ["free"], replacement: null },
    ]);
  });
});

// ------------------------------------------------------------------ (4)
const RINGS = [
  { id: "p1", title: "Petal Band", category: "rings", price: 16805.32, currency: "INR", image_url: "https://img/1.jpg", availability: "in_stock" },
  { id: "p2", title: "Twist Ring", category: "rings", price: 18990, currency: "INR", image_url: "https://img/2.jpg", availability: "in_stock" },
  { id: "p3", title: "Halo Ring", category: "rings", price: 21263.21, currency: "INR", image_url: "https://img/3.jpg", availability: "in_stock" },
];
const catalogDb = () =>
  fakeDb((op: FakeOp) => {
    if (op.table !== "products") return undefined;
    const underBudget = op.filters.some(([f, a]) => f === "lte" && a[0] === "price");
    return { data: underBudget ? [] : RINGS, error: null };
  });

describe("(4) nothing at the budget: say what exists, offer only what search returned", () => {
  it("the catalogue tells the model the starting price and to offer only these products", async () => {
    const db = catalogDb();
    const out = await AI_TOOL_HANDLERS["catalogSearch"]!(
      { supabase: db.supabase, organizationId: "org", actorUserId: null, principal: { kind: "agent" }, initiatedBy: "ai" },
      { category: "rings", max_price: 2000 },
    );
    const data = (out as { data: { lowest_price: number; reply_hint: string; closest_above: unknown[] } }).data;
    expect(data.lowest_price).toBe(16805);
    expect(data.closest_above).toHaveLength(3);
    expect(data.reply_hint).toContain("our rings start at ₹16,805");
    expect(data.reply_hint).toMatch(/Offer only these products/);
    expect(data.reply_hint).not.toMatch(/different type/);
  });

  it("offers of product types the search never returned are found", () => {
    const answer = "I don’t have rings under ₹2000 right now. Want me to show more budget-friendly pendants or earrings instead?";
    const results = [JSON.stringify({ ok: true, data: { found: false, category: "rings", closest_above: RINGS } })];
    expect(unsearchedShelfOffers(answer, "Hi, do you have silver rings under 2000?", results)).toEqual([
      "Want me to show more budget-friendly pendants or earrings instead?",
    ]);
    // Asked about, or returned by the search: fine to mention.
    expect(unsearchedShelfOffers("Our earrings start at ₹27,412.", "any earrings?", [])).toEqual([]);
    // A sentence that also names what was found keeps the answer.
    expect(unsearchedShelfOffers("Our rings start at ₹16,805 and pair well with chains.", "rings under 2000", results)).toEqual([]);
  });

  it("the starting price line is added only when the answer lacks it", () => {
    const results = [JSON.stringify({ ok: true, found: false, data: { found: false, category: "rings", closest_above: RINGS } })];
    expect(closestShelfLine(results, "I don’t have rings under ₹2000 right now.")).toBe("Our rings start at ₹16,805.");
    expect(closestShelfLine(results, "Rings start at ₹16,805 — want to see them?")).toBeNull();
    expect(closestShelfLine([JSON.stringify({ ok: true, found: true, data: RINGS })], "Here you go.")).toBeNull();
  });
});

// ------------------------------------------------- end to end (items 2–4)
type Chat = { model: string; messages: Array<{ role: string; content: unknown }>; tools?: unknown[] };

function runWorld(opts: { chunks: string[] }) {
  return fakeDb(
    (op: FakeOp) => {
      if (op.table === "organization_ai_settings")
        return { data: { ai_enabled: true, ai_monthly_cap_amount: 1000, currency: "INR", ai_markup_multiplier: 3 }, error: null };
      if (op.table === "platform_settings") return { data: { ai_monthly_cap_amount: 100000, ai_cap_currency: "INR", ai_markup_multiplier: 3 }, error: null };
      if (op.table === "products" && op.kind === "select" && !op.filters.some(([f]) => f === "lte" || f === "order"))
        return { data: null, error: null, count: 3 } as never;
      if (op.table === "products") {
        const underBudget = op.filters.some(([f, a]) => f === "lte" && a[0] === "price");
        return { data: underBudget ? [] : RINGS, error: null };
      }
      if (op.table === "ai_runs" && op.kind === "insert") return { data: { id: "run-1" }, error: null };
      // The "everyday" brain on the chat-completions path (the reply guards are the same on every path).
      if (op.table === "ai_tiers")
        return { data: { key: "everyday", display_name: "Everyday", provider: "lovable", model_id: "google/gemini-3.6-flash", is_active: true }, error: null };
      if (op.table === "ai_models") return { data: { supports_tools: true, is_available: true, is_deprecated: false }, error: null };
      return undefined;
    },
    (call) => {
      if (call.name === "match_knowledge_chunks")
        return {
          data: opts.chunks.map((text, i) => ({ document_id: `d${i}`, source_type: "website", source_name: "site", source_ref: "https://myzoori.com/", title: `page ${i + 1}`, text, similarity: 0.5 })),
          error: null,
        };
      if (call.name === "record_ai_tool_calls") return { data: (call.args["p_calls"] as unknown[]).length, error: null };
      if (call.name === "ai_month_spend" || call.name === "platform_ai_month_spend") return { data: 0, error: null };
      return undefined;
    },
  );
}

function stubModel(answer: string, opts: { toolCall?: Record<string, unknown> } = {}) {
  const calls: Chat[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (String(url).endsWith("/embeddings")) return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }));
    const body = JSON.parse(String(init.body)) as Chat;
    calls.push(body);
    const system = String(body.messages[0]?.content ?? "");
    // The policy model check: lenient, like the live run ("yes" to everything).
    if (system.startsWith("You check whether sentences")) {
      const n = (String(body.messages.at(-1)?.content).match(/^\d+\. /gm) ?? []).length;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answers: Array(n).fill("yes") }) } }] }));
    }
    const toolAnswered = body.messages.some((m) => m.role === "tool");
    if (opts.toolCall && !toolAnswered) {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "catalog_search", arguments: JSON.stringify(opts.toolCall) } }] } }],
        }),
      );
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: answer } }] }));
  });
  return calls;
}

describe("end to end through executeRun (the live replies, replayed)", () => {
  beforeEach(() => {
    process.env["LOVABLE_API_KEY"] = "test-key";
  });
  afterEach(() => vi.unstubAllGlobals());

  const run = (db: ReturnType<typeof runWorld>, input: string, useTools: boolean) =>
    executeRun(db.supabase, {
      organizationId: "org",
      task: "agent_reply",
      tier: "everyday",
      conversationId: "conv-1",
      contactId: "c1",
      input,
      system: "You answer on behalf of this business.",
      useKnowledge: true,
      useTools,
    });

  it("(2)+(3) badges only: no [2], and the returns/maintenance promises become the site's own words", async () => {
    stubModel(`${LIVE_ANSWER} [2]\n{"needs_owner": false}`);
    const out = await run(runWorld({ chunks: [BADGES.split("\n").slice(2).join("\n")] }), "What is your return policy?", false);
    expect(out.output).toBe("20-Day Free Returns. Lifelong Maintenance.");
    expect(out.output).not.toMatch(/\[\d\]|no questions|free maintenance/i);
  });

  it("(3) unchanged: with the FAQ retrieved, the same answer is sent as written (minus the marker)", async () => {
    stubModel(`${LIVE_ANSWER} [2]\n{"needs_owner": false}`);
    const out = await run(runWorld({ chunks: [FAQ] }), "What is your return policy?", false);
    expect(out.output).toBe(LIVE_ANSWER);
    expect(out.needsOwner).toBe(false);
  });

  it("(4) 'silver rings under 2000': states rings from ₹16,805, no pendants/earrings, no 'let me confirm'", async () => {
    const calls = stubModel(
      'I don’t have rings under ₹2000 right now. Want me to show more budget-friendly pendants or earrings instead?\n\nLet me confirm that for you.\n{"needs_owner": false}',
      { toolCall: { category: "rings", max_price: 2000, limit: 5 } },
    );
    const out = await run(runWorld({ chunks: [] }), "Hi, do you have silver rings under 2000?", true);
    expect(out.output).toBe("I don’t have rings under ₹2000 right now.\n\nOur rings start at ₹16,805.");
    expect(out.needsOwner).toBe(false);
    expect(out.status).toBe("ok");
    // The model was told the same thing by the tool.
    const toolMsg = calls.at(-1)!.messages.find((m) => m.role === "tool");
    expect(String(toolMsg?.content)).toContain("our rings start at ₹16,805");
  });

  it("(4) unchanged: a real 'let me confirm' about an unsourced policy stays (and is filed for the owner)", async () => {
    stubModel(
      'Our rings start at ₹16,805. Delivery time — let me confirm that for you.\n{"needs_owner": true}',
      { toolCall: { category: "rings" } },
    );
    const out = await run(runWorld({ chunks: [] }), "rings? and how long is delivery?", true);
    expect(out.output).toMatch(/let me confirm that for you/i);
    expect(out.needsOwner).toBe(true);
  });

  it("(3) unchanged: a price the material never mentions is still stripped with the confirm line", async () => {
    stubModel('The Petal Band is ₹9,999.\n{"needs_owner": false}');
    const out = await run(runWorld({ chunks: ["Petal Band — handcrafted ring."] }), "price of petal band?", false);
    expect(out.output).toBe("Let me confirm that for you.");
    expect(out.needsOwner).toBe(true);
  });
});
