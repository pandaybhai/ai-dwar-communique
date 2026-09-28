import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fakeDb } from "./test-support/fake-db";

const { embedTexts } = vi.hoisted(() => ({ embedTexts: vi.fn(async (chunks: string[] = []) => chunks.map(() => [0.1, 0.2])) }));
vi.mock("@/lib/ai-run.server", () => ({ embedTexts, EMBEDDING_MODEL: "test-model" }));
vi.mock("@/lib/product-extract.server", () => ({}));
vi.mock("@/lib/web-reader.server", () => ({ READER_COST: 0 }));
vi.mock("@/lib/firecrawl.server", () => ({}));
vi.mock("@/lib/whatsapp-api.server", () => ({ logServerActivity: async () => {} }));

import { replaceChunks, retryPendingEmbeddings } from "./knowledge.server";
import { emailTeamRecipients } from "./flow-engine.server";

beforeEach(() => embedTexts.mockClear());

describe("knowledge chunks are replaced, never emptied (item 7)", () => {
  const doc = { id: "doc-1", organization_id: "org", source_id: "src", source_ref: "https://shop.in/faq", content: "We deliver in 3 days. ".repeat(40), content_hash: "h", metadata: { needs_embedding: true } };
  const world = (rpcError: { code?: string; message: string } | null) =>
    fakeDb((op) => (op.table === "knowledge_documents" && op.kind === "select" ? { data: [doc], error: null } : undefined), (c) =>
      c.name === "replace_knowledge_chunks" ? { data: 1, error: rpcError } : undefined,
    );
  const chunkWrites = (db: ReturnType<typeof world>) => db.ops.filter((o) => o.table === "knowledge_chunks");

  it("a failed embedding leaves the page's old chunks in place", async () => {
    embedTexts.mockRejectedValueOnce(new Error("embedding service down"));
    const db = world(null);
    expect(await retryPendingEmbeddings(db.supabase)).toEqual({ tried: 1, built: 0 });
    expect(chunkWrites(db)).toEqual([]);
    expect(db.rpcs).toEqual([]);
  });

  it("new chunks are built first, then swapped in with one call", async () => {
    const db = world(null);
    expect(await retryPendingEmbeddings(db.supabase)).toEqual({ tried: 1, built: 1 });
    expect(chunkWrites(db)).toEqual([]);
    expect(db.rpcs).toHaveLength(1);
    expect(db.rpcs[0]!.args["p_document_id"]).toBe("doc-1");
    expect((db.rpcs[0]!.args["p_rows"] as unknown[]).length).toBeGreaterThan(0);
  });

  it("a failed swap keeps the old chunks and queues a retry", async () => {
    const db = world({ code: "23505", message: "boom" });
    expect(await retryPendingEmbeddings(db.supabase)).toEqual({ tried: 1, built: 0 });
    expect(chunkWrites(db)).toEqual([]);
    const retry = db.ops.find((o) => o.table === "knowledge_documents" && o.kind === "update")!;
    expect((retry.payload as { metadata: Record<string, unknown> }).metadata["needs_embedding"]).toBe(true);
  });

  it("unchanged until the migration is applied: falls back to delete + insert", async () => {
    const db = fakeDb(() => undefined, () => ({ data: null, error: { code: "PGRST202", message: "not found" } }));
    const row = { organization_id: "org", source_id: "src", document_id: "doc-1", source_ref: "r", chunk_index: 0, text: "t", embedding: "[0.1]", embedding_model: "m", dimensions: 1 };
    expect(await replaceChunks(db.supabase, "doc-1", [row])).toEqual({ error: null });
    expect(db.ops.map((o) => `${o.table}:${o.kind}`)).toEqual(["knowledge_chunks:delete", "knowledge_chunks:insert"]);
  });
});

describe("email step: members only, max 5 (item 5)", () => {
  const db = () =>
    fakeDb((op) => {
      if (op.table === "organization_members") return { data: ["u1", "u2", "u3", "u4", "u5", "u6"].map((user_id) => ({ user_id })), error: null };
      if (op.table === "profiles") return { data: ["u1", "u2", "u3", "u4", "u5", "u6"].map((id) => ({ id, email: `${id}@shop.in` })), error: null };
      return undefined;
    });

  it("typed addresses that aren't workspace members are dropped", async () => {
    const out = await emailTeamRecipients(db().supabase, "org", { user_ids: ["u1"], addresses: "U2@shop.in, stranger@gmail.com" });
    expect(out).toEqual({ recipients: ["u1@shop.in", "u2@shop.in"], dropped: 1 });
  });

  it("teammates from another workspace are dropped", async () => {
    expect(await emailTeamRecipients(db().supabase, "org", { user_ids: ["u1", "not-a-member"] })).toEqual({ recipients: ["u1@shop.in"], dropped: 1 });
  });

  it("never more than 5", async () => {
    const out = await emailTeamRecipients(db().supabase, "org", { user_ids: ["u1", "u2", "u3", "u4", "u5", "u6"] });
    expect(out.recipients).toHaveLength(5);
    expect(out.dropped).toBe(1);
  });
});

describe("migrations are re-runnable (item 10) and new ones idempotent with RLS", () => {
  const sql = (f: string) => readFileSync(resolve(__dirname, "../../supabase/aidwar-migrations", f), "utf8");
  for (const file of ["20261006_flows_v2_live_fixes.sql", "20261007_flows_batch1_safety.sql"]) {
    it(`${file}: every CREATE is guarded`, () => {
      const s = sql(file);
      for (const m of s.matchAll(/CREATE POLICY "([^"]+)" ON ([\w.]+)/g))
        expect(s, m[1]).toContain(`DROP POLICY IF EXISTS "${m[1]}" ON ${m[2]}`);
      for (const m of s.matchAll(/CREATE TRIGGER (\w+) \w+ \w+ ON ([\w.]+)/g))
        expect(s, m[1]).toContain(`DROP TRIGGER IF EXISTS ${m[1]} ON ${m[2]}`);
      expect(s).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
      expect(s).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
      expect(s).not.toMatch(/CREATE FUNCTION/);
      expect(s).not.toMatch(/ADD COLUMN (?!IF NOT EXISTS)/);
    });
  }
  it("the new secrets table has RLS on and no client access", () => {
    const s = sql("20261007_flows_batch1_safety.sql");
    expect(s).toContain("ALTER TABLE public.flow_http_secrets ENABLE ROW LEVEL SECURITY");
    expect(s).toContain("REVOKE ALL ON public.flow_http_secrets FROM anon, authenticated");
    expect(s).not.toMatch(/GRANT [^;]* TO (anon|authenticated)/);
  });
});
