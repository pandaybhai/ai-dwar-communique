import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type MemoryDb, type Row } from "./test-support/memory-db";

/**
 * Batch 76 — every /start and /demo lead mirrored into AiDwar's own workspace
 * (the org of the platform WhatsApp number): one contact per number, tag
 * "AiDwar lead", attributes, one note, opt-in untouched, nothing sent.
 * Fakes only (in-memory database, recording senders); nothing reaches a live
 * database, WhatsApp or Meta.
 */

const h = vi.hoisted(() => ({
  db: null as null | { supabase: unknown },
  sends: [] as string[],
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.db!.supabase }));
// Any send at all would be recorded here — the mirror must never reach one.
vi.mock("@/lib/campaigns.server", () => ({
  loadSenderContext: async () => {
    h.sends.push("loadSenderContext");
    return null;
  },
  sendCampaignTemplate: async () => {
    h.sends.push("template");
    return { messageId: null, error: "no" };
  },
}));
vi.mock("@/lib/service-text.server", () => ({
  sendServiceText: async () => {
    h.sends.push("text");
    return { ok: false };
  },
}));
vi.mock("@/lib/meta-capi.server", () => ({
  queueMetaEvent: async () => {
    h.sends.push("meta");
  },
}));

import {
  LEAD_TAG,
  backfillLeadMirror,
  catchUpLeadMirror,
  leadMirrorOrg,
  mirrorLead,
} from "./lead-mirror.server";

const ORG = "org-aidwar";
const NOW = Date.parse("2026-11-12T12:00:00Z");
const MIN = 60 * 1000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function lead(id: string, over: Row = {}): Row {
  return {
    id,
    source: "landing_start",
    is_test: false,
    name: "Asha Rao",
    phone: "+919812345670",
    status: "new",
    business_type: null,
    created_at: ago(1 * MIN),
    qualification: {},
    linked_user_id: null,
    organization_id: null,
    mirrored_at: null,
    ...over,
  };
}

function world(opts: { leads?: Row[]; contacts?: Row[]; tags?: Row[] } = {}): MemoryDb {
  const db = memoryDb({
    demo_leads: opts.leads ?? [lead("lead-1")],
    platform_settings: [{ id: 1, onboarding_whatsapp_account_id: "acct-aidwar" }],
    whatsapp_accounts: [{ id: "acct-aidwar", organization_id: ORG }],
    contacts: opts.contacts ?? [],
    tags: opts.tags ?? [],
    contact_tags: [],
    contact_notes: [],
    messages: [],
    profiles: [],
    demo_lead_notes: [],
    activity_log: [],
  });
  h.db = { supabase: db.supabase };
  return db;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  h.sends = [];
});
afterEach(() => vi.restoreAllMocks());

const contactsOf = (w: MemoryDb) => w.rows("contacts").filter((c) => c["organization_id"] === ORG);

describe("mirroring a lead into AiDwar's workspace", () => {
  it("finds the workspace through the platform number, never a fixed id", async () => {
    const w = world();
    expect(await leadMirrorOrg(w.supabase as never)).toBe(ORG);
    (w.rows("platform_settings")[0] as Row)["onboarding_whatsapp_account_id"] = null;
    expect(await leadMirrorOrg(w.supabase as never)).toBeNull();
    expect(await mirrorLead(w.supabase as never, "lead-1", { now: NOW })).toEqual({
      ok: false,
      skipped: "no_platform_org",
    });
    expect(w.rows("contacts")).toHaveLength(0);
    const src = readFileSync("src/lib/lead-mirror.server.ts", "utf8");
    expect(src).not.toMatch(/75aed2f5/);
  });

  it("creates one contact with the tag and attributes; opt-in left alone; the note waits for the answers", async () => {
    const w = world();
    const out = await mirrorLead(w.supabase as never, "lead-1", { now: NOW });
    expect(out).toMatchObject({ ok: true, created: true, noted: false });
    const [c] = contactsOf(w);
    expect(contactsOf(w)).toHaveLength(1);
    expect(c).toMatchObject({
      phone: "+919812345670",
      wa_id: "919812345670",
      name: "Asha Rao",
      source: "website",
      attributes: {
        lead_source: "/start",
        lead_status: "new",
        signed_up: false,
        lead_created_at: ago(1 * MIN),
      },
    });
    expect(c!["opt_in_status"]).toBeUndefined(); // the column's own default ("unknown")
    expect(c!["attributes"]).not.toHaveProperty("sells");
    const tags = w.rows("tags");
    expect(tags).toEqual([expect.objectContaining({ organization_id: ORG, name: LEAD_TAG })]);
    expect(w.rows("contact_tags")).toEqual([
      expect.objectContaining({
        contact_id: c!["id"],
        tag_id: tags[0]!["id"],
        organization_id: ORG,
      }),
    ]);
    expect(w.rows("contact_notes")).toHaveLength(0);
    expect(w.rows("demo_leads")[0]!["mirrored_at"]).toBeNull();

    // The questions are answered: attributes updated, the note written once.
    (w.rows("demo_leads")[0] as Row)["qualification"] = {
      sells: "jewellery",
      customers: "500_5000",
      answered_at: ago(10 * 1000),
    };
    expect(await mirrorLead(w.supabase as never, "lead-1", { now: NOW })).toMatchObject({
      ok: true,
      created: false,
      noted: true,
    });
    expect(contactsOf(w)).toHaveLength(1);
    expect(contactsOf(w)[0]!["attributes"]).toMatchObject({
      sells: "Jewellery",
      customers: "500–5,000",
    });
    expect(w.rows("contact_notes")).toEqual([
      expect.objectContaining({
        organization_id: ORG,
        contact_id: c!["id"],
        author_id: null,
        body: "Lead from /start: sells Jewellery, customers 500–5,000",
      }),
    ]);

    // Again and again: nothing doubles.
    await mirrorLead(w.supabase as never, "lead-1", { now: NOW + MIN });
    await mirrorLead(w.supabase as never, "lead-1", { now: NOW + 2 * MIN });
    expect(contactsOf(w)).toHaveLength(1);
    expect(w.rows("tags")).toHaveLength(1);
    expect(w.rows("contact_tags")).toHaveLength(1);
    expect(w.rows("contact_notes")).toHaveLength(1);
    expect(h.sends).toEqual([]);
    expect(w.rows("messages")).toHaveLength(0);
  });

  it("someone who already messaged Aiden is updated, never duplicated; their opt-in, name and own attributes stay", async () => {
    for (const status of ["opted_out", "opted_in", "unknown"]) {
      const w = world({
        contacts: [
          {
            id: "c-aiden",
            organization_id: ORG,
            phone: "+919812345670",
            wa_id: "919812345670",
            name: "Asha (WhatsApp)",
            opt_in_status: status,
            attributes: { city: "Pune" },
            source: "direct",
          },
          // Same number in another workspace: never touched.
          { id: "c-other", organization_id: "org-x", phone: "+919812345670", attributes: {} },
        ],
        tags: [{ id: "t-1", organization_id: ORG, name: LEAD_TAG }],
      });
      const out = await mirrorLead(w.supabase as never, "lead-1", { now: NOW });
      expect(out).toMatchObject({ ok: true, contactId: "c-aiden", created: false });
      expect(contactsOf(w)).toHaveLength(1);
      const c = contactsOf(w)[0]!;
      expect(c["opt_in_status"]).toBe(status);
      expect(c["name"]).toBe("Asha (WhatsApp)");
      expect(c["source"]).toBe("direct");
      expect(c["attributes"]).toMatchObject({ city: "Pune", lead_source: "/start" });
      expect(w.rows("tags")).toHaveLength(1); // the existing tag is reused
      expect(w.rows("contact_tags")).toEqual([expect.objectContaining({ tag_id: "t-1" })]);
      expect(w.rows("contacts").find((r) => r["id"] === "c-other")!["attributes"]).toEqual({});
    }
    expect(h.sends).toEqual([]);
  });

  it("a number typed differently on the form still lands on the same contact", async () => {
    const w = world({
      leads: [lead("lead-1", { phone: "+91 98123-45670" })],
      contacts: [{ id: "c-1", organization_id: ORG, phone: "+919812345670", attributes: {} }],
    });
    await mirrorLead(w.supabase as never, "lead-1", { now: NOW });
    expect(contactsOf(w)).toHaveLength(1);
  });

  it("signing up and a status change update the attributes", async () => {
    const w = world();
    await mirrorLead(w.supabase as never, "lead-1", { now: NOW });
    const row = w.rows("demo_leads")[0] as Row;
    row["linked_user_id"] = "user-1";
    row["status"] = "contacted";
    await mirrorLead(w.supabase as never, "lead-1", { now: NOW });
    expect(contactsOf(w)[0]!["attributes"]).toMatchObject({
      signed_up: true,
      lead_status: "contacted",
    });
  });

  it("a /demo lead gets its note at once, with its business type as 'sells'", async () => {
    const w = world({
      leads: [
        lead("demo-1", { source: "landing", business_type: "services", qualification: null }),
      ],
    });
    expect(await mirrorLead(w.supabase as never, "demo-1", { now: NOW })).toMatchObject({
      noted: true,
    });
    expect(contactsOf(w)[0]!["attributes"]).toMatchObject({
      lead_source: "/demo",
      sells: "Services / appointments",
    });
    expect(w.rows("contact_notes")[0]!["body"]).toBe(
      "Lead from /demo: sells Services / appointments, customers —",
    );
  });

  it("test leads and other sources are never mirrored", async () => {
    const w = world({
      leads: [lead("t", { is_test: true }), lead("x", { source: "signup" })],
    });
    expect((await mirrorLead(w.supabase as never, "t", { now: NOW })).ok).toBe(false);
    expect((await mirrorLead(w.supabase as never, "x", { now: NOW })).ok).toBe(false);
    expect(w.rows("contacts")).toHaveLength(0);
  });

  it("the minute worker writes the note once the 3-minute wait is over", async () => {
    const w = world();
    expect(await catchUpLeadMirror(w.supabase as never, { now: NOW })).toEqual({
      mirrored: 0,
      skipped: null,
    });
    expect(await catchUpLeadMirror(w.supabase as never, { now: NOW + 3 * MIN })).toEqual({
      mirrored: 1,
      skipped: null,
    });
    expect(w.rows("contact_notes")[0]!["body"]).toBe("Lead from /start: sells —, customers —");
    expect(await catchUpLeadMirror(w.supabase as never, { now: NOW + 4 * MIN })).toEqual({
      mirrored: 0,
      skipped: null,
    });
    expect(w.rows("contact_notes")).toHaveLength(1);
  });

  it("the backfill is idempotent: one contact per number, one note per lead, nothing sent", async () => {
    const w = world({
      leads: [
        lead("old-1", { created_at: ago(30 * 24 * 60 * MIN), status: "won" }),
        lead("old-2", {
          created_at: ago(20 * 24 * 60 * MIN),
          phone: "+919123456780",
          name: "Ravi",
          linked_user_id: "u-2",
        }),
        // The same person again, a week later: same contact, its own note.
        lead("old-3", { created_at: ago(7 * 24 * 60 * MIN), status: "contacted" }),
        lead("test", { created_at: ago(9 * 24 * 60 * MIN), is_test: true }),
      ],
      contacts: [
        {
          id: "c-aiden",
          organization_id: ORG,
          phone: "+919123456780",
          opt_in_status: "opted_out",
          attributes: {},
        },
      ],
    });
    const first = await backfillLeadMirror(w.supabase as never, { now: NOW });
    expect(first).toEqual({ ok: true, mirrored: 3, failed: 0, remaining: 0 });
    expect(contactsOf(w)).toHaveLength(2);
    expect(w.rows("contact_notes")).toHaveLength(3);
    expect(w.rows("contact_tags")).toHaveLength(2);
    const ravi = contactsOf(w).find((c) => c["id"] === "c-aiden")!;
    expect(ravi["opt_in_status"]).toBe("opted_out");
    expect(ravi["attributes"]).toMatchObject({ signed_up: true });
    // Asha's later lead wins the attributes (contacted, a week ago).
    const asha = contactsOf(w).find((c) => c["phone"] === "+919812345670")!;
    expect(asha["attributes"]).toMatchObject({ lead_status: "contacted" });

    const again = await backfillLeadMirror(w.supabase as never, { now: NOW + MIN });
    expect(again).toEqual({ ok: true, mirrored: 0, failed: 0, remaining: 0 });
    expect(contactsOf(w)).toHaveLength(2);
    expect(w.rows("contact_notes")).toHaveLength(3);
    expect(w.rows("contact_tags")).toHaveLength(2);
    expect(h.sends).toEqual([]);
    expect(w.rows("messages")).toHaveLength(0);
  });

  it("is called when a lead arrives, is answered, signs up and changes status, and from the worker; sends nothing", () => {
    const read = (p: string) => readFileSync(p, "utf8");
    for (const p of [
      "src/routes/api/public/demo-leads.ts",
      "src/routes/api/public/start-qualify.ts",
      "src/routes/api/public/start-link.ts",
      "src/routes/api/admin/leads.ts",
      "src/lib/start-reminders.server.ts",
    ]) {
      expect(read(p)).toContain("await mirrorLead(");
    }
    expect(read("src/routes/api/admin/leads.ts")).toContain('body["action"] === "mirror_backfill"');
    expect(read("src/routes/api/internal/knowledge-worker.ts")).toContain(
      "lead_mirror: leadMirror",
    );
    const src = read("src/lib/lead-mirror.server.ts");
    expect(src).not.toMatch(/sendCampaignTemplate|sendServiceText|queueMetaEvent|opt_in_status:/);
  });
});

describe("the backfill endpoint", () => {
  it("is super admin only", async () => {
    const w = world({ leads: [lead("old-1", { created_at: ago(9 * 24 * 60 * MIN) })] });
    w.rows("profiles").push(
      { id: "boss", is_super_admin: true },
      { id: "member", is_super_admin: false },
    );
    Object.assign(w.supabase as object, {
      auth: { getUser: async (token: string) => ({ data: { user: { id: token } } }) },
    });
    const { Route } = await import("@/routes/api/admin/leads");
    const post = (
      Route.options as unknown as {
        server: { handlers: { POST: (a: { request: Request }) => Promise<Response> } };
      }
    ).server.handlers.POST;
    const call = (token: string) =>
      post({
        request: new Request("http://x/api/admin/leads", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ action: "mirror_backfill" }),
        }),
      });
    expect((await call("member")).status).toBe(403);
    expect(w.rows("contacts")).toHaveLength(0);
    const res = await call("boss");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mirrored: 1, failed: 0, remaining: 0 });
    expect(contactsOf(w)).toHaveLength(1);
  });
});
