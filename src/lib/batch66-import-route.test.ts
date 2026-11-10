import { describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";

/**
 * Batch 66 — /api/contacts/import's chunk applies the one phone rule itself
 * (an older app, or any caller, may send a 10-digit number): 9908109123 is
 * saved as +919908109123 with wa_id 919908109123, never as +9908109123; a
 * workspace whose default code is 1 saves 4155550123 as +14155550123; 12345
 * is skipped with its reason. A chunk of full numbers doesn't read the
 * default at all. Fakes only.
 */

const h = vi.hoisted(() => ({
  db: null as null | ReturnType<typeof import("./test-support/fake-db").fakeDb>,
}));
vi.mock("@/lib/whatsapp-api.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp-api.server")>()),
  requireOrgMember: async () => ({
    supabase: h.db!.supabase,
    organizationId: "org66",
    userId: "u66",
    role: "admin",
  }),
  requirePermission: async () => null,
  logServerActivity: async () => {},
}));
vi.mock("@/lib/events.server", () => {
  const noop = async () => {};
  return { emitEvent: noop, recordUsage: noop, emitEvents: noop, recordUsages: noop };
});

import { Route as ImportRoute } from "../routes/api/contacts/import";

type Post = (a: { request: Request }) => Promise<Response>;
const post = (ImportRoute as unknown as { options: { server: { handlers: { POST: Post } } } })
  .options.server.handlers.POST;

function world(defaultCode: string | undefined) {
  let seq = 0;
  const db = fakeDb((op: FakeOp) => {
    if (op.table === "organizations" && op.kind === "select")
      return {
        data: defaultCode === undefined ? null : { default_country_code: defaultCode },
        error: null,
      };
    if (op.table === "contacts" && op.kind === "select") return { data: null, error: null };
    if (op.table === "contacts" && op.kind === "insert")
      return { data: { id: `c-${(seq += 1)}` }, error: null };
    return undefined;
  });
  h.db = db;
  return db;
}

async function chunk(rows: Array<{ row_number: number; phone: string }>) {
  const res = await post({
    request: new Request("http://x/api/contacts/import", {
      method: "POST",
      body: JSON.stringify({
        organization_id: "org66",
        action: "chunk",
        import_id: "imp66",
        consent: false,
        rows: rows.map((r) => ({ ...r, name: "", tags: [], attributes: {} })),
      }),
    }),
  });
  return (await res.json()) as { created: number; errors: Array<{ row: number; reason: string }> };
}

const inserted = (db: ReturnType<typeof world>) =>
  db.ops
    .filter((o) => o.table === "contacts" && o.kind === "insert")
    .map((o) => {
      const p = o.payload as { phone: string; wa_id: string };
      return [p.phone, p.wa_id];
    });

describe("the import chunk on the server", () => {
  it("10-digit, trunk-0 and spaced numbers are saved with +91; 12345 is skipped with why", async () => {
    const db = world(undefined); // 20261360 not applied: reads 91
    const out = await chunk([
      { row_number: 2, phone: "9908109123" },
      { row_number: 3, phone: "09812345678" },
      { row_number: 4, phone: "99081 09124" },
      { row_number: 5, phone: "+919876543210" },
      { row_number: 6, phone: "12345" },
    ]);
    expect(inserted(db)).toEqual([
      ["+919908109123", "919908109123"],
      ["+919812345678", "919812345678"],
      ["+919908109124", "919908109124"],
      ["+919876543210", "919876543210"],
    ]);
    expect(out.errors).toEqual([
      { row: 6, phone: "12345", reason: "Too short: needs 10 digits, or + and the country code" },
    ]);
  });

  it("a workspace with default code 1 saves 4155550123 as +14155550123", async () => {
    const db = world("1");
    await chunk([{ row_number: 2, phone: "4155550123" }]);
    expect(inserted(db)).toEqual([["+14155550123", "14155550123"]]);
  });

  it("a chunk of full numbers doesn't read the default code (no extra read)", async () => {
    const db = world("91");
    await chunk([
      { row_number: 2, phone: "+919908109123" },
      { row_number: 3, phone: "919812345678" },
    ]);
    expect(db.ops.some((o) => o.table === "organizations")).toBe(false);
    expect(inserted(db).map(([p]) => p)).toEqual(["+919908109123", "+919812345678"]);
  });
});
