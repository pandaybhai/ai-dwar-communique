import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeDb, type FakeOp } from "./test-support/fake-db";

/**
 * Batch 36 — opted in by default on upload. Fakes only, never the live
 * database or WhatsApp.
 *  1. Import: the consent box is ticked by default; ticked opts in new and
 *     "unknown" contacts, unticked keeps "unknown", an opted-out contact never
 *     changes and is counted ("N contacts stayed opted out").
 *  2. Add contact / the drawer: opted in by default; unknown <-> opted in;
 *     an opt-out is never cleared by the merchant.
 *  3. Bulk: "Mark as opted in" skips opted-out and reports counts; "Mark all
 *     unknown as opted in" only touches unknown contacts.
 *  4. Every switch records opt_in_source + opted_in_at and an activity log
 *     entry with the user; before the migration the write still goes through.
 */

const h = vi.hoisted(() => ({
  db: null as null | ReturnType<typeof import("./test-support/fake-db").fakeDb>,
  denied: null as null | string,
}));

vi.mock("@/lib/whatsapp-api.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp-api.server")>()),
  requireOrgMember: async () => ({ supabase: h.db!.supabase, organizationId: "org36", userId: "u36", role: "agent" }),
  requirePermission: async (_auth: unknown, key: string) =>
    h.denied === key ? Response.json({ error: "You don't have permission." }, { status: 403 }) : null,
}));
vi.mock("@/lib/events.server", () => {
  const noop = async () => {};
  return { emitEvent: noop, recordUsage: noop, emitEvents: noop, recordUsages: noop };
});

import { Route as ImportRoute } from "../routes/api/contacts/import";
import { Route as OptInRoute } from "../routes/api/contacts/opt-in";
import { isMissingConsentColumn } from "./opt-in.server";

type Post = (a: { request: Request }) => Promise<Response>;
const postOf = (r: unknown) => (r as { options: { server: { handlers: { POST: Post } } } }).options.server.handlers.POST;
const call = (route: unknown, body: Record<string, unknown>) =>
  postOf(route)({
    request: new Request("http://x/api", { method: "POST", body: JSON.stringify({ organization_id: "org36", ...body }) }),
  });

type Row = { id: string; phone: string; opt_in_status: string; name?: string | null; attributes?: Record<string, unknown> };

/** A tiny contacts table behind the fake query builder. */
function world(rows: Row[], opts: { noConsentColumns?: boolean } = {}) {
  const contacts = new Map(rows.map((r) => [r.id, { organization_id: "org36", ...r } as Record<string, unknown>]));
  let seq = 0;
  const filter = (op: FakeOp) =>
    [...contacts.values()].filter((c) =>
      op.filters.every(([f, a]) => {
        if (f === "eq") return c[a[0] as string] === a[1];
        if (f === "in") return (a[1] as unknown[]).includes(c[a[0] as string]);
        return true;
      }),
    );
  const missing = (payload: unknown) =>
    opts.noConsentColumns &&
    payload &&
    typeof payload === "object" &&
    ("opt_in_source" in (payload as object) || "opted_in_at" in (payload as object));
  const db = fakeDb((op) => {
    if (op.table === "contact_imports" && op.kind === "insert") return { data: { id: "imp1" }, error: null };
    if (op.table !== "contacts") return undefined;
    if ((op.kind === "update" || op.kind === "insert") && missing(op.payload))
      return {
        data: null,
        error: { code: "PGRST204", message: "Could not find the 'opt_in_source' column of 'contacts' in the schema cache" },
      };
    if (op.kind === "select") {
      const hit = filter(op);
      const single = op.filters.some(([f]) => f === "maybeSingle" || f === "single");
      return { data: single ? (hit[0] ?? null) : hit, error: null };
    }
    if (op.kind === "update") {
      const hit = filter(op);
      for (const c of hit) Object.assign(c, op.payload as object);
      return { data: null, error: null, count: hit.length };
    }
    if (op.kind === "insert") {
      const id = `new-${(seq += 1)}`;
      contacts.set(id, { id, ...(op.payload as object) });
      return { data: { id }, error: null };
    }
    return undefined;
  });
  h.db = db;
  const activity = () =>
    db.ops.filter((o) => o.table.startsWith("activity") && o.kind === "insert").map((o) => o.payload as Record<string, unknown>);
  const byPhone = (phone: string) => [...contacts.values()].find((c) => c["phone"] === phone);
  return { ...db, contacts, activity, byPhone };
}

beforeEach(() => {
  h.denied = null;
});

const FILE = [
  { row_number: 2, phone: "+919800000001", name: "New One" },
  { row_number: 3, phone: "+919800000002", name: "Was Unknown" },
  { row_number: 4, phone: "+919800000003", name: "Said STOP" },
  { row_number: 5, phone: "+919800000004", name: "Already In" },
];
const EXISTING: Row[] = [
  { id: "c-unknown", phone: "+919800000002", opt_in_status: "unknown" },
  { id: "c-out", phone: "+919800000003", opt_in_status: "opted_out" },
  { id: "c-in", phone: "+919800000004", opt_in_status: "opted_in" },
];

// ------------------------------------------------------------------ (1)
describe("(1) import: ticked by default, opted out always stays opted out", () => {
  it("ticked: new and unknown contacts are opted in with an import consent record", async () => {
    const w = world(EXISTING);
    const res = await call(ImportRoute, { action: "chunk", consent: true, import_id: "imp1", rows: FILE });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ created: 1, updated: 3, opted_in: 2, stayed_opted_out: 1 });

    const added = w.byPhone("+919800000001")!;
    expect(added["opt_in_status"]).toBe("opted_in");
    expect(added["opt_in_source"]).toBe("import");
    expect(typeof added["opted_in_at"]).toBe("string");

    const raised = w.contacts.get("c-unknown")!;
    expect(raised["opt_in_status"]).toBe("opted_in");
    expect(raised["opt_in_source"]).toBe("import");
  });

  it("an opted-out contact never changes, and an existing opt-in keeps its own record", async () => {
    const w = world(EXISTING);
    await call(ImportRoute, { action: "chunk", consent: true, import_id: "imp1", rows: FILE });
    const out = w.contacts.get("c-out")!;
    expect(out["opt_in_status"]).toBe("opted_out");
    expect(out["opt_in_source"]).toBeUndefined();
    expect(out["name"]).toBe("Said STOP"); // the rest of the row still updates
    const already = w.contacts.get("c-in")!;
    expect(already["opt_in_status"]).toBe("opted_in");
    expect(already["opt_in_source"]).toBeUndefined();
    expect(already["opted_in_at"]).toBeUndefined();
  });

  it("unticked: new contacts land unknown and unknown stays unknown, as before", async () => {
    const w = world(EXISTING);
    const res = await call(ImportRoute, { action: "chunk", consent: false, import_id: "imp1", rows: FILE });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ created: 1, updated: 3, opted_in: 0, stayed_opted_out: 1 });
    expect(w.byPhone("+919800000001")!["opt_in_status"]).toBe("unknown");
    expect(w.byPhone("+919800000001")!["opt_in_source"]).toBeUndefined();
    expect(w.contacts.get("c-unknown")!["opt_in_status"]).toBe("unknown");
    expect(w.contacts.get("c-out")!["opt_in_status"]).toBe("opted_out");
  });

  it("start no longer refuses an unticked import; the answer is logged with the user", async () => {
    const w = world([]);
    let res = await call(ImportRoute, { action: "start", consent: false, filename: "a.csv", total_rows: 3 });
    expect(res.status).toBe(200);
    res = await call(ImportRoute, { action: "start", consent: true, filename: "b.csv", total_rows: 3 });
    expect(res.status).toBe(200);
    const logs = w.activity().filter((a) => a["action"] === "contacts_import_consent");
    expect(logs.map((l) => (l["details"] as Record<string, unknown>)["attestation"])).toEqual([
      "not_confirmed",
      "opt_in_confirmed",
    ]);
    expect(logs.every((l) => l["user_id"] === "u36")).toBe(true);
  });

  it("before the migration is applied the import still opts in (retry without the consent columns)", async () => {
    const w = world(EXISTING, { noConsentColumns: true });
    const res = await call(ImportRoute, { action: "chunk", consent: true, import_id: "imp1", rows: FILE });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ created: 1, updated: 3, opted_in: 2, stayed_opted_out: 1, errors: [] });
    expect(w.byPhone("+919800000001")!["opt_in_status"]).toBe("opted_in");
    expect(w.contacts.get("c-unknown")!["opt_in_status"]).toBe("opted_in");
    expect(w.contacts.get("c-out")!["opt_in_status"]).toBe("opted_out");
  });
});

describe("(4) the missing-column answer is recognised, nothing else is", () => {
  it("PGRST204 on a consent column retries; any other error does not", () => {
    expect(
      isMissingConsentColumn({ code: "PGRST204", message: "Could not find the 'opted_in_at' column of 'contacts' in the schema cache" }),
    ).toBe(true);
    expect(isMissingConsentColumn({ code: "42703", message: 'column "opt_in_source" of relation "contacts" does not exist' })).toBe(true);
    expect(isMissingConsentColumn({ code: "23505", message: "duplicate key value" })).toBe(false);
    expect(isMissingConsentColumn({ code: "PGRST204", message: "Could not find the 'nickname' column" })).toBe(false);
    expect(isMissingConsentColumn(null)).toBe(false);
  });
});

// ------------------------------------------------------------------ (2)
describe("(2) Add contact and the drawer", () => {
  it("Add contact's box is ticked by default and opts the new contact in through the server", () => {
    const src = readFileSync(join(import.meta.dirname, "../components/contacts/add-contact-dialog.tsx"), "utf8");
    expect(src).toContain("const [optedIn, setOptedIn] = useState(true);");
    expect(src).toContain('"/api/contacts/opt-in"');
    expect(src).toContain('status: "opted_in"');
    // The insert itself never writes a status: unticked stays the column default, "unknown".
    expect(src).not.toMatch(/insert\(\{[^}]*opt_in_status/);
  });

  it("set opted_in: a new (unknown) contact becomes opted in with source manual and a log entry", async () => {
    const w = world([{ id: "c-new", phone: "+919800000010", opt_in_status: "unknown" }]);
    const res = await call(OptInRoute, { action: "set", contact_id: "c-new", status: "opted_in" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "opted_in", changed: true });
    const c = w.contacts.get("c-new")!;
    expect(c).toMatchObject({ opt_in_status: "opted_in", opt_in_source: "manual" });
    expect(typeof c["opted_in_at"]).toBe("string");
    const log = w.activity().find((a) => a["action"] === "contacts_opted_in")!;
    expect(log["user_id"]).toBe("u36");
    expect(log["details"]).toMatchObject({ source: "manual", changed: 1 });
  });

  it("the drawer switches opted_in back to unknown (consent record cleared, change logged)", async () => {
    const w = world([{ id: "c1", phone: "+919800000011", opt_in_status: "opted_in" }]);
    w.contacts.get("c1")!["opt_in_source"] = "import";
    const res = await call(OptInRoute, { action: "set", contact_id: "c1", status: "unknown" });
    expect(await res.json()).toEqual({ status: "unknown", changed: true });
    expect(w.contacts.get("c1")).toMatchObject({ opt_in_status: "unknown", opt_in_source: null, opted_in_at: null });
    const log = w.activity().find((a) => a["action"] === "optin_changed")!;
    expect(log["details"]).toMatchObject({ from: "opted_in", to: "unknown", source: "manual" });
    expect(log["user_id"]).toBe("u36");
  });

  it("an opted-out contact can't be switched by the merchant", async () => {
    const w = world([{ id: "c-out", phone: "+919800000012", opt_in_status: "opted_out" }]);
    for (const status of ["opted_in", "unknown"]) {
      const res = await call(OptInRoute, { action: "set", contact_id: "c-out", status });
      expect(res.status).toBe(409);
    }
    expect(w.contacts.get("c-out")!["opt_in_status"]).toBe("opted_out");
    expect(w.ops.some((o) => o.table === "contacts" && o.kind === "update")).toBe(false);
  });

  it("the drawer offers no choice for an opted-out contact and shows the consent record", async () => {
    const { drawerOptInChoices, consentLine } = await import("@/components/contacts/contact-drawer");
    expect(drawerOptInChoices("opted_out")).toEqual([]);
    expect(drawerOptInChoices("unknown")).toContain("opted_in");
    expect(drawerOptInChoices("opted_in")).toContain("unknown");
    expect(consentLine({ opt_in_source: "import", opted_in_at: "2026-10-28T10:00:00Z" })).toMatch(/^Opted in by an import on /);
    expect(consentLine(null)).toBeNull();
  });

  it("needs contacts.edit", async () => {
    world([{ id: "c1", phone: "+919800000013", opt_in_status: "unknown" }]);
    h.denied = "contacts.edit";
    const res = await call(OptInRoute, { action: "set", contact_id: "c1", status: "opted_in" });
    expect(res.status).toBe(403);
  });
});

// ------------------------------------------------------------------ (3)
describe("(3) bulk: Mark as opted in / Mark all unknown as opted in", () => {
  const LIST: Row[] = [
    { id: "a", phone: "+919800000021", opt_in_status: "unknown" },
    { id: "b", phone: "+919800000022", opt_in_status: "unknown" },
    { id: "c", phone: "+919800000023", opt_in_status: "opted_out" },
    { id: "d", phone: "+919800000024", opt_in_status: "opted_in" },
  ];

  it("selected: changes only unknown, skips opted out, reports the counts", async () => {
    const w = world(LIST);
    const res = await call(OptInRoute, { action: "bulk", contact_ids: ["a", "b", "c", "d"] });
    expect(await res.json()).toEqual({ changed: 2, skipped_opted_out: 1, already_opted_in: 1 });
    expect(w.contacts.get("a")).toMatchObject({ opt_in_status: "opted_in", opt_in_source: "bulk" });
    expect(w.contacts.get("b")).toMatchObject({ opt_in_status: "opted_in", opt_in_source: "bulk" });
    expect(w.contacts.get("c")!["opt_in_status"]).toBe("opted_out");
    expect(w.contacts.get("c")!["opt_in_source"]).toBeUndefined();
    expect(w.contacts.get("d")!["opt_in_source"]).toBeUndefined();
    // the write itself only matches rows still "unknown" (a STOP meanwhile wins)
    const upd = w.ops.find((o) => o.table === "contacts" && o.kind === "update")!;
    expect(w.has(upd, "eq", "opt_in_status", "unknown")).toBe(true);
    const log = w.activity().find((a) => a["action"] === "contacts_opted_in")!;
    expect(log["user_id"]).toBe("u36");
    expect(log["details"]).toMatchObject({ source: "bulk", scope: "selected", changed: 2, skipped_opted_out: 1 });
  });

  it("a STOP landing between the read and the write is counted as skipped, never overwritten", async () => {
    const w = world(LIST);
    const realFrom = w.supabase.from.bind(w.supabase);
    let reads = 0;
    (w.supabase as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      if (t === "contacts" && (reads += 1) === 2) w.contacts.get("a")!["opt_in_status"] = "opted_out";
      return realFrom(t);
    };
    const res = await call(OptInRoute, { action: "bulk", contact_ids: ["a", "b"] });
    expect(await res.json()).toEqual({ changed: 1, skipped_opted_out: 1, already_opted_in: 0 });
    expect(w.contacts.get("a")!["opt_in_status"]).toBe("opted_out");
  });

  it("all unknown: counts first, then changes every unknown contact and nothing else", async () => {
    const w = world(LIST);
    w.ops.length = 0;
    const counted = fakeDb((op) => (op.table === "contacts" ? { data: null, error: null, count: 2 } : undefined));
    h.db = counted;
    const c = await call(OptInRoute, { action: "count_unknown" });
    expect(await c.json()).toEqual({ count: 2 });
    const countOp = counted.ops[0]!;
    expect(counted.has(countOp, "eq", "opt_in_status", "unknown")).toBe(true);

    h.db = w;
    const res = await call(OptInRoute, { action: "all_unknown" });
    expect(await res.json()).toEqual({ changed: 2, skipped_opted_out: 0, already_opted_in: 0 });
    expect([...w.contacts.values()].map((x) => x["opt_in_status"])).toEqual(["opted_in", "opted_in", "opted_out", "opted_in"]);
    expect(w.contacts.get("a")!["opt_in_source"]).toBe("bulk");
    expect(w.contacts.get("d")!["opt_in_source"]).toBeUndefined();
    const log = w.activity().find((a) => a["action"] === "contacts_opted_in")!;
    expect(log["details"]).toMatchObject({ source: "bulk", scope: "all_unknown", changed: 2 });
  });

  it("before the migration: bulk still opts in (retry without the consent columns)", async () => {
    const w = world(LIST, { noConsentColumns: true });
    const res = await call(OptInRoute, { action: "bulk", contact_ids: ["a", "c"] });
    expect(await res.json()).toEqual({ changed: 1, skipped_opted_out: 1, already_opted_in: 0 });
    expect(w.contacts.get("a")!["opt_in_status"]).toBe("opted_in");
  });

  it("the result line names what changed and what was skipped", async () => {
    const { bulkOptInSummary } = await import("@/components/contacts/bulk-opt-in");
    expect(bulkOptInSummary({ changed: 12, skipped_opted_out: 3, already_opted_in: 2 })).toBe(
      "12 contacts marked opted in · 3 stayed opted out · 2 already opted in",
    );
    expect(bulkOptInSummary({ changed: 1, skipped_opted_out: 0, already_opted_in: 0 })).toBe("1 contact marked opted in");
  });

  it("refuses an empty or oversized selection", async () => {
    world(LIST);
    expect((await call(OptInRoute, { action: "bulk", contact_ids: [] })).status).toBe(400);
    const many = Array.from({ length: 1001 }, (_, i) => `id-${i}`);
    expect((await call(OptInRoute, { action: "bulk", contact_ids: many })).status).toBe(400);
  });
});
