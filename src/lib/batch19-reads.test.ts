import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type MemoryDb, type Row } from "./test-support/memory-db";

/**
 * Batch 19 — website reads stay inside their own run.
 *  1. Two reads at once (different workspaces) never use each other's
 *     forget data, so neither deletes the other's pages.
 *  4. Every read records when it started, so one that dies mid-way (the
 *     scheduled re-read reads uploads and Q&A inline) is recovered by the
 *     existing stall reset instead of staying "syncing" for ever.
 */

const h = vi.hoisted(() => ({ db: null as null | { supabase: unknown } }));
vi.mock("@/lib/whatsapp-webhook.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp-webhook.server")>()),
  getServiceClient: () => h.db!.supabase,
}));
vi.mock("@/lib/ai-run.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai-run.server")>()),
  embedTexts: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
  executeRun: async () => ({ status: "error", output: "", costAmount: 0, inputTokens: 0, outputTokens: 0 }),
  meterAiUsage: async () => undefined,
}));

import { resetStaleReads, STALE_SYNC_MS, syncSource } from "./knowledge.server";
import { clearSafeFetchDnsCache } from "./safe-fetch.server";

const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=UTF-8" } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const page = (title: string, extra = "") =>
  `<html><head><title>${title}</title></head><body><h1>${title}</h1><p>${`${title} — we deliver across India in 3 to 5 days. `.repeat(10)}</p>${extra}</body></html>`;

function stubSite(site: Record<string, string>) {
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (raw.includes("type=A") || raw.includes("type=AAAA"))
      return json({ Status: 0, Answer: raw.includes("type=AAAA") ? [] : [{ type: 1, data: "104.21.32.1" }] });
    const body = site[new URL(raw).pathname];
    return body ? html(body) : new Response("", { status: 404 });
  });
}

function world(sources: Row[]): MemoryDb {
  const db = memoryDb(
    {
      knowledge_sources: sources,
      organizations: [
        { id: "org-a", plan_status: "active", plan_version_id: "pv-1" },
        { id: "org-b", plan_status: "active", plan_version_id: "pv-1" },
      ],
      plan_versions: [{ id: "pv-1", plan_id: "growth", limits: { pages: 2000 } }],
      platform_settings: [{ id: true, reader_primary: "tavily", reader_fallback_order: ["tavily", "firecrawl", "own"], map_engine: "own", day0_page_limit: 15 }],
    },
    {
      reader_try_spend: () => ({ data: false, error: null }),
      firecrawl_try_spend: () => ({ data: false, error: null }),
    },
  );
  h.db = db;
  return db;
}

/**
 * A client that holds this run's next query, right after its read is over
 * (the "embed" stage), until `until` resolves — so two runs can be lined up
 * exactly where the old shared forget data could be overwritten.
 */
function pausedAfterRead(db: MemoryDb, onPause: () => void, until: Promise<void>) {
  let armed = false;
  const wrap = (target: object): object =>
    new Proxy(target, {
      get(t, prop) {
        const value = (t as Record<string | symbol, unknown>)[prop];
        if (prop === "then")
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            until.then(() => (value as (a: unknown, b: unknown) => unknown).call(t, res, rej));
        return typeof value === "function" ? (...args: unknown[]) => wrap((value as (...a: unknown[]) => object).apply(t, args)) : value;
      },
    });
  const base = db.supabase as unknown as Record<string, unknown>;
  const supabase = {
    ...base,
    from(name: string) {
      const query = (base["from"] as (n: string) => object)(name);
      if (!armed) return query;
      armed = false;
      return wrap(query);
    },
  } as unknown as SupabaseClient;
  const onStage = (stage: string) => {
    if (stage !== "embed") return;
    armed = true;
    onPause();
  };
  return { supabase, onStage };
}

beforeEach(() => {
  clearSafeFetchDnsCache();
  for (const k of ["TAVILY_API_KEY", "FIRECRAWL_API_KEY"]) delete process.env[k];
});
afterEach(() => vi.unstubAllGlobals());

describe("1. two website reads at once", () => {
  const site: Record<string, string> = {
    "/": page("Home", ["a", "b", "c", "d", "e"].map((p) => `<a href="/${p}">${p}</a>`).join("")),
    "/a": page("Page a"),
    "/b": page("Page b"),
    "/c": page("Page c"),
    "/d": page("Page d"),
    "/e": page("Page e"),
  };
  const refs = (db: MemoryDb, sourceId: string) =>
    db
      .rows("knowledge_documents")
      .filter((d) => d["source_id"] === sourceId)
      .map((d) => String(d["source_ref"]))
      .sort();

  it("keep each other's pages: workspace A's forget never uses workspace B's site map", async () => {
    stubSite(site);
    // Two workspaces read the same shop: A the whole site, B five listed links.
    const db = world([
      { id: "a", organization_id: "org-a", type: "website", name: "shop.example", status: "syncing", config: { url: "https://shop.example/", mode: "full" } },
      {
        id: "b",
        organization_id: "org-b",
        type: "website",
        name: "shop.example",
        status: "syncing",
        config: { url: "https://shop.example/", mode: "full", discovery: "links", links: ["/", "/a", "/b", "/c", "/d"].map((p) => `https://shop.example${p}`) },
      },
    ]);
    const deadlineAt = Date.now() + 90_000;
    let releaseA!: () => void;
    let releaseB!: () => void;
    const aGate = new Promise<void>((r) => (releaseA = r));
    const bGate = new Promise<void>((r) => (releaseB = r));
    // B's read finishes while A sits between its read and its forget step;
    // A then forgets, and only after that does B.
    const b = pausedAfterRead(db, () => releaseA(), bGate);
    let runB: Promise<{ ok: boolean; error?: string }> | null = null;
    const a = pausedAfterRead(
      db,
      () => {
        runB = syncSource(b.supabase, "b", { onStage: b.onStage, preserveError: true, deadlineAt });
      },
      aGate,
    );
    const resultA = await syncSource(a.supabase, "a", { onStage: a.onStage, preserveError: true, deadlineAt });
    releaseB();
    const resultB = await runB!;
    expect(resultA.error ?? null).toBeNull();
    expect(resultB.error ?? null).toBeNull();

    const all = ["/", "/a", "/b", "/c", "/d", "/e"].map((p) => `https://shop.example${p}`).sort();
    // A read /e itself and it is still on the site: it stays.
    expect(refs(db, "a")).toEqual(all);
    expect(refs(db, "b")).toEqual(all.filter((u) => !u.endsWith("/e")));
    // Nothing was forgotten or skipped against the wrong map.
    expect(db.rows("activity_log").filter((r) => r["action"] === "reading_forget_skipped")).toEqual([]);
  });

  it("a read's own forget still works: a page that is gone is forgotten", async () => {
    stubSite(site);
    const db = world([{ id: "a", organization_id: "org-a", type: "website", name: "shop.example", status: "syncing", config: { url: "https://shop.example/", mode: "full" } }]);
    // Six pages already held, one of which (/old) is gone and on no map.
    const held = ["/", "/a", "/b", "/c", "/d", "/old"];
    for (const [i, p] of held.entries())
      db.rows("knowledge_documents").push({ id: `doc-${i}`, organization_id: "org-a", source_id: "a", source_ref: `https://shop.example${p}`, title: p, content: `old ${p}`, metadata: {} });
    const result = await syncSource(db.supabase, "a", { preserveError: true, deadlineAt: Date.now() + 90_000 });
    expect(result.error ?? null).toBeNull();
    expect(refs(db, "a")).not.toContain("https://shop.example/old");
    expect(refs(db, "a")).toContain("https://shop.example/e");
  });
});

describe("4. a read that dies is recovered by the stall reset", () => {
  it("syncSource records the start time; ten minutes later resetStaleReads puts the source back in the queue", async () => {
    const db = world([{ id: "qa", organization_id: "org-a", type: "manual_qa", name: "Answers", status: "ready", sync_started_at: null, config: {} }]);
    // The process dies mid-read: the documents query never answers.
    const base = db.supabase as unknown as Record<string, unknown>;
    const dying = {
      ...base,
      from(name: string) {
        const query = (base["from"] as (n: string) => Record<string, unknown>)(name);
        if (name !== "knowledge_documents") return query;
        return new Proxy(query, {
          get(t, prop) {
            if (prop === "then") return () => new Promise(() => {});
            const value = t[prop as string];
            return typeof value === "function" ? (...args: unknown[]) => ((value as (...a: unknown[]) => unknown).apply(t, args), new Proxy(t, this)) : value;
          },
        });
      },
    } as unknown as SupabaseClient;
    void syncSource(dying, "qa");
    const row = db.rows("knowledge_sources")[0]!;
    for (let i = 0; i < 50 && row["status"] !== "syncing"; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(row["status"]).toBe("syncing");
    expect(typeof row["sync_started_at"]).toBe("string");

    // Not stale yet: left alone.
    expect(await resetStaleReads(db.supabase, Date.now() + 60_000)).toBe(0);
    expect(row["status"]).toBe("syncing");
    // Past the stall window: back in the queue for the worker.
    expect(await resetStaleReads(db.supabase, Date.now() + STALE_SYNC_MS + 60_000)).toBe(1);
    expect(row).toMatchObject({ status: "pending", sync_started_at: null });
    expect(typeof row["queued_at"]).toBe("string");
  });
});
