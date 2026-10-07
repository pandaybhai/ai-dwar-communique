import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";

/**
 * Batch 17 (5): website-reading AI cost guards.
 *  - facts at most once per page text (a re-read of the same text reuses them);
 *  - a per-workspace daily cap on reading AI spend, logged when hit;
 *  - the nightly backfill skips workspaces with no WhatsApp number and AI off;
 *  - admin Reading shows reader + facts + embeddings per source.
 */

const h = vi.hoisted(() => ({ runs: 0 }));
vi.mock("@/lib/ai-run.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai-run.server")>()),
  executeRun: vi.fn(async () => {
    h.runs += 1;
    return { output: `Fact sentence number ${h.runs}: the shop ships across India in 3–5 days.`.repeat(2), costAmount: 0.7, inputTokens: 1000, outputTokens: 100 };
  }),
  embedTexts: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
  meterAiUsage: vi.fn(async () => {}),
}));

import { readingLog, savePage } from "./knowledge.server";
import { backfillWanted, readingAiCapReached } from "./reading.server";

afterEach(() => {
  h.runs = 0;
  vi.restoreAllMocks();
});

type Doc = { id: string; source_ref: string; content: string; content_hash: string | null; metadata: Record<string, unknown> };

/** knowledge_documents kept in memory; ai_usage spend today = `spent`. */
function readingWorld(spent = 0, cap: number | null = null) {
  const docs: Doc[] = [];
  const eqv = (op: FakeOp, col: string) => op.filters.find(([n, a]) => n === "eq" && a[0] === col)?.[1][1];
  const db = fakeDb((op) => {
    if (op.table === "platform_settings") return { data: cap === null ? null : { reading_ai_daily_cap: cap }, error: null };
    if (op.table === "ai_usage") return { data: [{ cost_amount: spent }], error: null };
    if (op.table === "knowledge_documents") {
      if (op.kind === "select") {
        const contains = op.filters.find(([n]) => n === "contains")?.[1][1] as Record<string, unknown> | undefined;
        const hit = contains
          ? docs.find((d) => Object.entries(contains).every(([k, v]) => d.metadata[k] === v))
          : docs.find((d) => d.source_ref === eqv(op, "source_ref"));
        return { data: hit ?? null, error: null };
      }
      if (op.kind === "insert") {
        const p = op.payload as Doc;
        docs.push({ ...p, id: `d${docs.length + 1}` });
        return { data: { id: `d${docs.length}` }, error: null };
      }
      if (op.kind === "update") {
        const d = docs.find((x) => x.id === eqv(op, "id"));
        if (d) Object.assign(d, op.payload);
        return { data: null, error: null };
      }
    }
    return undefined;
  });
  return { db, docs };
}

const ctx = (supabase: unknown) => ({
  supabase: supabase as never,
  organizationId: "org",
  sourceId: "src",
  origin: "https://shop.example",
  platform: null,
  readVia: "own",
  facts: true,
  factsOnProductPages: false,
});
const page = (text: string) => ({
  title: "About us",
  text,
  html: `<html><body><p>${text}</p></body></html>`,
  links: [],
  usedReader: false,
  status: 200,
  contentType: "text/html",
});
const LONG = "We are a family business in Jaipur making silver jewellery since 1998. ".repeat(40);

describe("(5) facts at most once per page text", () => {
  it("the same page read again: no second model run, the stored facts are reused", async () => {
    const w = readingWorld();
    const first = await savePage(ctx(w.db.supabase), "https://shop.example/about", page(LONG));
    expect(h.runs).toBe(1);
    expect(first.cost).toBeCloseTo(0.7);
    const again = await savePage(ctx(w.db.supabase), "https://shop.example/about", page(LONG));
    expect(h.runs).toBe(1);
    expect(again.cost).toBe(0);
    expect(w.docs).toHaveLength(1);
    expect(w.docs[0]!.metadata["summarised"]).toBe(true);
    expect(w.docs[0]!.content.startsWith("Fact sentence number 1")).toBe(true);
  });

  it("the same text under another address of the same site reuses them too", async () => {
    const w = readingWorld();
    await savePage(ctx(w.db.supabase), "https://shop.example/about", page(LONG));
    await savePage(ctx(w.db.supabase), "https://shop.example/pages/about-us", page(LONG));
    expect(h.runs).toBe(1);
  });

  it("changed text is turned into facts again", async () => {
    const w = readingWorld();
    await savePage(ctx(w.db.supabase), "https://shop.example/about", page(LONG));
    await savePage(ctx(w.db.supabase), "https://shop.example/about", page(`${LONG} Now also in Pune.`));
    expect(h.runs).toBe(2);
  });
});

describe("(5) daily cap on reading AI spend", () => {
  it("over the cap: the page is saved as read, no model run, and the hit is logged once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = readingWorld(150);
    const saved = await savePage(ctx(w.db.supabase), "https://shop.example/about", page(LONG));
    expect(saved.saved).toBe(true);
    expect(h.runs).toBe(0);
    expect(w.docs[0]!.content.startsWith("We are a family business")).toBe(true);
    await savePage(ctx(w.db.supabase), "https://shop.example/shipping", page(`${LONG} shipping`));
    const hits = warn.mock.calls.filter((c) => String(c[0]).includes("reading_ai_cap_hit"));
    expect(hits).toHaveLength(1);
    expect(JSON.parse(String(hits[0]![0]))).toMatchObject({ organization_id: "org", spent: 150, cap: 100 });
  });

  it("the cap is a platform setting (default ₹100 when missing; 0 = no cap)", async () => {
    expect(await readingAiCapReached(readingWorld(99).db.supabase, "o1")).toBe(false);
    expect(await readingAiCapReached(readingWorld(100).db.supabase, "o2")).toBe(true);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await readingAiCapReached(readingWorld(30, 25).db.supabase, "o3")).toBe(true);
    expect(await readingAiCapReached(readingWorld(9999, 0).db.supabase, "o4")).toBe(false);
  });

  it("counts only reading tasks for today", async () => {
    const w = readingWorld(0);
    await readingAiCapReached(w.db.supabase, "o5");
    const q = w.db.ops.find((o) => o.table === "ai_usage")!;
    expect(w.db.has(q, "in", "task", ["knowledge_facts", "knowledge_image", "embedding"])).toBe(true);
    expect(w.db.has(q, "eq", "usage_date", new Date().toISOString().slice(0, 10))).toBe(true);
  });
});

describe("(5) the nightly backfill skips workspaces that can't use the pages", () => {
  const world = (activeNumbers: number, mode: string | null) =>
    fakeDb((op) => {
      if (op.table === "whatsapp_accounts") return { data: null, error: null, count: activeNumbers };
      if (op.table === "ai_agents") return { data: mode ? { mode } : null, error: null };
      return undefined;
    }).supabase;

  it("no WhatsApp number and AI off → skipped; either one → read", async () => {
    expect(await backfillWanted(world(0, "off"), "o")).toBe(false);
    expect(await backfillWanted(world(0, null), "o")).toBe(false);
    expect(await backfillWanted(world(1, "off"), "o")).toBe(true);
    expect(await backfillWanted(world(0, "replying"), "o")).toBe(true);
  });

  it("the backfill route asks before queuing; Day-0 reads never do", () => {
    const route = readFileSync(new URL("../routes/api/internal/knowledge-backfill.ts", import.meta.url), "utf8");
    expect(route).toMatch(/if \(!\(await backfillWanted\(supabase, src\.organization_id\)\)\)/);
    const knowledge = readFileSync(new URL("./knowledge.server.ts", import.meta.url), "utf8");
    expect(knowledge).not.toMatch(/backfillWanted/);
  });
});

describe("(5) admin Reading: full read cost per source", () => {
  it("sums reader + facts + embeddings over the source's logged runs", async () => {
    const db = fakeDb((op) => {
      if (op.table === "knowledge_sources") return { data: [{ id: "s1", name: "shop", status: "ready", config: {} }], error: null };
      if (op.table === "activity_log")
        return {
          data: [
            { action: "reading_run", created_at: "2026-10-07T01:00:00Z", details: { source_id: "s1", cost: 3.5, reader_cost: 1, facts_cost: 2.4, embed_cost: 0.1 } },
            { action: "reading_run", created_at: "2026-10-06T01:00:00Z", details: { source_id: "s1", cost: 2 } },
            { action: "reading_run", created_at: "2026-10-06T01:00:00Z", details: { source_id: "other", cost: 50 } },
          ],
          error: null,
        };
      return undefined;
    });
    const out = await readingLog(db.supabase, "org");
    expect(out.sources[0]!["read_cost"]).toEqual({ total: 5.5, reader: 1, facts: 2.4, embeddings: 0.1, runs: 2 });
  });

  it("each run logs its reader / facts / embeddings split", () => {
    const src = readFileSync(new URL("./knowledge.server.ts", import.meta.url), "utf8");
    expect(src).toMatch(/reader_cost: Math\.round\(readerCost \* 100\) \/ 100,\s*facts_cost: Math\.round\(factsCost \* 100\) \/ 100,\s*embed_cost:/);
  });
});

describe("(5) migration", () => {
  it("adds platform_settings.reading_ai_daily_cap, default 100, idempotent", () => {
    const sql = readFileSync(new URL("../../supabase/aidwar-migrations/20261033_batch17_reading_ai_cap.sql", import.meta.url), "utf8");
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS reading_ai_daily_cap numeric NOT NULL DEFAULT 100/);
    expect(sql).toMatch(/SET lock_timeout = '5s';/);
  });
});
