import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp, type FakeRpc } from "./test-support/fake-db";

/**
 * Batch 11B:
 *  (1) AI backup uses the Anthropic / OpenAI keys stored under Platform
 *      providers (Vault, same lookup as the platform providers), else the env
 *      keys; the Anthropic backup model is chosen on the card (default
 *      Sonnet), ANTHROPIC_BACKUP_MODEL still overrides; Test backup uses them.
 *  (2) "Refresh from website" fills crawled products' missing photo /
 *      description / category from their own pages — even when the page is
 *      unchanged — never overwriting a value and never re-embedding.
 *  (3) WhatsApp shop: hidden products never pushed and removed from Meta;
 *      after a sync Meta is asked whether customers can see the shop, and
 *      the answer is stored; the batch status is read where Meta puts it.
 *  (4) Products toolbar wraps on a phone.
 */

const h = vi.hoisted(() => ({
  db: null as null | { supabase: unknown },
  superAdmin: true,
}));
vi.mock("@/lib/whatsapp-webhook.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp-webhook.server")>()),
  getServiceClient: () => h.db!.supabase,
}));
vi.mock("@/lib/permissions.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/permissions.server")>()),
  hasPermission: async () => true,
}));
vi.mock("@/lib/whatsapp-api.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp-api.server")>()),
  isSuperAdmin: async () => h.superAdmin,
}));

import {
  DEFAULT_ANTHROPIC_BACKUP_MODEL,
  backupRoutes,
  backupStatus,
  loadPlatformBackup,
  resetPlatformBackupCache,
  resetProviderAlertThrottle,
  testBackupProviders,
} from "./ai-fallback.server";
import { embedTexts, executeRun } from "./ai-run.server";
import { fillMissingProductDetails } from "./product-extract.server";
import { syncSource } from "./knowledge.server";
import { batchStatusNode, checkShopVisibility, syncCatalog } from "./whatsapp-catalog.server";
import { shopVisibilityState } from "./catalog";
import { Route as AdminAiRoute } from "../routes/api/admin/ai";
import { Route as CatalogRoute } from "../routes/api/whatsapp/catalog";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const ENV_KEYS = [
  "LOVABLE_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_BACKUP_MODEL",
  "OPENAI_BACKUP_MODEL",
  "AI_BACKUP_ORDER",
  "META_CATALOG_PLATFORM_TOKEN",
];
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  h.superAdmin = true;
  resetPlatformBackupCache();
  resetProviderAlertThrottle();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
});

/** The live layout: both platform providers active with a vault name; the vault answers by name. */
const VAULT: Record<string, string> = {
  platform_anthropic_key: "vault-ant-key-SECRET",
  platform_openai_key: "vault-oa-key-SECRET",
};
type PlatformOpts = { anthropicActive?: boolean; chosen?: string | null; settingsError?: boolean; noRows?: boolean };
function platformReply(op: FakeOp, opts: PlatformOpts = {}) {
  if (op.table === "platform_ai_providers" && op.kind === "select") {
    if (opts.noRows) return { data: [], error: null };
    return {
      data: [
        { provider: "anthropic", vault_secret_name: "platform_anthropic_key", is_active: opts.anthropicActive ?? true },
        { provider: "openai", vault_secret_name: "platform_openai_key", is_active: true },
      ],
      error: null,
    };
  }
  if (op.table === "platform_settings" && op.kind === "select" && String(op.select?.[0] ?? "").includes("ai_backup_anthropic_model")) {
    if (opts.settingsError) return { data: null, error: { message: "timeout" } };
    return { data: { ai_backup_anthropic_model: opts.chosen ?? null }, error: null };
  }
  return undefined;
}
const vaultRpc = (call: FakeRpc) =>
  call.name === "read_vault_secret" ? { data: VAULT[String(call.args["p_name"])] ?? null, error: null } : undefined;

// ------------------------------------------------------------------ (1)
describe("(1) AI backup: Platform providers keys and the model choice", () => {
  it("routes: vault key wins, env key is the fallback, Sonnet by default, card choice, env model overrides", () => {
    expect(DEFAULT_ANTHROPIC_BACKUP_MODEL).toBe("claude-sonnet-5-5");
    const vault = { anthropicKey: "va", openaiKey: "vo", anthropicModel: null };
    expect(backupRoutes("everyday", {}, vault).map((r) => `${r.provider}:${r.model}:${r.key}`)).toEqual([
      "anthropic:claude-sonnet-5-5:va",
      "openai:gpt-5.4-mini:vo",
    ]);
    // Vault over env.
    expect(backupRoutes("everyday", { ANTHROPIC_API_KEY: "ea" }, vault)[0]!.key).toBe("va");
    // No vault key: the env key, exactly as before.
    expect(backupRoutes("everyday", { ANTHROPIC_API_KEY: "ea" })).toEqual([
      { provider: "anthropic", key: "ea", model: "claude-sonnet-5-5" },
    ]);
    // The card's choice, and ANTHROPIC_BACKUP_MODEL over it.
    const chosen = { ...vault, anthropicModel: "claude-haiku-4-5" };
    expect(backupRoutes("everyday", {}, chosen)[0]!.model).toBe("claude-haiku-4-5");
    expect(backupRoutes("everyday", { ANTHROPIC_BACKUP_MODEL: "claude-opus-5-5" }, chosen)[0]!.model).toBe("claude-opus-5-5");
    // Nothing anywhere: no backup.
    expect(backupRoutes("everyday", {})).toEqual([]);
  });

  it("loadPlatformBackup reads platform_ai_providers + read_vault_secret by name; an inactive provider has no key", async () => {
    const db = fakeDb((op) => platformReply(op, { anthropicActive: false, chosen: "claude-opus-5-5" }), vaultRpc);
    const platform = await loadPlatformBackup(db.supabase);
    expect(platform).toEqual({ anthropicKey: null, openaiKey: "vault-oa-key-SECRET", anthropicModel: "claude-opus-5-5" });
    expect(db.rpcs.map((r) => r.args["p_name"])).toEqual(["platform_openai_key"]);
    // Cached: a second read within the minute makes no query.
    const before = db.ops.length;
    await loadPlatformBackup(db.supabase);
    expect(db.ops.length).toBe(before);
  });

  it("a failed settings read: the default model applies and keys still load; an unknown saved model is ignored", async () => {
    const db = fakeDb((op) => platformReply(op, { settingsError: true }), vaultRpc);
    expect(await loadPlatformBackup(db.supabase, { fresh: true })).toEqual({
      anthropicKey: "vault-ant-key-SECRET",
      openaiKey: "vault-oa-key-SECRET",
      anthropicModel: null,
    });
    const odd = fakeDb((op) => platformReply(op, { chosen: "gpt-oops" }), vaultRpc);
    expect((await loadPlatformBackup(odd.supabase, { fresh: true })).anthropicModel).toBeNull();
  });

  it("status: configured yes with vault keys only, says where the key comes from, never shows a key", () => {
    const s = backupStatus({}, { anthropicKey: "vault-ant-key-SECRET", openaiKey: "vault-oa-key-SECRET", anthropicModel: null });
    expect(s.anthropic).toMatchObject({ configured: true, key_source: "vault", model: "claude-sonnet-5-5", chosen_model: null, env_override: false });
    expect(s.anthropic.models.map((m) => m.id)).toEqual(["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5"]);
    expect(s.openai).toMatchObject({ configured: true, key_source: "vault" });
    expect(JSON.stringify(s)).not.toContain("SECRET");
    const env = backupStatus({ ANTHROPIC_API_KEY: "env-SECRET", ANTHROPIC_BACKUP_MODEL: "claude-opus-5-5" }, { anthropicKey: null, openaiKey: null, anthropicModel: "claude-haiku-4-5" });
    expect(env.anthropic).toMatchObject({ configured: true, key_source: "env", model: "claude-opus-5-5", env_override: true });
    expect(env.openai.configured).toBe(false);
  });

  it("Test backup calls each provider with the vault key and the chosen model", async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers: Record<string, string> = {};
      new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => (headers[k] = v));
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      seen.push({ url, headers, body });
      if (url.includes("anthropic.com"))
        return json({ id: "m", type: "message", role: "assistant", model: body["model"], content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
      return json({ output: [] });
    });
    const results = await testBackupProviders({}, { anthropicKey: "vault-ant", openaiKey: "vault-oa", anthropicModel: null });
    expect(results.map((r) => `${r.provider}:${r.model}:${r.ok}`)).toEqual([
      "anthropic:claude-sonnet-5-5:true",
      "openai:gpt-5.4-mini:true",
      "openai:gpt-5.4:true",
    ]);
    expect(seen.find((s) => s.url.includes("anthropic.com"))!.headers["x-api-key"]).toBe("vault-ant");
    expect(seen.filter((s) => s.url.includes("openai.com")).every((s) => s.headers["authorization"] === "Bearer vault-oa")).toBe(true);
  });

  describe("a real run", () => {
    function aiWorld(opts: PlatformOpts = {}) {
      return fakeDb(
        (op) => {
          const p = platformReply(op, opts);
          if (p) return p;
          if (op.table === "organization_ai_settings")
            return { data: { ai_enabled: true, ai_monthly_cap_amount: 1000, currency: "INR", ai_markup_multiplier: 3 }, error: null };
          if (op.table === "platform_settings")
            return { data: { ai_monthly_cap_amount: 100000, ai_cap_currency: "INR", ai_markup_multiplier: 3 }, error: null };
          if (op.table === "ai_tiers")
            return { data: { key: "everyday", display_name: "Everyday", provider: "lovable", model_id: "google/gemini-3.6-flash", is_active: true }, error: null };
          if (op.table === "ai_models") return { data: { supports_tools: true, is_available: true, is_deprecated: false }, error: null };
          if (op.table === "ai_runs" && op.kind === "insert") return { data: { id: "run-1" }, error: null };
          if (op.table === "activity_log" && op.kind === "select") return { data: [], error: null };
          return undefined;
        },
        (call) => {
          if (call.name === "ai_month_spend" || call.name === "platform_ai_month_spend") return { data: 0, error: null };
          return vaultRpc(call);
        },
      );
    }
    const run = (db: ReturnType<typeof aiWorld>) =>
      executeRun(db.supabase, {
        organizationId: "org",
        task: "agent_reply",
        tier: "everyday",
        conversationId: "conv-1",
        contactId: "c1",
        input: "Is the Petal Band gold?",
        system: "You answer on behalf of this business.",
        useKnowledge: false,
      });
    function stub(gateway: () => Response) {
      const seen: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const raw = init?.body ?? (input instanceof Request ? await input.text() : "{}");
        const body = typeof raw === "string" && raw.startsWith("{") ? (JSON.parse(raw) as Record<string, unknown>) : {};
        const headers: Record<string, string> = {};
        new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => (headers[k] = v));
        seen.push({ url, headers, body });
        if (url.includes("ai.gateway.lovable.dev")) return gateway();
        if (url.includes("api.anthropic.com"))
          return json({ id: "msg_1", type: "message", role: "assistant", model: body["model"], content: [{ type: "text", text: "Yes, it is gold." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } });
        return json({}, 500);
      });
      return seen;
    }

    beforeEach(() => {
      process.env["LOVABLE_API_KEY"] = "gateway-key";
    });

    it("healthy gateway: the vault is never read (nothing changes on a normal run)", async () => {
      const db = aiWorld();
      stub(() => json({ choices: [{ message: { content: "Yes, it is gold." } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      const out = await run(db);
      expect(out.status).toBe("ok");
      expect(out.provider).toBe("lovable");
      // (The primary's own platform_ai_providers lookup for "lovable" is unchanged.)
      expect(db.ops.some((o) => o.table === "platform_ai_providers" && db.has(o, "in", "provider", ["anthropic", "openai"]))).toBe(false);
      expect(db.rpcs.some((r) => String(r.args?.["p_name"] ?? "").startsWith("platform_"))).toBe(false);
    });

    it("gateway out of credit, no env key: Claude answers on the Platform providers key and the chosen model", async () => {
      const db = aiWorld({ chosen: "claude-haiku-4-5" });
      const seen = stub(() => json({ error: { message: "Payment required: out of credits" } }, 402));
      const out = await run(db);
      expect(out.status).toBe("ok");
      expect(out.output).toBe("Yes, it is gold.");
      expect(out.provider).toBe("anthropic");
      const call = seen.find((s) => s.url.includes("api.anthropic.com"))!;
      expect(call.headers["x-api-key"]).toBe("vault-ant-key-SECRET");
      expect(call.body["model"]).toBe("claude-haiku-4-5");
      const row = db.ops.find((o) => o.table === "ai_runs" && o.kind === "insert")!.payload as Record<string, unknown>;
      expect(JSON.stringify(row)).not.toContain("SECRET");
    });

    it("no vault rows and no env key: the same error as before, no backup called", async () => {
      const db = aiWorld({ noRows: true });
      const seen = stub(() => json({ error: { message: "Payment required: out of credits" } }, 402));
      const out = await run(db);
      expect(out.status).toBe("error");
      expect(out.error).toBe("This workspace has run out of AI credit.");
      expect(seen.some((s) => s.url.includes("anthropic") || s.url.includes("openai.com"))).toBe(false);
    });

    it("embeddings: on a gateway outage the Platform providers OpenAI key is used (text-embedding-3-small)", async () => {
      h.db = aiWorld();
      const seen: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seen.push({ url, auth: headers.get("authorization"), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
        if (url.includes("gateway")) return json({ error: { message: "Payment required" } }, 402);
        return json({ data: [{ embedding: [0.5] }] });
      });
      expect(await embedTexts(["hello"])).toEqual([[0.5]]);
      const direct = seen.find((s) => s.url.includes("api.openai.com"))!;
      expect(direct.auth).toBe("Bearer vault-oa-key-SECRET");
      expect(direct.body["model"]).toBe("text-embedding-3-small");
    });
  });

  describe("/api/admin/ai", () => {
    type Post = (ctx: { request: Request }) => Promise<Response>;
    const post = (AdminAiRoute.options as unknown as { server: { handlers: { POST: Post } } }).server.handlers.POST;
    const call = (body: Record<string, unknown>) =>
      post({ request: new Request("http://x/api/admin/ai", { method: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify(body) }) });
    const world = (opts: PlatformOpts & { saveError?: string } = {}) => {
      const db = fakeDb(
        (op) => {
          if (op.table === "platform_settings" && op.kind === "update" && opts.saveError)
            return { data: null, error: { message: opts.saveError } };
          return platformReply(op, opts);
        },
        vaultRpc,
      );
      Object.assign(db.supabase, { auth: { getUser: async () => ({ data: { user: { id: "admin-1" } } }) } });
      h.db = db;
      return db;
    };

    it("overview: Anthropic and OpenAI 'Configured: yes' from Platform providers, no key in the answer", async () => {
      world();
      const res = await call({ action: "overview" });
      const out = (await res.json()) as { backup: ReturnType<typeof backupStatus> };
      expect(out.backup.anthropic).toMatchObject({ configured: true, key_source: "vault", model: "claude-sonnet-5-5" });
      expect(out.backup.openai).toMatchObject({ configured: true, key_source: "vault" });
      expect(JSON.stringify(out)).not.toContain("SECRET");
    });

    it("Test backup works with the vault keys alone", async () => {
      const db = world();
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (url.includes("anthropic.com"))
          return json({ id: "m", type: "message", role: "assistant", model: body["model"], content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
        return json({ output: [] });
      });
      const res = await call({ action: "backup_test" });
      const out = (await res.json()) as { results: Array<{ provider: string; model: string; ok: boolean }> };
      expect(out.results.map((r) => `${r.provider}:${r.model}:${r.ok}`)).toEqual([
        "anthropic:claude-sonnet-5-5:true",
        "openai:gpt-5.4-mini:true",
        "openai:gpt-5.4:true",
      ]);
      const log = db.ops.find((o) => o.table === "activity_log" && o.kind === "insert")!;
      expect(JSON.stringify(log.payload)).not.toContain("SECRET");
      expect(JSON.stringify(out)).not.toContain("SECRET");
    });

    it("set_backup_model saves a listed model in platform settings; anything else is refused", async () => {
      const db = world();
      expect((await call({ anthropic_model: "claude-fable-9", action: "set_backup_model" })).status).toBe(400);
      expect(db.ops.some((o) => o.table === "platform_settings" && o.kind === "update")).toBe(false);
      const res = await call({ anthropic_model: "claude-opus-5-5", action: "set_backup_model" });
      expect(res.status).toBe(200);
      const save = db.ops.find((o) => o.table === "platform_settings" && o.kind === "update")!;
      expect(save.payload).toMatchObject({ ai_backup_anthropic_model: "claude-opus-5-5" });
      expect(db.has(save, "eq", "id", true)).toBe(true);
    });

    it("set_backup_model: a failed save says so", async () => {
      world({ saveError: "timeout" });
      const res = await call({ anthropic_model: "claude-sonnet-5-5", action: "set_backup_model" });
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: string }).error).toBe("The backup model could not be saved.");
    });
  });

  it("the migration is idempotent and only adds the column + check", () => {
    const sql = readFileSync("supabase/aidwar-migrations/20261017_ai_backup_model.sql", "utf8");
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS ai_backup_anthropic_model text/);
    expect(sql).toMatch(/IF NOT EXISTS \(\s*SELECT 1 FROM pg_constraint/);
    const code = sql.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/\bUPDATE\b|\bDELETE\b|\bDROP\b/i);
  });
});

// ------------------------------------------------------------------ (2)
const ORIGIN = "https://myzoori.com";
const PRODUCT_URL = `${ORIGIN}/product-detail/a2bcf643-94f3-4ab9-bdaa-3be95c9a40a3`;
/** The shape of a live Zoori product page: JSON-LD, a breadcrumb, and the labelled spec lines. */
const productPage = (image = "https://www.myzoori.com/storage/images/products/a2bc/studs-1.jpg") => `<!doctype html><html><head>
<title>Curved Orbit Studs || ZERN-0021</title>
<meta property="og:image" content="${image}">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Curved Orbit Studs","image":["${image}"],"sku":"ZERN-0021","brand":{"@type":"Brand","name":"MyZoori"},"offers":{"@type":"Offer","price":"45863.63","priceCurrency":"INR","availability":"https://schema.org/InStock"}}</script>
</head><body>
<nav class="breadcrumb"><a href="/">Home</a> / <a href="/earrings">Earrings</a> / Curved Orbit Studs</nav>
<h1>Curved Orbit Studs</h1>
<div class="gallery"><img src="${image}" alt="Curved Orbit Studs"></div>
<p class="metal-text">Metal: Gold, Diamond</p>
<p class="carat-weight-text">Gross weight: 2.25 gm</p>
<p>${"Handcrafted in 18K gold with natural diamonds. ".repeat(4)}</p>
</body></html>`;

describe("(2) Refresh from website fills missing photos, descriptions and categories", () => {
  type Row = { id: string; external_id: string; product_url: string; sku: string | null; image_url: string | null; description: string | null; category: string | null };
  function productsDb(rows: Row[]) {
    return fakeDb((op) => {
      if (op.table === "products" && op.kind === "select") return { data: rows, error: null };
      return undefined;
    });
  }
  const updates = (db: ReturnType<typeof productsDb>) => db.ops.filter((o) => o.table === "products" && o.kind === "update");

  it("fills only the empty fields, each write guarded on the field still being empty", async () => {
    const db = productsDb([
      { id: "p-empty", external_id: PRODUCT_URL, product_url: PRODUCT_URL, sku: null, image_url: null, description: null, category: null },
      { id: "p-has-cat", external_id: `${PRODUCT_URL}-2`, product_url: `${PRODUCT_URL}-2`, sku: null, image_url: "https://keep.me/photo.jpg", description: null, category: "rings" },
    ]);
    const fetched: string[] = [];
    const report = await fillMissingProductDetails(db.supabase, "org", ORIGIN, {
      fetchHtml: async (url) => {
        fetched.push(url);
        return productPage();
      },
    });
    expect(fetched.sort()).toEqual([PRODUCT_URL, `${PRODUCT_URL}-2`]);
    const [first, second] = updates(db);
    expect(first!.payload).toMatchObject({
      image_url: "https://www.myzoori.com/storage/images/products/a2bc/studs-1.jpg",
      category: "earrings",
    });
    expect(String((first!.payload as Record<string, unknown>)["description"])).toContain("Metal: Gold, Diamond");
    expect(String((first!.payload as Record<string, unknown>)["description"])).toContain("Gross weight: 2.25 gm");
    for (const f of ["image_url", "description", "category"]) expect(db.has(first!, "is", f, null)).toBe(true);
    // The second product keeps its photo and its shelf: only the description is written.
    const p2 = second!.payload as Record<string, unknown>;
    expect(Object.keys(p2).sort()).toEqual(["description", "updated_at"]);
    expect(db.has(second!, "is", "description", null)).toBe(true);
    expect(db.has(second!, "is", "image_url", null)).toBe(false);
    expect(report).toMatchObject({ missing: 2, checked: 2, filled: 2, fields: { image_url: 1, description: 2, category: 1 } });
  });

  it("only this site's visible crawled products that miss something are asked for", async () => {
    const db = productsDb([]);
    const report = await fillMissingProductDetails(db.supabase, "org", ORIGIN, { fetchHtml: async () => productPage() });
    expect(report.missing).toBe(0);
    const q = db.ops.find((o) => o.table === "products" && o.kind === "select")!;
    expect(db.has(q, "eq", "source", "crawl")).toBe(true);
    expect(db.has(q, "eq", "is_visible", true)).toBe(true);
    expect(db.has(q, "like", "product_url", `${ORIGIN}%`)).toBe(true);
    expect(db.has(q, "or", "image_url.is.null,description.is.null,category.is.null")).toBe(true);
  });

  it("a page with nothing new writes nothing; a page that can't be opened is skipped", async () => {
    const db = productsDb([
      { id: "a", external_id: PRODUCT_URL, product_url: PRODUCT_URL, sku: null, image_url: null, description: null, category: null },
      { id: "b", external_id: `${PRODUCT_URL}-x`, product_url: `${PRODUCT_URL}-x`, sku: null, image_url: null, description: null, category: null },
    ]);
    const report = await fillMissingProductDetails(db.supabase, "org", ORIGIN, {
      fetchHtml: async (url) => (url.endsWith("-x") ? null : "<html><body>gone</body></html>"),
    });
    expect(updates(db)).toHaveLength(0);
    expect(report.filled).toBe(0);
  });

  /**
   * The whole "Refresh from website" read, twice, on a page whose text never
   * changes: the scheduled refresh (no fill) touches no product; the button's
   * refresh (fill_products) fills the product from its page while the
   * unchanged home page is not re-embedded.
   */
  it("end to end: an UNCHANGED page is not re-embedded, and the product still gets filled", async () => {
    process.env["LOVABLE_API_KEY"] = "gateway-key";
    const HOME = `${ORIGIN}/`;
    const homeHtml = `<!doctype html><html><head><title>ZOORI Jewels</title></head><body><h1>ZOORI Jewels</h1><p>${"Fine diamond jewellery made in India. ".repeat(12)}</p></body></html>`;
    let stored: { content_hash: string; metadata: Record<string, unknown> } | null = null;
    let config: Record<string, unknown> = { url: HOME, mode: "full", refresh: true };
    const productRow = { id: "p-studs", external_id: PRODUCT_URL, product_url: PRODUCT_URL, sku: null, image_url: null, description: null, category: null };
    const db = fakeDb(
      (op) => {
        if (op.table === "knowledge_sources" && op.kind === "select")
          return { data: { id: "src", organization_id: "org", type: "website", name: "myzoori.com", config }, error: null };
        if (op.table === "knowledge_sources" && op.kind === "update") {
          const next = (op.payload as { config?: Record<string, unknown> }).config;
          if (next) config = next;
          return undefined;
        }
        if (op.table === "platform_settings")
          return { data: { reader_primary: "own", reader_fallback_order: ["own"], map_engine: "own", day0_crawl_cost_cap: 0 }, error: null };
        if (op.table === "knowledge_documents" && op.kind === "select" && op.filters.some(([n]) => n === "maybeSingle"))
          return { data: stored ? { id: "doc-home", ...stored } : null, error: null };
        if (op.table === "knowledge_documents" && op.kind === "insert") {
          const p = op.payload as { content_hash: string; metadata: Record<string, unknown> };
          stored = { content_hash: p.content_hash, metadata: p.metadata };
          return { data: { id: "doc-home" }, error: null };
        }
        if (op.table === "knowledge_documents" && op.kind === "update") {
          const p = op.payload as { content_hash?: string; metadata?: Record<string, unknown> };
          if (stored && p.metadata) stored = { content_hash: p.content_hash ?? stored.content_hash, metadata: p.metadata };
          return undefined;
        }
        if (op.table === "knowledge_chunks" && op.kind === "select") return { data: null, error: null, count: stored ? 3 : 0 } as never;
        if (op.table === "knowledge_urls" && op.kind === "select") return { data: [], error: null, count: 1 } as never;
        if (op.table === "products" && op.kind === "select" && op.filters.some(([n]) => n === "or")) return { data: [productRow], error: null };
        if (op.table === "products" && op.kind === "select") return { data: [], error: null, count: 1 } as never;
        return undefined;
      },
      () => undefined,
    );
    const fetched: string[] = [];
    let embeddings = 0;
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      fetched.push(url);
      if (url.includes("/embeddings")) {
        embeddings += 1;
        return json({ data: [{ embedding: [0.1, 0.2] }] });
      }
      // Public-address check (DNS over HTTPS) before every page fetch.
      if (url.includes("type=A") || url.includes("type=AAAA"))
        return json({ Status: 0, Answer: url.includes("type=AAAA") ? [] : [{ type: 1, data: "104.21.32.1" }] });
      if (url === HOME) return new Response(homeHtml, { status: 200, headers: { "content-type": "text/html" } });
      if (url === PRODUCT_URL) return new Response(productPage(), { status: 200, headers: { "content-type": "text/html" } });
      if (url.endsWith("/sitemap.xml"))
        return new Response(`<urlset><url><loc>${HOME}</loc></url></urlset>`, { status: 200, headers: { "content-type": "application/xml" } });
      return new Response("", { status: 404 });
    });

    // Pass 1: a scheduled refresh (no fill) — reads and embeds the home page once, touches no product.
    const first = await syncSource(db.supabase, "src");
    expect(first.error ?? null).toBeNull();
    expect(first.ok).toBe(true);
    expect(stored).not.toBeNull();
    expect(embeddings).toBe(1);
    expect(fetched).not.toContain(PRODUCT_URL);
    expect(db.ops.some((o) => o.table === "products" && o.kind === "update")).toBe(false);

    // Pass 2: the "Refresh from website" button — same unchanged page.
    config = { ...config, refresh: true, fill_products: true };
    const opsBefore = db.ops.length;
    fetched.length = 0;
    const second = await syncSource(db.supabase, "src");
    expect(second.ok).toBe(true);
    const ops = db.ops.slice(opsBefore);
    // Unchanged text: no new embedding, no chunk rebuilt or deleted.
    expect(embeddings).toBe(1);
    expect(ops.some((o) => o.table === "knowledge_chunks" && (o.kind === "delete" || o.kind === "insert"))).toBe(false);
    // …and the product was filled from its own page.
    expect(fetched).toContain(PRODUCT_URL);
    const fill = ops.find((o) => o.table === "products" && o.kind === "update" && o.filters.some(([n, a]) => n === "eq" && a[0] === "id" && a[1] === "p-studs"))!;
    expect(fill.payload).toMatchObject({ category: "earrings", image_url: "https://www.myzoori.com/storage/images/products/a2bc/studs-1.jpg" });
    expect(String((fill.payload as Record<string, unknown>)["description"])).toContain("Metal: Gold, Diamond");
    // The request to fill is used up.
    expect(config["fill_products"]).toBeUndefined();
    expect(config["refresh"]).toBe(false);
  });

  it("the Refresh button (read_changes) asks for the fill; scheduled refreshes don't", () => {
    const route = readFileSync("src/routes/api/ai/knowledge.ts", "utf8");
    expect(route).toContain("config = { ...(src.config ?? {}), refresh: true, fill_products: true };");
    const scheduled = readFileSync("src/routes/api/internal/knowledge-refresh.ts", "utf8");
    expect(scheduled).not.toContain("fill_products");
  });
});

// ------------------------------------------------------------------ (3)
describe("(3) WhatsApp shop", () => {
  const CATALOG = "2287874905321675";
  const WABA = "28241127162223606";
  type Product = { id: string; external_id: string | null; sku: string | null; title: string; description: string | null; price: number | null; currency: string; image_url: string | null; product_url: string | null; brand: string | null; category: string | null; availability: string; inventory_quantity: number | null; is_visible?: boolean };
  const product = (id: string, title: string, extra: Partial<Product> = {}): Product => ({
    id, external_id: `https://shop.in/p/${id}`, sku: null, title, description: null, price: 1000, currency: "INR",
    image_url: `https://shop.in/${id}.jpg`, product_url: `https://shop.in/p/${id}`, brand: null, category: null,
    availability: "in_stock", inventory_quantity: null, ...extra,
  });

  function shopWorld(opts: { visible: Product[]; all?: Product[]; markers?: Product[]; status?: string } ) {
    const catalogRow = { catalog_id: CATALOG, catalog_name: "Catalogue_Products", status: opts.status ?? "attach_unconfirmed", mode: "managed", last_sync_at: "2026-09-24T06:40:03Z", pushed_count: 16, rejected_count: 0, last_error: null, is_catalog_visible: null as boolean | null, is_cart_enabled: null as boolean | null };
    const db = fakeDb((op) => {
      if (op.table === "organization_members") return { data: [{ organization_id: "org", role: "owner" }], error: null };
      if (op.table === "whatsapp_accounts") return { data: { id: "acc", organization_id: "org", waba_id: WABA, phone_number_id: "pn-1", status: "active", is_default: true }, error: null };
      if (op.table === "whatsapp_credentials") return { data: { access_token: "merchant-tok", granted_scopes: ["catalog_management", "business_management"] }, error: null };
      if (op.table === "whatsapp_catalogs" && op.kind === "select") return { data: { ...catalogRow }, error: null };
      if (op.table === "whatsapp_catalogs" && op.kind === "update") {
        Object.assign(catalogRow, op.payload as object);
        return undefined;
      }
      if (op.table === "products" && op.kind === "select" && op.filters.some(([n, a]) => n === "eq" && a[0] === "is_visible"))
        return { data: opts.visible, error: null };
      if (op.table === "products" && op.kind === "select" && op.filters.some(([n]) => n === "not"))
        return { data: opts.markers ?? [], error: null };
      if (op.table === "products" && op.kind === "select") return { data: opts.all ?? [], error: null };
      return undefined;
    });
    Object.assign(db.supabase, { auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) } });
    h.db = db;
    return { db, catalogRow };
  }

  type Call = { url: string; method: string; auth: string | null; body: Record<string, unknown> | null };
  function stubGraph(handler: (c: Call) => Response | undefined) {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const c: Call = {
        url: String(url),
        method: init?.method ?? "GET",
        auth: (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? null,
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      };
      calls.push(c);
      return handler(c) ?? json({ data: [] });
    });
    return calls;
  }

  beforeEach(() => {
    process.env["META_CATALOG_PLATFORM_TOKEN"] = "platform-tok";
  });

  it("a hidden product (and a legal clause) is never pushed, and is removed from Meta even without our marker", async () => {
    const visible = [product("ring", "Ring"), product("terms", "7. Limitation of liability")];
    const hidden = product("old", "Old Ring", { is_visible: false });
    const { db } = shopWorld({ visible, all: [...visible, hidden], markers: [] });
    const calls = stubGraph((c) => {
      if (c.url.includes(`/${CATALOG}/products`))
        return json({ data: [{ retailer_id: "https://shop.in/p/ring" }, { retailer_id: "https://shop.in/p/old" }, { retailer_id: "https://shop.in/p/terms" }, { retailer_id: "merchant-own-item" }] });
      if (c.url.includes("/items_batch")) return json({ handles: ["h1"] });
      if (c.url.includes("check_batch_request_status")) return json({ data: [{ handle: "h1", status: "finished", errors: [], warnings: [] }] });
      return undefined;
    });
    const out = await syncCatalog({ supabase: db.supabase, organizationId: "org", userId: "u1", whatsappAccountId: "acc" });
    expect(out).toMatchObject({ ok: true, eligible: 1, pushed: 1, removed: 2 });
    const batches = calls.filter((c) => c.url.includes("/items_batch"));
    const pushed = (batches[0]!.body!["requests"] as Array<{ method: string; data: { id: string } }>);
    expect(pushed.map((r) => `${r.method}:${r.data.id}`)).toEqual(["UPDATE:https://shop.in/p/ring"]);
    const deleted = (batches[1]!.body!["requests"] as Array<{ method: string; data: { id: string } }>);
    expect(deleted.map((r) => `${r.method}:${r.data.id}`).sort()).toEqual(["DELETE:https://shop.in/p/old", "DELETE:https://shop.in/p/terms"]);
    // Items we never pushed are left alone.
    expect(JSON.stringify(deleted)).not.toContain("merchant-own-item");
    expect(out.last_sync_at).toEqual(expect.any(String));
  });

  it("the batch status is read from data[0]: one poll when Meta says finished, and its item errors count as refused", async () => {
    expect(batchStatusNode({ data: [{ status: "finished" }] })).toEqual({ status: "finished" });
    expect(batchStatusNode({ status: "in_progress" })).toEqual({ status: "in_progress" });
    const { db } = shopWorld({ visible: [product("ring", "Ring"), product("band", "Band")] });
    const calls = stubGraph((c) => {
      if (c.url.includes("/items_batch")) return json({ handles: ["h1"] });
      if (c.url.includes("check_batch_request_status"))
        return json({ data: [{ handle: "h1", status: "finished", errors: [{ id: "https://shop.in/p/band", message: "Image too small" }] }] });
      return undefined;
    });
    const out = await syncCatalog({ supabase: db.supabase, organizationId: "org", userId: "u1", whatsappAccountId: "acc" });
    expect(calls.filter((c) => c.url.includes("check_batch_request_status"))).toHaveLength(1);
    expect(out).toMatchObject({ pushed: 1, rejected: 1 });
    expect(out.rejections?.[0]).toContain("Image too small");
  });

  it("visibility: Meta confirms the attach and reads the shop button → stored, 'linked', Visible to customers", async () => {
    const { db, catalogRow } = shopWorld({ visible: [] });
    const calls = stubGraph((c) => {
      if (c.url.includes(`/${WABA}/product_catalogs`)) return json({ data: [{ id: CATALOG, name: "Catalogue_Products" }] });
      if (c.url.includes("/pn-1/whatsapp_commerce_settings")) return json({ data: [{ is_catalog_visible: true, is_cart_enabled: true, id: "x" }] });
      return undefined;
    });
    const out = await checkShopVisibility({ supabase: db.supabase, organizationId: "org", userId: "u1", whatsappAccountId: "acc" });
    expect(out.visibility).toMatchObject({ attached: true, is_catalog_visible: true, is_cart_enabled: true, visible: true, errors: [] });
    expect(catalogRow).toMatchObject({ status: "linked", is_catalog_visible: true, is_cart_enabled: true });
    // Read-only at Meta.
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls[0]!.auth).toBe("Bearer merchant-tok");
  });

  it("visibility: not attached and the shop button off → stored as Meta says, 'Not visible yet' with both steps", async () => {
    const { db, catalogRow } = shopWorld({ visible: [] });
    stubGraph((c) => {
      if (c.url.includes(`/${WABA}/product_catalogs`)) return json({ data: [] });
      if (c.url.includes("/whatsapp_commerce_settings")) return json({ data: [{ is_catalog_visible: false, is_cart_enabled: false }] });
      return undefined;
    });
    const out = await checkShopVisibility({ supabase: db.supabase, organizationId: "org", userId: "u1", whatsappAccountId: "acc" });
    expect(out.visibility).toMatchObject({ attached: false, visible: false });
    expect(catalogRow).toMatchObject({ status: "attach_unconfirmed", is_catalog_visible: false, is_cart_enabled: false });
    expect(shopVisibilityState(catalogRow as never, out.visibility!)).toEqual({ visible: false, todo: ["attach", "shop_button"], known: true });
  });

  it("visibility: Meta refuses the merchant token → tries ours, and a reading that fails stores nothing", async () => {
    const { db, catalogRow } = shopWorld({ visible: [] });
    const calls = stubGraph((c) => {
      if (c.auth === "Bearer merchant-tok") return json({ error: { message: "(#10) Application does not have permission for this action", code: 10 } }, 400);
      if (c.url.includes(`/${WABA}/product_catalogs`)) return json({ data: [{ id: CATALOG }] });
      return json({ error: { message: "Unsupported get request", code: 100 } }, 400);
    });
    const out = await checkShopVisibility({ supabase: db.supabase, organizationId: "org", userId: "u1", whatsappAccountId: "acc" });
    expect(calls.some((c) => c.auth === "Bearer platform-tok")).toBe(true);
    expect(out.visibility).toMatchObject({ attached: true, is_catalog_visible: null, visible: false });
    expect(out.visibility!.errors.join(" ")).toContain("shop button");
    expect(catalogRow).toMatchObject({ status: "linked", is_catalog_visible: null, is_cart_enabled: null });
  });

  it("a 'linked' row is never moved back by a check", async () => {
    const { db, catalogRow } = shopWorld({ visible: [], status: "linked" });
    stubGraph((c) => (c.url.includes("product_catalogs") ? json({ data: [] }) : undefined));
    await checkShopVisibility({ supabase: db.supabase, organizationId: "org", userId: "u1", whatsappAccountId: "acc" });
    expect(catalogRow.status).toBe("linked");
  });

  it("Sync now: the answer carries the new count, time and Meta's visibility, so the card updates at once", async () => {
    type Post = (ctx: { request: Request }) => Promise<Response>;
    const post = (CatalogRoute.options as unknown as { server: { handlers: { POST: Post } } }).server.handlers.POST;
    shopWorld({ visible: [product("ring", "Ring")] });
    stubGraph((c) => {
      if (c.url.includes("/items_batch")) return json({ handles: ["h1"] });
      if (c.url.includes("check_batch_request_status")) return json({ data: [{ status: "finished" }] });
      if (c.url.includes(`/${WABA}/product_catalogs`)) return json({ data: [{ id: CATALOG }] });
      if (c.url.includes("/whatsapp_commerce_settings")) return json({ data: [{ is_catalog_visible: true, is_cart_enabled: true }] });
      return undefined;
    });
    const res = await post({
      request: new Request("http://x/api/whatsapp/catalog", {
        method: "POST",
        headers: { authorization: "Bearer t" },
        body: JSON.stringify({ organization_id: "org", whatsapp_account_id: "acc", action: "sync" }),
      }),
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { pushed: number; last_sync_at: string; catalog: { pushed_count: number; last_sync_at: string; status: string }; visibility: { visible: boolean } };
    expect(out.pushed).toBe(1);
    expect(out.catalog).toMatchObject({ pushed_count: 1, status: "linked" });
    expect(out.catalog.last_sync_at).toBe(out.last_sync_at);
    expect(out.visibility.visible).toBe(true);
  });

  it("card state: stored row alone → visible only when attached and the shop button is on", () => {
    const row = { waba_id: WABA, status: "attach_unconfirmed", pushed_count: 17, last_sync_at: null, is_catalog_visible: null };
    expect(shopVisibilityState(row)).toEqual({ visible: false, todo: ["attach", "shop_button"], known: false });
    expect(shopVisibilityState({ ...row, status: "linked", is_catalog_visible: true })).toEqual({ visible: true, todo: [], known: true });
    expect(shopVisibilityState({ ...row, status: "linked", is_catalog_visible: false }).todo).toEqual(["shop_button"]);
    expect(shopVisibilityState(null).visible).toBe(false);
  });

  it("the card: loading state, result toast, count/time from the answer, errors never leave it spinning", () => {
    const card = readFileSync("src/components/catalog/whatsapp-shop-card.tsx", "utf8");
    expect(card).toContain("toast.loading(");
    expect(card).toContain('{syncing ? "Syncing…" : "Sync now"}');
    expect(card).toMatch(/finally \{\s*setSyncing\(false\);/);
    expect(card).toContain("applyRow(wabaId");
    expect(card).toContain("Visible to customers");
    expect(card).toContain("Not visible yet - what to do");
  });
});

// ------------------------------------------------------------------ (4)
describe("(4) Products toolbar on a phone", () => {
  it("the action row wraps below lg and stays one row from lg up", () => {
    const view = readFileSync("src/components/catalog/catalog-view.tsx", "utf8");
    expect(view).toContain('<div className="flex flex-wrap items-center gap-2 lg:flex-nowrap">');
  });
});
