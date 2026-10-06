import { describe, expect, it, vi } from "vitest";
import { memoryDb, type Row } from "./test-support/memory-db";
import { fakeDb } from "./test-support/fake-db";

/**
 * Batch 14.1 — "earrings dikhao" found no earrings (Zoori, 6 Oct 11:18, run
 * 4f97dcee…): gpt-5.4 sent catalog_search gender "female" + availability
 * "in_stock", and all 135 earrings have no gender tag. Also: what each tool
 * did is kept on the run and shown in /admin/aiden, and ZERN earrings whose
 * photos are named "zpnds-…" are no longer saved as pendants.
 * The live call is replayed end to end in batch14-replay.test.ts
 * ("earrings-live-args").
 */

vi.mock("@/lib/feature-flags.server", () => ({
  enabledFlags: async () => new Set(["ai_features", "catalogs"]),
}));

const ORG = "org-zoori";
const product = (id: string, r: Partial<Row>): Row => ({
  id,
  organization_id: ORG,
  is_visible: true,
  availability: "in_stock",
  currency: "INR",
  image_url: null,
  gender: null,
  updated_at: "2026-10-06T09:00:00Z",
  ...r,
});
const EARRINGS = [
  product("e1", {
    title: "Floral Cage Drops",
    sku: "ZERN-0040",
    category: "earrings",
    price: 76014.38,
  }),
  product("e2", {
    title: "Swirl Crest Dangles",
    sku: "ZERN-0035",
    category: "earrings",
    price: 20499.5,
  }),
];
const RINGS = [
  product("r1", {
    title: "Onyx Skyline",
    sku: "ZGRG-0002",
    category: "rings",
    gender: "male",
    price: 52274.99,
    image_url: "https://x/1.jpg",
  }),
  product("r2", {
    title: "The Gilded Chevron",
    sku: "ZLRG-0001",
    category: "rings",
    gender: "female",
    price: 19603.91,
    image_url: "https://x/2.jpg",
  }),
  product("r3", {
    title: "Tiered Vertex",
    sku: "ZGRG-0005",
    category: "rings",
    gender: null,
    price: 49196.55,
    image_url: "https://x/3.jpg",
  }),
];

async function search(args: Record<string, unknown>, opts: { brokered: boolean; rows?: Row[] }) {
  const { AI_TOOL_HANDLERS } = await import("./ai-tools.server");
  const db = memoryDb({ products: opts.rows ?? [...EARRINGS, ...RINGS] });
  return AI_TOOL_HANDLERS["catalogSearch"]!(
    {
      supabase: db.supabase,
      organizationId: ORG,
      actorUserId: null,
      initiatedBy: "ai",
      ...(opts.brokered ? { brokered: true } : {}),
    },
    args,
  );
}
const titles = (out: { data?: unknown }) =>
  (Array.isArray(out.data)
    ? (out.data as Row[])
    : ((out.data as { closest_above?: Row[] }).closest_above ?? [])
  ).map((r) => r["title"]);
const LIVE_ARGS = {
  limit: 3,
  query: "",
  gender: "female",
  category: "earrings",
  max_price: null,
  availability: "in_stock",
};

// ------------------------------------------------------------- (1) gender
describe("(1) a gender narrows to that gender plus untagged products — for Aiden", () => {
  it("the live call: untagged earrings are found (was 0)", async () => {
    const out = await search(LIVE_ARGS, { brokered: true });
    expect(out.found).toBe(true);
    expect(titles(out).sort()).toEqual(["Floral Cage Drops", "Swirl Crest Dangles"]);
  });

  it("a tagged product of the other gender is still never returned", async () => {
    expect(
      titles(await search({ category: "rings", gender: "male" }, { brokered: true })),
    ).not.toContain("The Gilded Chevron");
    expect(
      titles(await search({ category: "rings", gender: "male" }, { brokered: true })).sort(),
    ).toEqual(["Onyx Skyline", "Tiered Vertex"]);
  });

  it("a ring search never returns earrings ('%rings%' matched 'earrings')", async () => {
    expect(titles(await search({ category: "rings" }, { brokered: true })).sort()).toEqual([
      "Onyx Skyline",
      "The Gilded Chevron",
      "Tiered Vertex",
    ]);
    expect(titles(await search({ category: "earrings" }, { brokered: true })).sort()).toEqual([
      "Floral Cage Drops",
      "Swirl Crest Dangles",
    ]);
  });

  it("unchanged: the flows 'Show products' step (a direct handler call) keeps the strict match", async () => {
    const out = await search(LIVE_ARGS, { brokered: false });
    expect(out).toEqual({ ok: true, found: false, data: [] });
    expect(
      titles(await search({ category: "rings", gender: "male" }, { brokered: false })),
    ).toEqual(["Onyx Skyline"]);
  });

  it("closest match: when even that finds nothing for the gender, Aiden gets the closest of any gender, said as such", async () => {
    const onlyMen = [RINGS[0]!];
    const out = await search(
      { category: "rings", gender: "female", max_price: 20000 },
      { brokered: true, rows: onlyMen },
    );
    const data = out.data as { closest_above: Row[]; gender_note?: string };
    expect(data.closest_above.map((r) => r["title"])).toEqual(["Onyx Skyline"]);
    expect(data.gender_note).toMatch(/closest of any gender/);
    // Flows: unchanged.
    expect(
      await search(
        { category: "rings", gender: "female", max_price: 20000 },
        { brokered: false, rows: onlyMen },
      ),
    ).toEqual({
      ok: true,
      found: false,
      data: [],
    });
  });

  it("the closest match keeps the gender while it still finds something", async () => {
    const out = await search(
      { category: "rings", gender: "male", max_price: 20000 },
      { brokered: true },
    );
    const data = out.data as { closest_above: Row[]; gender_note?: string };
    expect(data.closest_above.map((r) => r["title"]).sort()).toEqual([
      "Onyx Skyline",
      "Tiered Vertex",
    ]);
    expect(data.gender_note).toBeUndefined();
  });

  it("invokeTool (every model or member call) is the brokered path, and its trace counts what came back", async () => {
    const { invokeTool } = await import("./ai-tools.server");
    const mem = memoryDb({ products: [...EARRINGS, ...RINGS] });
    const fake = fakeDb((op) => {
      if (op.table === "organization_ai_settings")
        return { data: { agent_role: "ai_agent", agent_can_write: false }, error: null };
      if (op.table === "role_permissions")
        return {
          data: [{ permission_key: "ai.use" }, { permission_key: "catalog.view" }],
          error: null,
        };
      if (op.table === "activity_log") return { data: { id: "log-1" }, error: null };
      return undefined;
    });
    const supabase = {
      from: (t: string) => (t === "products" ? mem.supabase.from(t) : fake.supabase.from(t)),
      rpc: fake.supabase.rpc,
    } as never;
    const out = await invokeTool(
      {
        supabase,
        organizationId: ORG,
        actorUserId: null,
        principal: { kind: "agent" },
        initiatedBy: "ai",
      },
      "catalog_search",
      LIVE_ARGS,
    );
    expect(out.ok).toBe(true);
    expect(out.resultSummary).toMatchObject({ ok: true, row_count: 2 });
  });
});

// ------------------------------------------------------- (3) the tool text
describe("(3) gender and availability only when the customer asks", () => {
  it("catalog_search says so, and the OpenAI schema no longer marks every filter required", async () => {
    const { allAiTools } = await import("./feature-registry");
    const { strictSchema } = await import("./ai-run.server");
    const tool = allAiTools().find((t) => t.name === "catalog_search")!;
    expect(tool.description).toMatch(
      /`gender` and `availability` ONLY when the customer explicitly asks/,
    );
    expect(String(tool.parameters.properties["gender"]!["description"])).toMatch(
      /only when the customer explicitly says so/,
    );
    expect(String(tool.parameters.properties["availability"]!["description"])).toMatch(
      /Only when the customer explicitly asks/,
    );
    expect(strictSchema(tool.parameters)["required"]).toEqual([]);
    const send = allAiTools().find((t) => t.name === "send_products")!;
    expect(strictSchema(send.parameters)["required"]).toEqual(["products"]);
  });
});

// ------------------------------------------------------- (2) visibility
describe("(2) every run says what its tools did (metadata.tools), shown in /admin/aiden", () => {
  it("the trace summary counts the rows inside a result (closest matches, queued products)", async () => {
    const { summarise } = await import("./ai-tools.server");
    expect(
      summarise({
        ok: true,
        found: false,
        data: { found: false, closest_above: [{ title: "A" }, { title: "B" }] },
      }),
    ).toEqual({
      ok: true,
      found: false,
      row_count: 2,
      identifiers: ["A", "B"],
    });
    expect(
      summarise({ ok: true, data: { queued: true, products: [{ title: "Chevron" }] } }),
    ).toMatchObject({ row_count: 1, identifiers: ["Chevron"] });
    // Unchanged for a plain list or a single record.
    expect(summarise({ ok: true, data: [{ title: "X" }] })).toMatchObject({
      row_count: 1,
      identifiers: ["X"],
    });
    expect(summarise({ ok: true, data: { order_number: "#12" } })).toMatchObject({
      row_count: 1,
      identifiers: ["#12"],
    });
  });

  it("metadata.tools is the same arguments and summary the ai_tool_calls rows carry", async () => {
    const { runToolsMeta } = await import("./ai-run.server");
    expect(
      runToolsMeta([
        {
          tool: "catalog_search",
          ok: true,
          args: LIVE_ARGS,
          resultSummary: { ok: true, found: false, row_count: 0, identifiers: [] },
        },
        {
          tool: "send_products",
          ok: false,
          error: "None of those product_id values…",
          args: { products: [] },
          resultSummary: { ok: false, row_count: 0, identifiers: [] },
        },
      ]),
    ).toEqual([
      {
        tool: "catalog_search",
        args: LIVE_ARGS,
        ok: true,
        rows: 0,
        found: [],
        nothing_found: true,
      },
      {
        tool: "send_products",
        args: { products: [] },
        ok: false,
        rows: 0,
        found: [],
        error: "None of those product_id values…",
      },
    ]);
  });

  it("the run view reads metadata.tools, else the ai_tool_calls rows of an older run (the live earrings run)", async () => {
    const { runView, argsLine } = await import("./ai-run-view");
    const older = runView(
      {
        id: "4f97dcee",
        created_at: "2026-10-06T11:18:38Z",
        input_summary: "earrings dikhao",
        output: "I’m not seeing earrings…",
        status: "ok",
        metadata: { provider: "lovable" },
      },
      [
        {
          tool_name: "catalog_search",
          ok: true,
          error: null,
          arguments: LIVE_ARGS,
          result_summary: { ok: true, found: false, row_count: 0, identifiers: [] },
        },
      ],
    );
    expect(older.tools).toEqual([
      {
        tool: "catalog_search",
        args: LIVE_ARGS,
        ok: true,
        rows: 0,
        found: [],
        nothing_found: true,
      },
    ]);
    expect(argsLine(older.tools[0]!.args)).toBe(
      "limit: 3 · gender: female · category: earrings · availability: in_stock",
    );
    const newer = runView(
      {
        id: "r2",
        metadata: {
          tools: [
            {
              tool: "catalog_search",
              args: { category: "earrings" },
              ok: true,
              rows: 2,
              found: ["A", "B"],
            },
          ],
        },
      },
      [{ tool_name: "ignored", ok: true }],
    );
    expect(newer.tools).toEqual([
      {
        tool: "catalog_search",
        args: { category: "earrings" },
        ok: true,
        rows: 2,
        found: ["A", "B"],
      },
    ]);
  });
});

// ------------------------------------------------- website reader fixes
const zernPage = (image: string) => `<!doctype html><html><head>
<title>Floral Cage Drops || ZERN-0040</title>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","name":"Floral Cage Drops","image":["${image}"],"description":"","sku":"ZERN-0040","brand":{"@type":"Brand","name":"MyZoori"},"offers":{"@type":"Offer","price":"76014.38","priceCurrency":"INR"}}]}</script>
</head><body><nav class="breadcrumb-block"><a href="/">Home</a> / Floral Cage Drops</nav><h1>Floral Cage Drops</h1>
<img src="${image}" alt="Floral Cage Drops"><p>Metal: Gold, Diamond</p><p>Gross weight: 3.87 gm</p>
<p>${"Handcrafted in 18K gold with natural diamonds. ".repeat(4)}</p></body></html>`;

describe("ZERN earrings whose photo is named 'zpnds-…' are earrings", () => {
  it("the product's own SKU outranks its photo's filename (myzoori.com: 24 such products)", async () => {
    const { extractProduct } = await import("./product-extract.server");
    const url = "https://www.myzoori.com/product-detail/a2d2a18b-597e-4c7a-ae6d-82ed5f8a1d89";
    const live =
      "https://www.myzoori.com/storage/images/products/a2d2a18b-597e-4c7a-ae6d-82ed5f8a1d89/zpnds-0040e2804-1790255812.jpg";
    expect(extractProduct(zernPage(live), url)?.category).toBe("earrings");
    // Unchanged: no SKU on the page → the photo's code still decides.
    const noSku = zernPage(live)
      .replace(/"sku":"ZERN-0040",/, "")
      .replace(" || ZERN-0040", "");
    expect(extractProduct(noSku, url)?.category).toBe("pendants");
  });

  it("a re-read that sees no gender keeps the one already set (Zoori's hand-set ZGRG/ZLRG genders)", async () => {
    const { saveCrawledProducts } = await import("./product-extract.server");
    const db = memoryDb({
      products: [
        {
          id: "p1",
          organization_id: ORG,
          external_id: "https://z/p/1",
          source: "crawl",
          gender: "male",
          category: "rings",
          image_url: null,
        },
      ],
    });
    const draft = {
      externalId: "https://z/p/1",
      title: "Tiered Vertex",
      price: 49196.55,
      currency: "INR",
      imageUrl: null,
      productUrl: "https://z/p/1",
      category: null,
      gender: null,
      availability: "in_stock" as const,
      sku: "ZGRG-0005",
      brand: null,
    };
    await saveCrawledProducts(db.supabase, ORG, [draft]);
    expect(db.rows("products")[0]).toMatchObject({
      gender: "male",
      category: "rings",
      price: 49196.55,
    });
    // A read that does see a gender still writes it.
    await saveCrawledProducts(db.supabase, ORG, [{ ...draft, gender: "women" }]);
    expect(db.rows("products")[0]!["gender"]).toBe("women");
  });
});
