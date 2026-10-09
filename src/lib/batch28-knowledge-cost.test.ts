import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";

/**
 * Batch 28 item 2 — AI cost leak on knowledge. On 1 Oct extract_facts ran 818
 * times for 69 distinct page texts (~12x each), unbilled.
 *   (a) a page text with a successful extract_facts run is never sent again
 *       (DB-backed: ai_runs.metadata.page_hash), whatever source or address,
 *       and also when its facts were too short to keep;
 *   (b) a per-workspace daily cap on background AI runs (ai_runs), from
 *       platform_settings with a default, logged once a day;
 *   (c) a day-one read of a Play Store link reads only that app's page.
 */

type Run = { organization_id: string; task: string; status: string; metadata: Record<string, unknown>; output: string };
const h = vi.hoisted(() => ({ runs: [] as Array<Record<string, unknown>>, output: "" }));
vi.mock("@/lib/ai-run.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai-run.server")>()),
  executeRun: vi.fn(async (_db: unknown, opts: Record<string, unknown>) => {
    h.runs.push(opts);
    return { output: h.output, costAmount: 0.7, inputTokens: 1000, outputTokens: 100, status: "ok" };
  }),
  embedTexts: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
  meterAiUsage: vi.fn(async () => {}),
}));

import { savePage } from "./knowledge.server";
import { BACKGROUND_AI_DAILY_CAP_DEFAULT, BACKGROUND_AI_TASKS, backgroundAiCapReached, loadBackgroundAiDailyCap } from "./reading.server";
import { canonicalPageUrl, pageInScope } from "./site-urls";

afterEach(() => {
  h.runs.length = 0;
  h.output = "";
  vi.restoreAllMocks();
});

const FACTS = "Fact: the shop ships across India in 3–5 days and takes returns within 7 days of delivery. ".repeat(2);
const LONG = "We are a family business in Jaipur making silver jewellery since 1998. ".repeat(40);

/**
 * knowledge_documents and ai_runs in memory. Every executeRun the reader makes
 * is written to ai_runs as the real one would (task, status ok, metadata,
 * output). `todayRuns` = background runs already counted today.
 */
function world(opts: { todayRuns?: number; cap?: number | null; capError?: boolean; capLoggedToday?: boolean } = {}) {
  const docs: Array<Record<string, unknown>> = [];
  const aiRuns: Run[] = [];
  const logs: string[] = [];
  const eqv = (op: FakeOp, col: string) => op.filters.find(([n, a]) => n === "eq" && a[0] === col)?.[1][1];
  const db = fakeDb((op) => {
    if (op.table === "platform_settings") {
      if (opts.capError && String(op.select?.[0] ?? "").includes("background_ai_daily_cap"))
        return { data: null, error: { code: "42703", message: "column platform_settings.background_ai_daily_cap does not exist" } };
      return { data: opts.cap === undefined || opts.cap === null ? null : { background_ai_daily_cap: opts.cap, reading_ai_daily_cap: 0 }, error: null };
    }
    if (op.table === "ai_usage") return { data: [], error: null };
    if (op.table === "activity_log" && op.kind === "select") return { data: opts.capLoggedToday ? [{ id: "a1" }] : [], error: null };
    if (op.table === "activity_log" && op.kind === "insert") {
      logs.push(String((op.payload as Record<string, unknown>)["action"]));
      return { data: null, error: null };
    }
    if (op.table === "ai_runs") {
      if (op.select?.[1]) return { data: null, error: null, count: opts.todayRuns ?? 0 };
      const hash = eqv(op, "metadata->>page_hash");
      const hit = aiRuns.find((r) => r.organization_id === eqv(op, "organization_id") && r.task === eqv(op, "task") && r.status === "ok" && r.metadata["page_hash"] === hash);
      return { data: hit ? { output: hit.output } : null, error: null };
    }
    if (op.table === "knowledge_documents") {
      if (op.kind === "select") {
        const contains = op.filters.find(([n]) => n === "contains")?.[1][1] as Record<string, unknown> | undefined;
        const hit = contains
          ? docs.find((d) => d["source_id"] === eqv(op, "source_id") && Object.entries(contains).every(([k, v]) => (d["metadata"] as Record<string, unknown>)[k] === v))
          : docs.find((d) => d["source_ref"] === eqv(op, "source_ref") && d["source_id"] === eqv(op, "source_id"));
        return { data: hit ?? null, error: null };
      }
      if (op.kind === "insert") {
        docs.push({ ...(op.payload as Record<string, unknown>), id: `d${docs.length + 1}` });
        return { data: { id: `d${docs.length}` }, error: null };
      }
      if (op.kind === "update") {
        const d = docs.find((x) => x["id"] === eqv(op, "id"));
        if (d) Object.assign(d, op.payload);
        return { data: null, error: null };
      }
    }
    return undefined;
  });
  const save = async (url: string, text: string, sourceId = "src-1") => {
    const before = h.runs.length;
    const out = await savePage(
      { supabase: db.supabase as never, organizationId: "org", sourceId, origin: "https://shop.example", platform: null, readVia: "own", facts: true, factsOnProductPages: false } as never,
      url,
      { title: "About", text, html: `<html><body><p>${text}</p></body></html>`, links: [], usedReader: false, status: 200, contentType: "text/html" } as never,
    );
    for (const r of h.runs.slice(before)) aiRuns.push({ organization_id: "org", task: "extract_facts", status: "ok", metadata: r["metadata"] as Record<string, unknown>, output: h.output });
    return out;
  };
  return { db, docs, aiRuns, logs, save };
}

describe("item 2a — facts once per page text, DB-backed", () => {
  it("the run carries the page text's hash", async () => {
    h.output = FACTS;
    const w = world();
    await w.save("https://shop.example/about", LONG);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]!["metadata"]).toMatchObject({ purpose: "knowledge_facts", page_hash: expect.any(String) });
  });

  it("facts too short to keep: the same text is never sent again (this is what re-ran ~12x a text)", async () => {
    h.output = "Too short.";
    const w = world();
    for (let i = 0; i < 12; i++) await w.save("https://shop.example/about", LONG);
    expect(h.runs).toHaveLength(1);
  });

  it("the same text in another source of the workspace (a deleted and re-added site) reuses the stored answer", async () => {
    h.output = FACTS;
    const w = world();
    await w.save("https://shop.example/about", LONG, "src-1");
    const again = await w.save("https://shop.example/about", LONG, "src-2");
    expect(h.runs).toHaveLength(1);
    expect(again.cost).toBe(0);
    expect(String(w.docs.find((d) => d["source_id"] === "src-2")!["content"]).startsWith("Fact: the shop ships")).toBe(true);
  });

  it("changed text still gets facts", async () => {
    h.output = FACTS;
    const w = world();
    await w.save("https://shop.example/about", LONG);
    await w.save("https://shop.example/about", `${LONG} Now also in Pune.`);
    expect(h.runs).toHaveLength(2);
  });
});

describe("item 2b — daily cap on background AI runs", () => {
  it("at the cap: the page is saved as read, no model run, logged once (DB-checked)", async () => {
    h.output = FACTS;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world({ todayRuns: BACKGROUND_AI_DAILY_CAP_DEFAULT });
    const saved = await w.save("https://shop.example/about", LONG);
    expect(saved.saved).toBe(true);
    expect(h.runs).toHaveLength(0);
    expect(w.logs).toEqual(["background_ai_cap_hit"]);
  });

  it("already logged today by another worker: not logged again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world({ todayRuns: 999, capLoggedToday: true });
    expect(await backgroundAiCapReached(w.db.supabase, "org-logged")).toBe(true);
    expect(w.logs).toEqual([]);
  });

  it("counts today's extract_facts, summarise and auto_tag runs of this workspace", async () => {
    const w = world({ todayRuns: 1 });
    expect(await backgroundAiCapReached(w.db.supabase, "org-count")).toBe(false);
    const q = w.db.ops.find((o) => o.table === "ai_runs")!;
    expect(BACKGROUND_AI_TASKS).toEqual(["extract_facts", "summarise", "auto_tag"]);
    expect(w.db.has(q, "in", "task", BACKGROUND_AI_TASKS)).toBe(true);
    expect(w.db.has(q, "eq", "organization_id", "org-count")).toBe(true);
    expect(q.filters.some(([n, a]) => n === "gte" && a[0] === "created_at")).toBe(true);
  });

  it("the cap is a platform setting: missing row or column (SQL not applied) = default 300; 0 = no cap", async () => {
    expect(await loadBackgroundAiDailyCap(world().db.supabase)).toBe(300);
    expect(await loadBackgroundAiDailyCap(world({ capError: true }).db.supabase)).toBe(300);
    expect(await loadBackgroundAiDailyCap(world({ cap: 25 }).db.supabase)).toBe(25);
    expect(await backgroundAiCapReached(world({ cap: 0, todayRuns: 10_000 }).db.supabase, "org-off")).toBe(false);
  });

  it("migration: the setting column (default 300) and the page-hash index, idempotent", () => {
    const sql = readFileSync(new URL("../../supabase/aidwar-migrations/20261081_batch28_background_ai_cap.sql", import.meta.url), "utf8");
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS background_ai_daily_cap integer NOT NULL DEFAULT 300/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS ai_runs_facts_page_hash_idx/);
  });
});

describe("item 2c — a day-one read stays on the merchant's own page", () => {
  const PLAY = "https://play.google.com/store/apps/details?id=com.meezoy.app";
  const home = canonicalPageUrl(PLAY, PLAY, "https://play.google.com")!;

  it("the app's id is part of the page's address (never dropped as a listing parameter)", () => {
    expect(home).toBe(PLAY);
  });

  it("a Play Store page reads only that app — not every app it links to", () => {
    for (const other of [
      "https://play.google.com/store/apps/details?id=com.zhiliaoapp.musically", // TikTok
      "https://play.google.com/store/apps/details?id=com.cupla.app",
      "https://play.google.com/store/apps/developer?id=Upwards",
      "https://play.google.com/store/apps/details",
    ]) {
      expect(pageInScope(other, { home, onePage: true, shallow: true }), other).toBe(false);
      // Even without the stored single-page flag: same path, other id.
      expect(pageInScope(other, { home, onePage: false, shallow: true }), other).toBe(false);
    }
    expect(pageInScope(home, { home, onePage: true, shallow: true })).toBe(true);
  });

  it("a day-one read of a deep path keeps to that path; the site root and a full read reach the whole site", () => {
    const seller = "https://market.example/sellers/meezoy";
    expect(pageInScope("https://market.example/sellers/meezoy/about", { home: seller, onePage: false, shallow: true })).toBe(true);
    expect(pageInScope("https://market.example/sellers/someone-else", { home: seller, onePage: false, shallow: true })).toBe(false);
    expect(pageInScope("https://shop.example/about", { home: "https://shop.example/", onePage: false, shallow: true })).toBe(true);
    expect(pageInScope("https://market.example/sellers/someone-else", { home: seller, onePage: false, shallow: false })).toBe(true);
  });

  it("the reader applies it to every address it considers, and a listing host is one page whatever the stored config says", () => {
    const src = readFileSync(new URL("./knowledge.server.ts", import.meta.url), "utf8");
    expect(src).toMatch(/if \(!pageInScope\(url, scope\)\) return;/);
    expect(src).toMatch(/const singlePage = config\["single_page"\] === true \|\| listingLabel\(String\(config\["url"\] \?\? ""\)\) !== null;/);
  });
});
