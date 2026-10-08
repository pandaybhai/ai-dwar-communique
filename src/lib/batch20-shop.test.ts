import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { memoryDb } from "./test-support/memory-db";
import { APPAREL, APPAREL_CASES, APPAREL_ORG, APPAREL_PRODUCTS, APPAREL_WORDS } from "./test-support/apparel-shop";
import { CATEGORY_WORDS, READER_RULES, zooriWorld, type Case, type Replay } from "./test-support/zoori-replay";

/**
 * Batch 20 — no industry presets in shared code. A shop that sells nothing
 * like jewellery (Northwind Apparel, made up: T-Shirts, Jeans, Sneakers,
 * jackets, priced in US dollars, with its own words "tees" and "trainers")
 * goes through the same answer path, product search, flows step, guards and
 * website reader as Zoori — and the shared source is checked for the old
 * jewellery word lists so they cannot come back.
 */

vi.mock("@/lib/feature-flags.server", () => ({
  enabledFlags: async () => new Set(["ai_features", "catalog", "catalogs", "flows_v2"]),
}));

// As in the Zoori replay: the catalogue tools run for real; only the
// permission broker around them is stubbed.
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
    invokeTool: async (ctx: Parameters<typeof real.invokeTool>[0], name: string, args: Record<string, unknown>) => {
      const tool = offered().find((t) => t.name === name)!;
      const out = await real.AI_TOOL_HANDLERS[tool.handler]!({ ...ctx, brokered: true }, args);
      return { ...out, latencyMs: 1, activityLogId: null, arguments: args, resultSummary: real.summarise(out) };
    },
  };
});

const NOW = new Date("2026-10-06T10:20:00Z");
const results = new Map<string, Replay>();
const toolResults = new Map<string, string[]>();

async function replay(c: Case): Promise<Replay> {
  const world = zooriWorld(c, APPAREL);
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    if (/chat\/completions/.test(String(url))) {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> };
      for (const m of parsed.messages) if (m.role === "tool") seen.push(String(m.content));
    }
    return world.fetchStub(url, init);
  });
  const { runAgentOnInbound } = await import("./ai-agent.server");
  await runAgentOnInbound(world.supabase, world.args as Parameters<typeof runAgentOnInbound>[1]);
  vi.unstubAllGlobals();
  toolResults.set(c.id, seen);
  return world.result();
}

beforeAll(async () => {
  process.env["LOVABLE_API_KEY"] = "test-key";
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const c of APPAREL_CASES) results.set(c.id, await replay(c));
});
afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

const pictures = (r: Replay) => r.sent.filter((s) => s.type === "image");
const byId = (id: string) => APPAREL_PRODUCTS.find((p) => p["id"] === id)!;

describe("an apparel shop through Aiden's answer path (the replay world)", () => {
  it("'show me your tees': the shop's own word finds its T-Shirts, in dollars, with links", () => {
    const r = results.get("tees")!;
    const shown = pictures(r).map((s) => s.text.split(" — ")[0]);
    expect(shown.sort()).toEqual(["Everyday Crew Tee", "Organic Cotton T-Shirt", "Striped Boat Neck Tee"]);
    for (const p of pictures(r)) expect(p.text).toMatch(/ — \$\d+\nhttps:\/\/shop\.example\.com\/p\/ap-tee-\d/);
    expect(r.sent.map((s) => s.text).join(" ")).not.toMatch(/₹/);
  });

  it("'trainers under 100': its Sneakers at or under $100 only", () => {
    const r = results.get("trainers-under-100")!;
    expect(pictures(r).map((s) => s.text)).toEqual([`Court Classic Sneakers — $95\n${String(byId("ap-snk-1")["product_url"])}`]);
  });

  it("'jackets for him': the men's jackets shelf (its name already says the gender)", () => {
    const r = results.get("jackets-for-him")!;
    expect(pictures(r).map((s) => s.text.split(" — ")[0])).toEqual(["Quilted Field Jacket"]);
  });

  it("'do you sell necklaces?': not one of its categories — nothing else is sent in its place", () => {
    const r = results.get("necklaces")!;
    expect(pictures(r)).toEqual([]);
    expect(r.sent.map((s) => s.text).join("\n")).toMatch(/We don't sell necklaces/);
    const tool = toolResults.get("necklaces")!.find((t) => t.includes("not_a_category_here"))!;
    expect(tool).toBeDefined();
    for (const name of ["T-Shirts", "Jeans", "Sneakers", "Men's Jackets"]) expect(tool).toContain(name);
  });

  it("'jeans under 20': the closest above in dollars; the unsearched sneakers offer is removed", () => {
    const r = results.get("jeans-under-20")!;
    const text = r.sent.map((s) => s.text).join("\n");
    expect(text).toMatch(/Our jeans start at \$79\./);
    expect(text).not.toMatch(/sneakers/i);
    // What the model was told: the closest jeans and where they start, in dollars.
    const tool = toolResults.get("jeans-under-20")!.join("\n");
    expect(tool).toMatch(/"lowest_price":"\$79"/);
    expect(tool).not.toMatch(/₹/);
  });
});

describe("product search at the apparel shop (catalogSearch, Aiden and flows)", () => {
  const ctx = (brokered: boolean) => {
    const db = memoryDb({ products: APPAREL_PRODUCTS, organizations: [APPAREL.orgRow] });
    return { db, ctx: { supabase: db.supabase, organizationId: APPAREL_ORG, actorUserId: null, initiatedBy: "ai" as const, brokered } };
  };
  const titles = (out: { data?: unknown }) =>
    (Array.isArray(out.data) ? (out.data as Array<Record<string, unknown>>) : []).map((r) => r["title"]).sort();

  it("a category is the shop's own (any case, singular or plural), or one of its own words", async () => {
    const { AI_TOOL_HANDLERS } = await import("./ai-tools.server");
    for (const brokered of [true, false]) {
      const { ctx: c } = ctx(brokered);
      expect(titles(await AI_TOOL_HANDLERS["catalogSearch"]!(c, { category: "jeans" }))).toEqual(["Straight Leg Jeans", "Wide Leg Jeans"]);
      expect(titles(await AI_TOOL_HANDLERS["catalogSearch"]!(c, { category: "T-shirt" }))).toHaveLength(3);
      expect(titles(await AI_TOOL_HANDLERS["catalogSearch"]!(c, { category: "kicks" }))).toEqual(["Court Classic Sneakers", "Trail Runner"]);
      // "jackets" covers both jacket shelves.
      expect(titles(await AI_TOOL_HANDLERS["catalogSearch"]!(c, { category: "jackets" }))).toEqual(["Quilted Field Jacket", "Rain Shell"]);
    }
  });

  it("jewellery words mean nothing special here: 'ring' is not a shelf and nothing is swapped in", async () => {
    const { AI_TOOL_HANDLERS } = await import("./ai-tools.server");
    const { ctx: c } = ctx(true);
    const out = await AI_TOOL_HANDLERS["catalogSearch"]!(c, { category: "rings", max_price: 100 });
    expect(out).toMatchObject({ ok: true, found: false, data: { not_a_category_here: true } });
    // Words that aren't a category are searched for by name ("Ring Light Tote").
    expect(titles(await AI_TOOL_HANDLERS["catalogSearch"]!(c, { category: "ring light" }))).toEqual(["Ring Light Tote"]);
  });

  it("flows 'Show products': its shelf in dollars; an unknown category takes the None match path", async () => {
    const { showProducts } = await import("./flow-products.server");
    const run = async (category: string, maxPrice: number | null) => {
      const sent: Array<Record<string, unknown>> = [];
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        if (String(url).includes("graph.facebook.com")) sent.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(JSON.stringify({ messages: [{ id: `w${sent.length}` }] }));
      });
      const { db } = ctx(false);
      const result = await showProducts(db.supabase, {
        organizationId: APPAREL_ORG,
        contactId: "c1",
        conversationId: "cv1",
        to: "919800000099",
        phoneNumberId: "pn",
        accessToken: "tok",
        windowOpen: true,
        metadata: { kind: "flow_v2", run_id: "r", node_id: "n" },
        query: { category, minPrice: null, maxPrice, limit: 3 },
      });
      vi.unstubAllGlobals();
      return { result, sent };
    };
    const jeans = await run("Jeans", 80);
    expect(jeans.result).toMatchObject({ found: true, shown: 1 });
    expect((jeans.sent[0]!["image"] as { caption: string }).caption).toBe("Straight Leg Jeans — $79\nhttps://shop.example.com/p/ap-jeans-1");
    const cheap = await run("Sneakers", 50);
    expect((cheap.sent[0]!["text"] as { body: string }).body).toBe(
      "We don't have sneakers under $50 right now — our sneakers start at $95. Here are the closest ones:",
    );
    const unknown = await run("Necklaces", 100);
    expect(unknown).toEqual({ result: { ok: true, found: false, shown: 0, error: null }, sent: [] });
  });
});

describe("facts, names, captions and guards for any business", () => {
  it("the model sees the shop's own labelled details and prices in its currency", async () => {
    const { productFacts, readableName, checkCaption } = await import("./product-facts");
    const tee = byId("ap-tee-3");
    expect(productFacts(tee)).toMatchObject({
      title: "AT-0207",
      name: "Organic Cotton T-Shirt",
      details: { Material: "Organic cotton", Fit: "Slim" },
      price: "$19",
    });
    expect(readableName({ category: "Phone Cases", description: "Material: Silicone. Colour: Black." })).toBe("Silicone Phone Case");
    // A wrong dollar price in a caption is made the product's own.
    expect(checkCaption("Everyday Crew Tee — $30", byId("ap-tee-1")).caption).toBe("Everyday Crew Tee — $24");
  });

  it("the search tool lists this shop's categories when a run starts; the registry names no kind of product", async () => {
    const { withShopCategories } = await import("./ai-run.server");
    const { allAiTools } = await import("./feature-registry");
    const tool = allAiTools().find((t) => t.name === "catalog_search")!;
    expect(JSON.stringify(tool)).not.toMatch(/\brings?\b|pendant|earring|tanmaniya|mangalsutra|necklace|\bINR\b/i);
    const [offered] = withShopCategories([{ ...tool, feature: "catalog" }], {
      categories: [{ name: "T-Shirts", products: 3 }, { name: "Jeans", products: 2 }],
      words: APPAREL_WORDS,
      complete: true,
    });
    expect(offered!.description).toMatch(/This shop's categories: T-Shirts, Jeans\.$/);
    expect(String(offered!.parameters.properties["category"]!["description"])).toMatch(/T-Shirts, Jeans/);
  });

  it("the 'only offer what search found' guard uses the shop's own categories", async () => {
    const { unsearchedShelfOffers } = await import("./ai-run.server");
    const shop = { categories: [{ name: "Jeans", products: 2 }, { name: "Sneakers", products: 2 }], words: APPAREL_WORDS, complete: true };
    expect(unsearchedShelfOffers("Our jeans start at $79. Want to see trainers instead?", "jeans under 20", [], shop)).toEqual([
      "Want to see trainers instead?",
    ]);
    // A jeweller's word is just a word here.
    expect(unsearchedShelfOffers("Our jeans start at $79. Want pendants instead?", "jeans", [], shop)).toEqual([]);
  });
});

describe("the website reader keeps a shop's own category", () => {
  const page = (category: string, extra = "") => `<html><head><title>Ring Light 10 inch</title>
<script type="application/ld+json">${JSON.stringify({
    "@type": "Product",
    name: "Ring Light 10 inch",
    category,
    sku: "RL-10",
    image: "https://gadgets.example.com/rl10.jpg",
    offers: { "@type": "Offer", price: "39.99", priceCurrency: "USD" },
  })}</script></head><body><h1>Ring Light 10 inch</h1><p>Battery: 4000 mAh</p><p>Colour: Black</p><p>Call us: +1 555 010 0199</p>${extra}${"<p>A light for calls and photos.</p>".repeat(5)}</body></html>`;

  it("'Lighting' stays 'lighting' (never 'rings'); labelled lines are read whatever the labels", async () => {
    const { extractProduct } = await import("./product-extract.server");
    const draft = extractProduct(page("Lighting"), "https://gadgets.example.com/p/rl-10")!;
    expect(draft.category).toBe("lighting");
    expect(draft.currency).toBe("USD");
    expect(draft.description).toBe("Battery: 4000 mAh. Colour: Black");
  });

  it("'Bangles' stays 'bangles' and no code is read as a shelf without the source's own rules", async () => {
    const { extractProduct } = await import("./product-extract.server");
    expect(extractProduct(page("Bangles"), "https://shop.example.com/p/1")!.category).toBe("bangles");
    expect(extractProduct(page(""), "https://shop.example.com/p/2")!.category).toBeNull();
    // With a source rule, the source decides.
    expect(extractProduct(page(""), "https://shop.example.com/p/3", { categoryRules: [{ match: "RL*", category: "lights" }] })!.category).toBe("lights");
  });
});

describe("no industry presets in shared code", () => {
  /** Shared source files: everything under src except tests and test fixtures. */
  function sharedFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "test-support" ? [] : sharedFiles(path);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.check\.ts$/.test(name) ? [path] : [];
    });
  }
  /** The code without its comments (comments may tell Zoori's story; code may not act on it). */
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

  it("no jewellery word list, item code or shelf mapping in any shared file", () => {
    const banned =
      /tanmaniya|mangal\s?sutra|jhumk|anguthi|\bZ(?:LRG|GRG|ERN|ERG|PND|TNM|BSL|NCK|NEK)\b|earrings?\b|pendants?\b|necklaces?\b|bangles?\b|\bkadas?\b|\bhaar\b/i;
    const hits = sharedFiles(join(__dirname, "..")).flatMap((file) =>
      code(readFileSync(file, "utf8"))
        .split("\n")
        .filter((line) => banned.test(line))
        .map((line) => `${file.replace(/^.*\/src\//, "src/")}: ${line.trim().slice(0, 120)}`),
    );
    expect(hits).toEqual([]);
  });

  it("Zoori's words and reader rules live in its own data (the migration matches the replay fixture)", () => {
    const sql = readFileSync(join(__dirname, "..", "..", "supabase", "aidwar-migrations", "20261052_zoori_category_words.sql"), "utf8");
    const json = (key: string) => JSON.parse(sql.match(new RegExp(`'${key}', '([^']+)'::jsonb`))![1]!) as unknown;
    expect(json("category_words")).toEqual(CATEGORY_WORDS);
    expect(json("category_rules")).toEqual(READER_RULES);
    expect(sql).toMatch(/NOT \(coalesce\(branding, '\{\}'::jsonb\) \? 'category_words'\)/);
    expect(sql).toMatch(/NOT \(coalesce\(config, '\{\}'::jsonb\) \? 'category_rules'\)/);
  });
});

describe("pg_cron jobs in the repo (20261053, as live on 7 Oct)", () => {
  const sql = readFileSync(join(__dirname, "..", "..", "supabase", "aidwar-migrations", "20261053_cron_jobs.sql"), "utf8");
  /** Each scheduled job: name, schedule, the command text. */
  const jobs = [...sql.matchAll(/cron\.schedule\(\s*'([^']+)',\s*'([^']+)',\s*\$cmd\$([\s\S]*?)\$cmd\$/g)].map((m) => ({
    name: m[1]!,
    schedule: m[2]!,
    command: m[3]!,
  }));
  const LIVE: Array<[string, string, string, number | null]> = [
    ["aidwar-billing-monthly", "0 19 * * *", "billing-monthly", 120000],
    ["aidwar-billing-notify", "*/5 * * * *", "billing-notify", 30000],
    ["aidwar-billing-sweep", "*/30 * * * *", "billing-sweep", 60000],
    ["aidwar-campaign-worker", "* * * * *", "campaign-worker", null],
    ["aidwar-flow-scan", "0 4 * * *", "flow-scan", null],
    ["aidwar-flow-worker", "* * * * *", "flow-worker", null],
    ["aidwar-knowledge-backfill", "0 21 * * *", "knowledge-backfill", 60000],
    ["aidwar-knowledge-refresh", "20 */6 * * *", "knowledge-refresh", 60000],
    ["aidwar-knowledge-worker", "* * * * *", "knowledge-worker", 120000],
    ["aidwar-reprocess-events", "*/5 * * * *", "reprocess-events", null],
    ["aidwar-shopify-sync", "* * * * *", "shopify-sync-worker", null],
  ];

  it("the 13 live jobs: names, schedules, paths and timeouts as live (unset where live has none)", () => {
    expect(jobs).toHaveLength(13);
    for (const [name, schedule, path, timeout] of LIVE) {
      const job = jobs.find((j) => j.name === name)!;
      expect(job, name).toBeDefined();
      expect(job.schedule).toBe(schedule);
      expect(job.command).toContain(`url := 'https://aidwar.in/api/internal/${path}'`);
      expect(job.command).toContain("body := '{}'::jsonb");
      if (timeout === null) expect(job.command).not.toMatch(/timeout_milliseconds/);
      else expect(job.command).toContain(`timeout_milliseconds := ${timeout}`);
      // Idempotent: unscheduled by name first.
      expect(sql).toContain(`SELECT cron.unschedule('${name}') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = '${name}');`);
    }
    expect(jobs.find((j) => j.name === "aidwar-reprice-sweep")).toEqual({
      name: "aidwar-reprice-sweep",
      schedule: "*/10 * * * *",
      command: "select public.reprice_unpriced_messages();",
    });
    expect(jobs.find((j) => j.name === "aidwar-retention-purge")).toEqual({
      name: "aidwar-retention-purge",
      schedule: "0 2 * * *",
      command: "SELECT public.retention_purge();",
    });
  });

  it("only knowledge-refresh is paused", () => {
    const paused = [...sql.matchAll(/jobname = '([^']+)'\), active := false\)/g)].map((m) => m[1]);
    expect(paused).toEqual(["aidwar-knowledge-refresh"]);
  });

  it("the secret only ever comes from the Vault, never a literal", () => {
    expect(sql).not.toMatch(/"x-cron-secret"\s*:|'x-cron-secret',\s*'[^']/);
    expect(sql.match(/where name = 'aidwar_cron_secret'/g)).toHaveLength(11);
    expect(sql).not.toMatch(/RAISE EXCEPTION/);
  });
});

describe("the live-only functions in the repo (20261054, 20261055)", () => {
  const dir = join(__dirname, "..", "..", "supabase", "aidwar-migrations");
  const live = readFileSync(join(dir, "20261054_live_only_functions.sql"), "utf8");
  const revoke = readFileSync(join(dir, "20261055_revoke_billing_reads.sql"), "utf8");
  const grantsOf = (name: string) =>
    [...live.matchAll(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) TO ([^;]+);`, "g"))].map((m) => m[1]);

  it("all seven are defined, with the live grants", () => {
    for (const name of ["ai_answers_allowance", "client_rate_for", "firecrawl_try_spend", "meta_balance_estimate", "next_invoice_number", "wallet_apply", "reprice_unpriced_messages"])
      expect(live).toContain(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(grantsOf("reprice_unpriced_messages")).toEqual(["service_role"]);
    expect(grantsOf("ai_answers_allowance")).toEqual(["authenticated, service_role"]);
    expect(grantsOf("client_rate_for")).toEqual(["authenticated, service_role"]);
    for (const name of ["firecrawl_try_spend", "meta_balance_estimate", "next_invoice_number", "wallet_apply"])
      expect(grantsOf(name)).toEqual(["service_role"]);
    // The code's own expectations of them.
    expect(live).toMatch(/wallet_apply\(p_org uuid, p_type text, p_amount numeric, p_ref_type text DEFAULT NULL::text, p_ref_id uuid DEFAULT NULL::uuid, p_description text DEFAULT NULL::text, p_metadata jsonb DEFAULT '\{\}'::jsonb, p_actor uuid DEFAULT NULL::uuid\)/);
    expect(live).toContain("raise exception 'INSUFFICIENT_CREDITS");
    expect(live).toMatch(/firecrawl_try_spend\(_org uuid, _credits integer\)\n RETURNS boolean/);
  });

  it("the browser revoke is its own migration, and no browser code calls those two", () => {
    expect(revoke).toContain("REVOKE ALL ON FUNCTION public.ai_answers_allowance(uuid) FROM PUBLIC, anon, authenticated;");
    expect(revoke).toContain(
      "REVOKE ALL ON FUNCTION public.client_rate_for(uuid, text, text, timestamp with time zone) FROM PUBLIC, anon, authenticated;",
    );
    function files(dir: string): string[] {
      return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) && !name.includes(".test.") ? [path] : [];
      });
    }
    const src = join(__dirname, "..");
    const browser = [...files(join(src, "components")), ...files(join(src, "routes", "app")), ...files(join(src, "hooks")), ...files(join(src, "integrations"))];
    for (const file of browser) expect(readFileSync(file, "utf8"), file).not.toMatch(/client_rate_for|ai_answers_allowance/);
  });
});
