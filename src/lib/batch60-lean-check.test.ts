import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";
import {
  ANSWER_POLICY,
  executeRun,
  groundedClaims,
  lowestReasoningEffort,
  mainShopLink,
  policyClaimSentences,
  statesConcreteValue,
  stripSentences,
  stripUnsupported,
  warmFallbackLine,
} from "./ai-run.server";
import { shopInstructionsOf } from "./brief-order";

/**
 * Batch 60: a lean fact check and no hidden thinking.
 *  (1) Only a sentence stating a concrete value is a policy claim.
 *  (2) The shop's own instructions are always material, and true.
 *  (3) An unsupported sentence is taken out — no rewrite call, no "let me
 *      confirm" line; nothing left → one warm line with the shop's link.
 *  (4) Customer replies and the check ask for the lowest reasoning setting.
 *  Addendum: one short platform core first, the shop's instructions in charge.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

// Zoori's own words (test-support/zoori-replay.ts INSTRUCTIONS), the part that matters here.
const ZOORI_INSTRUCTIONS =
  "You are Zoori's assistant on WhatsApp. Three promises you can always state: lifelong free maintenance, 20-day no-questions returns, certified stones and real gold. " +
  "For rings, point them to myzoori.com/size-guide. Website prices are the price to pay — no showroom markup.";

// ------------------------------------------------------------------ (1)
describe("(1) the claim gate: a concrete value, never a link or a topic word alone", () => {
  it("a sentence pointing to a link is not a claim (it matched only on 'price' before)", () => {
    const s =
      "Great choice 💍 You can see every design with its latest price right here: https://myzoori.com/collections/rings";
    expect(statesConcreteValue(s)).toBe(false);
    expect(policyClaimSentences(s)).toEqual([]);
    // A link's own digits are not a figure.
    expect(policyClaimSentences("See our offers here: https://shop.example/sale-2026/50")).toEqual(
      [],
    );
  });

  it("topic-only sentences are not claims", () => {
    expect(
      policyClaimSentences(
        "Ask me about prices anytime. We have lovely offers on our website. Returns are easy to request. If you want, I can share the refund details.",
      ),
    ).toEqual([]);
  });

  it("'₹45,000', '20% off', 'delivery in 3 days', 'free lifelong polishing' are claims", () => {
    const answer =
      "This ring is ₹45,000. Get 20% off this week. We offer delivery in 3 days. You also get free lifelong polishing.";
    expect(policyClaimSentences(answer)).toEqual([
      "This ring is ₹45,000.",
      "Get 20% off this week.",
      "We offer delivery in 3 days.",
      "You also get free lifelong polishing.",
    ]);
  });

  it("other value shapes: Rs/INR, a number with a policy word, number words, 'no-cost', promise words", () => {
    for (const s of [
      "Making charges are Rs 1,200.",
      "EMI on 6 months is available.",
      "It reaches you in two days.",
      "Haan, sabhi orders par no-cost EMI milta hai.",
      "Every stone is guaranteed real.",
      "20-day no-questions returns.",
    ]) {
      expect(statesConcreteValue(s), s).toBe(true);
    }
    // "feel free" is not a promise; a number without a policy word is the number guard's.
    expect(statesConcreteValue("Feel free to ask about delivery.")).toBe(false);
    expect(statesConcreteValue("We have 12 new designs this month.")).toBe(false);
  });

  it("unchanged: questions, 'let me confirm' and saying the detail is missing are never claims", () => {
    expect(
      policyClaimSentences(
        "Is ₹45,000 your budget? Let me confirm the 20% offer. I don't have the 3-day delivery details.",
      ),
    ).toEqual([]);
  });
});

// ------------------------------------------------------------------ (2)
describe("(2) the shop's instructions count as material", () => {
  it("'lifelong free maintenance and 20-day returns' is grounded in the instructions alone (no model check)", () => {
    const s = "Every piece is certified, plus lifelong free maintenance and 20-day returns.";
    expect(groundedClaims([s], ZOORI_INSTRUCTIONS)).toEqual([s]);
  });

  it("a value the instructions attach to another policy is not grounded", () => {
    // "free" belongs to maintenance in the instructions, not to shipping; 20 belongs to returns.
    expect(
      groundedClaims(["Free shipping on every order.", "Delivery in 20 days."], ZOORI_INSTRUCTIONS),
    ).toEqual([]);
    // A passage that denies the policy never supports it.
    expect(
      groundedClaims(
        ["Returns within 7 days."],
        "No returns on sale items. Exchange within 7 days.",
      ),
    ).toEqual([]);
    // A figure is matched whole ("20" is not in "2026"), commas ignored.
    expect(groundedClaims(["The ring is ₹45,000."], "Price list 2026: ring 45000 INR")).toEqual([
      "The ring is ₹45,000.",
    ]);
    expect(groundedClaims(["Returns within 20 days."], "Returns policy updated 2026.")).toEqual([]);
  });

  it("shopInstructionsOf reads the brief's own instructions section (the Playground's override included)", () => {
    expect(
      shopInstructionsOf({
        sections: [
          { key: "rules", text: "x" },
          { key: "instructions", text: "  Be kind. https://a.example  " },
        ],
      }),
    ).toBe("Be kind. https://a.example");
    expect(shopInstructionsOf({ sections: [] })).toBe("");
  });
});

// ------------------------------------------------------------------ (3)
describe("(3) stripping adds nothing; the warm line is code's", () => {
  it("stripSentences / stripUnsupported never append a confirm line", () => {
    expect(
      stripSentences("Returns are free forever. Want to see rings?", ["Returns are free forever."]),
    ).toBe("Want to see rings?");
    expect(stripSentences("Returns are free forever.", ["Returns are free forever."])).toBe("");
    expect(stripUnsupported("The Petal Band is ₹9,999.", ["9,999"])).toBe("");
  });

  it("the warm line uses the shop's main link from its instructions, else the team's help", () => {
    expect(mainShopLink("Shop at https://shop.example/new. Thanks")).toBe(
      "https://shop.example/new",
    );
    expect(mainShopLink(ZOORI_INSTRUCTIONS)).toBe("https://myzoori.com");
    expect(mainShopLink("No links here.")).toBeNull();
    expect(warmFallbackLine(ZOORI_INSTRUCTIONS)).toBe(
      "You can see our full range with the latest details here: https://myzoori.com 😊 Happy to help with anything else!",
    );
    expect(warmFallbackLine(ZOORI_INSTRUCTIONS, "hi-Latn")).toContain("https://myzoori.com");
    expect(warmFallbackLine("")).toBe(
      "Our team will help you with this 😊 Meanwhile, happy to help with anything else!",
    );
    for (const line of [warmFallbackLine(ZOORI_INSTRUCTIONS), warmFallbackLine("", "hi-Latn")]) {
      expect(line).not.toMatch(/let me confirm|don.t have that detail/i);
    }
  });
});

// ------------------------------------------------------------------ executeRun
type Body = Record<string, unknown> & { messages?: Array<{ role: string; content: unknown }> };

function aiDb(chunks: string[], modelId = "google/gemini-3.6-flash") {
  return fakeDb(
    (op: FakeOp) => {
      if (op.table === "organization_ai_settings")
        return {
          data: {
            ai_enabled: true,
            ai_monthly_cap_amount: 1000,
            currency: "INR",
            ai_markup_multiplier: 3,
          },
          error: null,
        };
      if (op.table === "platform_settings")
        return {
          data: { ai_monthly_cap_amount: 100000, ai_cap_currency: "INR", ai_markup_multiplier: 3 },
          error: null,
        };
      if (op.table === "ai_runs" && op.kind === "insert")
        return { data: { id: "run-1" }, error: null };
      if (op.table === "ai_tiers")
        return {
          data: {
            key: "everyday",
            display_name: "Everyday",
            provider: "lovable",
            model_id: modelId,
            is_active: true,
          },
          error: null,
        };
      if (op.table === "ai_models")
        return {
          data: { supports_tools: true, is_available: true, is_deprecated: false },
          error: null,
        };
      return undefined;
    },
    (call) => {
      if (call.name === "match_knowledge_chunks")
        return {
          data: chunks.map((text, i) => ({
            document_id: `d${i}`,
            source_type: "website",
            source_name: "site",
            source_ref: "https://shop.example/",
            title: `page ${i + 1}`,
            text,
            similarity: 0.5,
          })),
          error: null,
        };
      if (call.name === "ai_month_spend" || call.name === "platform_ai_month_spend")
        return { data: 0, error: null };
      return undefined;
    },
  );
}

/** Every model request, in order; the answer model says `answer`, the check says `verdict` per sentence. */
function stub(answer: string, verdict: (sentence: string) => "yes" | "no" = () => "yes") {
  const calls: Array<{ kind: "answer" | "check" | "other"; body: Body; url: string }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (String(url).endsWith("/embeddings"))
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }));
    const body = JSON.parse(String(init.body)) as Body;
    const system = String(
      body.messages?.[0]?.content ??
        (body["input"] as Array<{ content: Array<{ text: string }> }> | undefined)?.[0]
          ?.content?.[0]?.text ??
        "",
    );
    if (system.startsWith("You check whether sentences")) {
      calls.push({ kind: "check", body, url: String(url) });
      const lines = String(body.messages?.at(-1)?.content ?? "").match(/^\d+\. .*$/gm) ?? [];
      const answers = lines.map((l) => verdict(l.replace(/^\d+\. /, "")));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answers }) } }] }),
      );
    }
    calls.push({
      kind: system.startsWith("You edit a shop assistant") ? "other" : "answer",
      body,
      url: String(url),
    });
    if (String(url).endsWith("/responses")) {
      const completed = {
        type: "response.completed",
        response: {
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: `${answer}\n{"needs_owner": false}` }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      };
      return new Response(`data: ${JSON.stringify(completed)}\n\n`);
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: `${answer}\n{"needs_owner": false}` } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
  });
  return calls;
}

const ask = (db: ReturnType<typeof aiDb>, input: string, extra: Record<string, unknown> = {}) =>
  executeRun(db.supabase, {
    organizationId: "org",
    task: "agent_reply",
    tier: "everyday",
    conversationId: "conv-1",
    contactId: "c1",
    input,
    system: `You answer on behalf of this business.\n\n${ZOORI_INSTRUCTIONS}`,
    shopInstructions: ZOORI_INSTRUCTIONS,
    useKnowledge: true,
    useTools: false,
    ...extra,
  });

const runMeta = (db: ReturnType<typeof aiDb>) =>
  db.ops
    .filter((o) => o.table === "ai_runs" && o.kind === "insert")
    .map((o) => (o.payload as { metadata?: Record<string, unknown> }).metadata ?? {})
    .find((m) => !m["purpose"])!;

describe("executeRun: the lean check end to end (fakes only)", () => {
  beforeEach(() => {
    process.env["LOVABLE_API_KEY"] = "test-key";
  });

  it("the live link sentence goes out untouched with one AI call", async () => {
    const reply =
      "Great choice 💍 You can see every design with its latest price right here: https://myzoori.com/collections/rings";
    const calls = stub(reply);
    const out = await ask(aiDb([]), "diamond ring price?");
    expect(out.output).toBe(reply);
    expect(calls.map((c) => c.kind)).toEqual(["answer"]);
  });

  it("'lifelong free maintenance and 20-day returns' from the instructions is sent as written, no check call", async () => {
    const reply = "Every piece is certified, plus lifelong free maintenance and 20-day returns.";
    const calls = stub(reply, () => "no");
    const db = aiDb([]);
    const out = await ask(db, "what do I get with a ring?");
    expect(out.output).toBe(reply);
    expect(runMeta(db)["policy_claims_stripped"]).toBeUndefined();
    expect(calls.map((c) => c.kind)).toEqual(["answer"]);
    expect(runMeta(db)["policy_check"]).toEqual({
      claims: 1,
      verbatim: 0,
      grounded: 1,
      model_checked: 0,
    });
  });

  it("the instructions reach the check prompt first, labelled as true, when a claim needs the model", async () => {
    const calls = stub("We ship every order within 20 days.");
    await ask(aiDb(["Our story: handmade in Hyderabad."]), "how do you ship?");
    const check = calls.find((c) => c.kind === "check")!;
    const input = String(check.body.messages!.at(-1)!.content);
    expect(input.startsWith(`SHOP'S OWN INSTRUCTIONS (always true):\n${ZOORI_INSTRUCTIONS}`)).toBe(
      true,
    );
    expect(String(check.body.messages![0]!.content)).toContain(
      "Anything the shop's own instructions state is true",
    );
  });

  it("an unsupported sentence is stripped with no rewrite call and no confirm line; at most 2 AI calls", async () => {
    const calls = stub("We ship every order within 20 days. Want to see our rings?", (s) =>
      /ship/.test(s) ? "no" : "yes",
    );
    const db = aiDb([]);
    const out = await ask(db, "how do you ship?");
    expect(out.output).toBe("Want to see our rings?");
    expect(out.output).not.toMatch(/let me confirm|don.t have that detail/i);
    expect(out.needsOwner).toBe(true);
    expect(calls.map((c) => c.kind)).toEqual(["answer", "check"]);
    expect(runMeta(db)["policy_rewrite"]).toBeUndefined();
  });

  it("nothing left: the warm link line, no AI call for it, filed for the owner", async () => {
    const calls = stub("We ship every order within 20 days.", () => "no");
    const db = aiDb([]);
    const out = await ask(db, "how do you ship?");
    expect(out.output).toBe(
      "You can see our full range with the latest details here: https://myzoori.com 😊 Happy to help with anything else!",
    );
    expect(out.needsOwner).toBe(true);
    expect(out.status).toBe("ok");
    expect(calls.map((c) => c.kind)).toEqual(["answer", "check"]);
    expect(runMeta(db)["warm_fallback"]).toBe(true);
  });

  it("a price the material never states is still stripped (number guard unchanged), with no AI call after the answer", async () => {
    const calls = stub("The Petal Band is ₹9,999.");
    const out = await ask(aiDb(["Petal Band — handcrafted ring."]), "price of petal band?");
    expect(out.output).not.toMatch(/9,999/);
    expect(out.output).toContain("https://myzoori.com");
    expect(calls.map((c) => c.kind)).toEqual(["answer"]);
  });

  it("a figure only the instructions state passes the number guard (instructions are material)", async () => {
    stub("Returns are accepted for 20 days.");
    const out = await ask(aiDb([]), "return policy?", {
      system: "You answer on behalf of this business.",
    });
    expect(out.output).toBe("Returns are accepted for 20 days.");
  });
});

// ------------------------------------------------------------------ (4)
describe("(4) thinking off: the lowest reasoning setting for agent_reply and the check", () => {
  beforeEach(() => {
    process.env["LOVABLE_API_KEY"] = "test-key";
  });

  it("per model, from the vendors' documented values", () => {
    expect(lowestReasoningEffort("lovable", "google/gemini-3.6-flash")).toBe("minimal");
    expect(lowestReasoningEffort("lovable", "google/gemini-3.1-flash-lite")).toBe("minimal");
    expect(lowestReasoningEffort("lovable", "google/gemini-3.1-pro-preview")).toBe("low");
    expect(lowestReasoningEffort("lovable", "google/gemini-2.5-flash")).toBe("none");
    expect(lowestReasoningEffort("lovable", "openai/gpt-5.4")).toBe("none");
    expect(lowestReasoningEffort("lovable", "openai/gpt-5.4-mini")).toBe("none");
    expect(lowestReasoningEffort("lovable", "openai/gpt-5.6-terra")).toBe("none");
    expect(lowestReasoningEffort("lovable", "openai/gpt-5-mini")).toBe("minimal");
    expect(lowestReasoningEffort("google", "gemini-3.6-flash")).toBe("minimal");
    expect(lowestReasoningEffort("anthropic", "claude-sonnet-5-5")).toBeNull();
    expect(lowestReasoningEffort("lovable", "openai/gpt-4o-mini")).toBeNull();
  });

  it("Gemini (chat-completions): reasoning_effort 'minimal' on the reply and on the check", async () => {
    const calls = stub("We ship every order within 20 days.");
    const db = aiDb([]);
    await ask(db, "how do you ship?");
    expect(calls.map((c) => [c.kind, c.body["reasoning_effort"]])).toEqual([
      ["answer", "minimal"],
      ["check", "minimal"],
    ]);
    expect(runMeta(db)["reasoning_effort"]).toBe("minimal");
  });

  it("OpenAI (Responses): reasoning.effort 'none' on the reply", async () => {
    const calls = stub("Hi! How can I help?");
    await ask(aiDb([], "openai/gpt-5.4"), "hi");
    expect(calls[0]!.url).toMatch(/\/responses$/);
    expect(calls[0]!.body["reasoning"]).toEqual({ effort: "none" });
  });

  it("other tasks are untouched (no reasoning field)", async () => {
    const calls = stub("A summary.");
    await executeRun(aiDb([]).supabase, {
      organizationId: "org",
      task: "summarise",
      tier: "everyday",
      input: "summarise",
      useKnowledge: false,
      useTools: false,
    });
    expect(calls[0]!.body["reasoning_effort"]).toBeUndefined();
  });

  it("a gateway that refuses the field is asked again without it (a setting never costs a reply)", async () => {
    const bodies: Body[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (String(url).endsWith("/embeddings"))
        return new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }));
      const body = JSON.parse(String(init.body)) as Body;
      bodies.push(body);
      if (body["reasoning_effort"])
        return new Response(
          JSON.stringify({ error: { message: "Unknown parameter: reasoning_effort" } }),
          { status: 400 },
        );
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Hi there!\n{"needs_owner": false}' } }],
        }),
      );
    });
    const out = await ask(aiDb([]), "hi");
    expect(out.output).toBe("Hi there!");
    expect(bodies.map((b) => b["reasoning_effort"] ?? null)).toEqual(["minimal", null]);
  });
});

// ------------------------------------------------------------------ addendum
describe("addendum: one short platform core first, the shop's instructions in charge", () => {
  beforeEach(() => {
    process.env["LOVABLE_API_KEY"] = "test-key";
  });

  it("the core is short and safety-only: no forced phrase, no link ban", () => {
    expect(ANSWER_POLICY.split("\n").length).toBeLessThanOrEqual(7);
    expect(ANSWER_POLICY).toMatch(/instructions are in charge/);
    expect(ANSWER_POLICY).not.toMatch(/let me confirm/i);
    expect(ANSWER_POLICY).toMatch(
      /Only use a URL that appears in the business's instructions or the material/,
    );
  });

  it("the system prompt is [core] + [brief with the instructions], then the material; no URL ban", async () => {
    const calls = stub("Hello!");
    await ask(aiDb(["Rings page: handmade rings."]), "rings?");
    const system = String(calls[0]!.body.messages![0]!.content);
    expect(system.startsWith(ANSWER_POLICY)).toBe(true);
    expect(system.indexOf(ZOORI_INSTRUCTIONS)).toBeGreaterThan(0);
    expect(system.indexOf(ZOORI_INSTRUCTIONS)).toBeLessThan(
      system.indexOf("Material from this business follows."),
    );
    expect(system).not.toMatch(/do not output a URL at all/);
    expect(system).toMatch(/you may end your answer with that URL/);
  });
});
