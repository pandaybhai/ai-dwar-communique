import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CASES,
  INSTRUCTIONS,
  PRODUCTS,
  fixedTexts,
  inventedAmounts,
  paisePrices,
  productLinks,
  questionCount,
  referenceLeaks,
  textsOf,
  zooriWorld,
  type Case,
  type Replay,
} from "./test-support/zoori-replay";

/**
 * Batch 14 — Aiden follows the merchant's instructions. Regression set.
 *
 * 23 customer messages from Zoori's live traffic and typical asks (the live
 * conversation 7230c5b2…, 6 Oct 10:12–10:17 UTC, plus the asks a jewellery
 * shop gets every day) go through runAgentOnInbound against Zoori's real
 * instructions, catalogue slice and website text. Only the model is scripted.
 *
 * aiden-replay/baseline.json is what main (b7f5670) sent for the same
 * messages, recorded with REPLAY_WRITE=baseline in a checkout of main; this
 * branch's run is compared against it and written with REPLAY_WRITE=after
 * (aiden-replay/after.json and the before/after table in table.md).
 *
 * Every reply on this branch must have: no source reference, no text code
 * wrote, at most one question, no invented or paise price — and per case:
 * product captions with their real link, ring size asked for rings, the
 * guards still blocking a guessed EMI / delivery time / price, the reply-to
 * product known.
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

const DIR = join(__dirname, "test-support", "aiden-replay");
const NOW = new Date("2026-10-06T10:20:00Z");

async function replay(c: Case): Promise<Replay> {
  const world = zooriWorld(c);
  vi.stubGlobal("fetch", world.fetchStub);
  const { runAgentOnInbound } = await import("./ai-agent.server");
  await runAgentOnInbound(world.supabase, world.args as Parameters<typeof runAgentOnInbound>[1]);
  vi.unstubAllGlobals();
  return world.result();
}

/** One reply as the customer saw it, for the table. */
function shown(r: Replay | undefined): string {
  if (!r) return "—";
  const lines = r.sent.map((s) =>
    s.type === "image" ? `🖼 ${s.text.replace(/\n/g, " ")}` : s.text.replace(/\n+/g, " ⏎ "),
  );
  return lines.join(" ‖ ").replace(/\|/g, "\\|") || "(nothing sent)";
}

const results = new Map<string, Replay>();

beforeAll(async () => {
  process.env["LOVABLE_API_KEY"] = "test-key";
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const c of CASES) results.set(c.id, await replay(c));

  const mode = process.env["REPLAY_WRITE"];
  if (mode === "baseline" || mode === "after") {
    mkdirSync(DIR, { recursive: true });
    const dump = Object.fromEntries(
      CASES.map((c) => [c.id, { ask: c.ask, ...results.get(c.id)!, systems: undefined }]),
    );
    writeFileSync(join(DIR, `${mode}.json`), `${JSON.stringify(dump, null, 2)}\n`);
  }
  if (mode === "after") {
    const base = JSON.parse(readFileSync(join(DIR, "baseline.json"), "utf8")) as Record<
      string,
      Replay
    >;
    const rows = CASES.map(
      (c) => `| ${c.ask} | ${shown(base[c.id])} | ${shown(results.get(c.id))} |`,
    );
    writeFileSync(
      join(DIR, "table.md"),
      [
        "| Customer | main (before) | this branch (after) |",
        "| --- | --- | --- |",
        ...rows,
        "",
      ].join("\n"),
    );
  }
});

afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

const baselinePath = join(DIR, "baseline.json");
const baseline = existsSync(baselinePath)
  ? (JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, Replay>)
  : null;

describe("the baseline (main) shows the live faults the checks look for", () => {
  it("was recorded on main for every case", () => {
    expect(baseline).not.toBeNull();
    expect(Object.keys(baseline!).sort()).toEqual(CASES.map((c) => c.id).sort());
  });
  it("'what is zoori' leaked 'Item 6.'", () => {
    expect(referenceLeaks(textsOf(baseline!["what-is-zoori"]!).join("\n"))).toContain("Item 6");
  });
  it("'show me products' carried code's fixed tail and two questions, pictures with no link", () => {
    const r = baseline!["show-me-products"]!;
    expect(fixedTexts(r)).not.toEqual([]);
    expect(questionCount(r)).toBe(2);
    const pictures = r.sent.filter((s) => s.type === "image");
    expect(pictures.length).toBeGreaterThan(0);
    expect(pictures.every((p) => !/https?:\/\//.test(p.text))).toBe(true);
  });
  it("'The Gilded Chevron' was quoted in paise and the ring size asked 'if it's a ring'", () => {
    const r = baseline!["the-gilded-chevron"]!;
    expect(paisePrices(r)).toEqual(["₹19,603.91"]);
    expect(textsOf(r).join("\n")).toMatch(/If it’s a ring/);
  });
  it("'I like this' replying to the Gilded Chevron picture still asked which one", () => {
    expect(textsOf(baseline!["i-like-this-reply-to"]!).join("\n")).toMatch(
      /Which one did you like/,
    );
  });
  it("'earrings dikhao' with the live arguments found no earrings (6 Oct 11:18)", () => {
    expect(textsOf(baseline!["earrings-live-args"]!).join("\n")).toMatch(/not seeing earrings/);
  });
});

describe("this branch: every reply is the model's, cleanly", () => {
  for (const c of CASES) {
    describe(c.id, () => {
      const r = () => results.get(c.id)!;

      it("sends something", () => {
        expect(r().sent.length).toBeGreaterThan(0);
      });
      it("no source reference reaches the customer", () => {
        expect(textsOf(r()).flatMap(referenceLeaks)).toEqual([]);
      });
      it("no text that code wrote", () => {
        expect(fixedTexts(r())).toEqual([]);
      });
      it("at most one question", () => {
        expect(questionCount(r())).toBeLessThanOrEqual(1);
      });
      it("no invented price, none in paise", () => {
        expect(inventedAmounts(r())).toEqual([]);
        expect(paisePrices(r())).toEqual([]);
      });

      const checks = new Set(c.checks ?? []);
      if (checks.has("products_with_links")) {
        it("each product goes out under the model's caption, with its real price and link", () => {
          const product = r().sent.filter(
            (s) => s.type === "image" || /https?:\/\/\S*product-detail/.test(s.text),
          );
          // Zoori has one gents ring under ₹50,000 (gender is set on 10 of 472 products).
          expect(product.length).toBeGreaterThanOrEqual(c.id === "gents-ring-under-50k" ? 1 : 2);
          for (const p of product) {
            const link = [...productLinks.keys()].find((u) => p.text.includes(u));
            expect(link, p.text).toBeDefined();
            const row = productLinks.get(link!)!;
            expect(p.text).toContain(
              new Intl.NumberFormat("en-IN", {
                style: "currency",
                currency: "INR",
                maximumFractionDigits: 0,
              }).format(Math.round(Number(row["price"]))),
            );
            if (p.type === "image") expect(p.link).toBe(row["image_url"]);
          }
        });
      }
      if (checks.has("text_before_pictures")) {
        it("the model's words come where it put them: intro, pictures, then its question", () => {
          const types = r().sent.map((s) => s.type);
          expect(types[0]).toBe("text");
          expect(types.at(-1)).toBe("text");
          expect(types.slice(1, -1).every((t) => t === "image")).toBe(true);
        });
      }
      if (checks.has("ring_size")) {
        it("asks the ring size directly — the model knew it was a ring", () => {
          const all = textsOf(r()).join("\n");
          expect(all).toMatch(/ring size/i);
          expect(all).not.toMatch(/if it[’']?s a ring/i);
        });
      }
      if (checks.has("guard_fired")) {
        it("the guessed figure or policy is blocked and filed for the owner", () => {
          const all = textsOf(r()).join("\n");
          expect(all).not.toMatch(/5-7|₹2,000|no-cost EMI|₹12,500/);
          expect(r().gapFiled || r().status === "escalated").toBe(true);
        });
      }
      if (checks.has("handover")) {
        it("nothing true was left: no guess, and Aiden keeps the chat (Batch 16: no hand-off for not knowing)", () => {
          // Was: escalated + the workspace's hand-over line, which silenced
          // Aiden on the thread. Now the run stands, the question is filed
          // for the merchant (whose answer reaches this customer) and the
          // thread is never put on needs_human.
          expect(r().status).toBe("ok");
          expect(r().gapFiled).toBe(true);
          expect(r().handedOff ?? false).toBe(false);
          expect(textsOf(r())).toEqual(["Let me confirm that for you."]);
        });
      }
      if (checks.has("reply_to_known")) {
        it("the model was told which product the customer replied to", () => {
          expect(r().systems[0]).toMatch(/WhatsApp reply to your picture of/);
        });
      }
      if (checks.has("list_markers_kept")) {
        it("'(1)' / '(2)' options the instructions ask for are not mistaken for references", () => {
          const all = textsOf(r()).join("\n");
          expect(all).toMatch(/^\(1\) Order online/m);
          expect(all).toMatch(/^\(2\) Our team/m);
        });
      }
    });
  }

  it("Batch 14.1: the live earrings call (gender 'female', in stock) finds the untagged earrings and sends them as captions", () => {
    const r = results.get("earrings-live-args")!;
    expect(r.sent.map((s) => s.type)).toEqual(["text", "text", "text", "text"]);
    expect(r.sent[1]!.text).toMatch(/Earrings — ₹[\d,]+\n https?:|Earrings — ₹[\d,]+\nhttps?:/);
    // The model's own live call (Batch 15C: the early search of the
    // customer's words is listed before it, as the call it was given).
    const tools = r.toolsMeta as Array<Record<string, unknown>>;
    const call = tools.find((t) => (t["args"] as Record<string, unknown>)["gender"] === "female");
    expect(tools[0]).toMatchObject({ tool: "catalog_search", args: { query: "earrings dikhao" } });
    expect(call).toMatchObject({
      tool: "catalog_search",
      ok: true,
      args: { gender: "female", category: "earrings" },
    });
    expect(call!["rows"]).toBeGreaterThan(0);
    expect((call!["found"] as string[]).length).toBeGreaterThan(0);
  });

  it("Batch 14.1: 'gents ring under 50k' shows only gents rings at or under ₹50,000", () => {
    const r = results.get("gents-ring-under-50k")!;
    const shown = r.sent.filter((s) => s.type === "image").map((s) => s.text.split(" — ")[0]);
    expect(shown.length).toBeGreaterThan(0);
    for (const title of shown) {
      const row = PRODUCTS.find(
        (p) => p["title"] === title && p["gender"] === "male" && Number(p["price"]) <= 50000,
      );
      expect(row, title).toBeDefined();
    }
  });

  it("Batch 14.1: a rings browse never pulls in earrings", () => {
    const text = textsOf(results.get("rings-dikhao")!).join("\n");
    expect(text).toMatch(/Gilded Chevron/);
    expect(text).not.toMatch(/ZERN|Earrings/);
  });

  it("the model is offered send_products and told nothing is attached for it", () => {
    const r = results.get("show-me-products")!;
    expect(r.toolsOffered).toContain("send_products");
    expect(r.systems[0]).toMatch(/nothing is attached for you/);
    expect(r.systems[0]).not.toMatch(/attached for you automatically|Cite the number/);
  });

  it("the sloppy captions were made true: paise rounded, wrong price and link replaced", () => {
    const pictures = results
      .get("caption-price-and-link-checked")!
      .sent.filter((s) => s.type === "image");
    const architect = PRODUCTS.find((p) => p["title"] === "The Architect")!;
    expect(pictures.map((p) => p.text)).toEqual([
      "The Gilded Chevron — ₹19,604\nhttps://myzoori.com/product-detail/a17c9b39-247c-451a-8063-09d9da502d9a",
      `The Architect — ₹26,446\n${String(architect["product_url"])}`,
    ]);
  });

  it("matches the recorded after.json (re-record with REPLAY_WRITE=after when a change is deliberate)", () => {
    const path = join(DIR, "after.json");
    if (!existsSync(path) || process.env["REPLAY_WRITE"]) return;
    const after = JSON.parse(readFileSync(path, "utf8")) as Record<string, Replay>;
    for (const c of CASES)
      expect({ id: c.id, sent: results.get(c.id)!.sent }).toEqual({
        id: c.id,
        sent: after[c.id]!.sent,
      });
  });
});
