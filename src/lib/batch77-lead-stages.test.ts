import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type MemoryDb, type Row } from "./test-support/memory-db";
import { pgAvailable, startScratchPg, type ScratchPg } from "./test-support/scratch-pg";

/**
 * Batch 77 — a lead's sales stage goes back to Meta (Conversions API): one
 * server event per lead per stage, the first time it is reached; nothing for
 * new / lost; the original Lead's matching (same external_id) plus the stored
 * fbc / fbp. Fakes only: the in-memory database, a stubbed fetch for Graph and
 * a fake token. Nothing reaches a live database or Meta.
 */

const h = vi.hoisted(() => ({ db: null as null | { supabase: unknown } }));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.db!.supabase }));
vi.mock("@/lib/billing-notify.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./billing-notify.server")>()),
  resolvePlatformOrg: async () => "org-platform",
}));

const FAKE_TOKEN = "EAAtest-not-a-real-token";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const LEAD = "3f2c9a1e-5b7d-4c11-9a2e-7d1f0c4b8e21";
type Graph = { url: string; body: Record<string, unknown> };

function world(lead: Row = {}): MemoryDb & { graph: Graph[] } {
  const graph: Graph[] = [];
  const db = memoryDb({
    demo_leads: [
      {
        id: LEAD,
        source: "landing_start",
        is_test: false,
        name: "Asha Rao",
        phone: "+919812345670",
        status: "new",
        created_at: "2026-11-12T10:00:00Z",
        qualification: { sells: "jewellery", customers: "500_5000", answered_at: "x" },
        linked_user_id: null,
        organization_id: null,
        meta_fbc: "fb.1.1794466925583.IwAR0abcdefghij",
        meta_fbp: "fb.1.1794466925000.987654321",
        meta_external_id: LEAD,
        meta_events_sent: {},
        ...lead,
      },
    ],
    activity_log: [],
    profiles: [
      { id: "boss", is_super_admin: true },
      { id: "u-1", full_name: "Asha Rao", phone: "+919812345670" },
    ],
    platform_settings: [{ id: 1, onboarding_whatsapp_account_id: null }],
    demo_lead_notes: [],
  });
  const users = new Map<string, Row>([
    ["boss", { id: "boss", email: "boss@example.com", user_metadata: {} }],
    ["u-1", { id: "u-1", email: "asha@example.com", user_metadata: {} }],
  ]);
  Object.assign(db.supabase as object, {
    auth: {
      getUser: async (token: string) => ({ data: { user: users.get(token) ?? null } }),
      admin: { getUserById: async (id: string) => ({ data: { user: users.get(id) ?? null } }) },
    },
  });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    graph.push({ url: String(url), body: JSON.parse(String(init.body ?? "{}")) });
    return new Response(JSON.stringify({ events_received: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  h.db = { supabase: db.supabase };
  return Object.assign(db, { graph, users });
}

type Handler = (a: { request: Request }) => Promise<Response>;
async function handler(path: string): Promise<Handler> {
  const mod = (await import(path)) as {
    Route: { options: { server: { handlers: Record<string, Handler> } } };
  };
  return mod.Route.options.server.handlers["POST"]!;
}
const setStatus = async (status: string) => {
  const POST = await handler("@/routes/api/admin/leads");
  return POST({
    request: new Request("https://aidwar.in/api/admin/leads", {
      method: "POST",
      headers: { authorization: "Bearer boss", "content-type": "application/json" },
      body: JSON.stringify({ lead_id: LEAD, status }),
    }),
  });
};
const events = (w: { graph: Graph[] }) => w.graph.map((g) => (g.body["data"] as Row[])[0]!);

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubEnv("META_CAPI_TOKEN", FAKE_TOKEN);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("lead stage → Meta", () => {
  it("each stage fires once, with its own event, id, action source and custom data", async () => {
    const w = world();
    for (const status of ["contacted", "qualified", "demo_booked", "won"]) {
      expect((await setStatus(status)).status).toBe(200);
    }
    expect(events(w).map((e) => [e["event_name"], e["event_id"], e["action_source"]])).toEqual([
      ["LeadContacted", `LeadContacted.${LEAD}`, "system_generated"],
      ["SalesQualifiedLead", `SalesQualifiedLead.${LEAD}`, "system_generated"],
      ["Schedule", `Schedule.${LEAD}`, "system_generated"],
      ["LeadWon", `LeadWon.${LEAD}`, "system_generated"],
    ]);
    expect(events(w)[0]!["custom_data"]).toEqual({
      lead_source: "landing_start",
      sells: "jewellery",
      customers: "500_5000",
      stage: "contacted",
    });
    expect(events(w)[3]!["custom_data"]).toMatchObject({ stage: "won" });
    for (const e of events(w)) expect(e).not.toHaveProperty("event_source_url");
    const sent = w.rows("demo_leads")[0]!["meta_events_sent"] as Row;
    expect(Object.keys(sent)).toEqual(["contacted", "qualified", "demo_booked", "won"]);
    expect(sent["contacted"]).toMatchObject({
      event: "LeadContacted",
      event_id: `LeadContacted.${LEAD}`,
    });
  });

  it("new and lost send nothing", async () => {
    const w = world({ status: "contacted" });
    await setStatus("lost");
    await setStatus("new");
    expect(w.graph).toEqual([]);
  });

  it("re-setting a stage never resends — also without the meta_events_sent column", async () => {
    const w = world();
    await setStatus("contacted");
    await setStatus("lost");
    await setStatus("contacted");
    expect(w.graph).toHaveLength(1);
    // 20261410 not applied: nothing stored on the lead, the once-marker holds.
    (w.rows("demo_leads")[0] as Row)["meta_events_sent"] = undefined;
    await setStatus("contacted");
    expect(w.graph).toHaveLength(1);
    const { sendLeadStageEvent } = await import("./lead-stage-events.server");
    (w.rows("demo_leads")[0] as Row)["meta_events_sent"] = undefined;
    expect(await sendLeadStageEvent(w.supabase as never, LEAD, "contacted")).toBe("already_sent");
    expect(w.graph).toHaveLength(1);
  });

  it("user_data is only hashes + the stored fbc/fbp; no IP, user agent or plain values", async () => {
    const w = world();
    await setStatus("qualified");
    expect(events(w)[0]!["user_data"]).toEqual({
      ph: [sha("919812345670")],
      fn: [sha("asha")],
      ln: [sha("rao")],
      external_id: [sha(LEAD)],
      country: [sha("in")],
      fbc: "fb.1.1794466925583.IwAR0abcdefghij",
      fbp: "fb.1.1794466925000.987654321",
    });
    const raw = JSON.stringify(w.graph[0]!.body);
    expect(raw).not.toMatch(/9812345670|Asha|Rao|boss@|client_ip|client_user_agent/);
    expect(w.graph[0]!.url).not.toContain(FAKE_TOKEN);
  });

  it("external_id is the original Lead's: /start submit → stored matching → stage event", async () => {
    const w = world();
    w.rows("demo_leads").splice(0); // a fresh lead from the form
    const submit = await handler("@/routes/api/public/demo-leads");
    await submit({
      request: new Request("https://aidwar.in/api/public/demo-leads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "Mozilla/5.0 test",
          "x-forwarded-for": "203.0.113.5",
          cookie: "_fbp=fb.1.1794466925000.987654321; sb-auth=secret",
          referer: "https://aidwar.in/start",
        },
        body: JSON.stringify({
          source: "landing_start",
          name: "Asha Rao",
          phone: "98123 45670",
          fbclid: "IwAR0abcdefghij",
          fbclid_at: 1794466925583,
        }),
      }),
    });
    const row = w.rows("demo_leads")[0]!;
    const id = String(row["id"]);
    // Stored: the fbc, the _fbp cookie, the external_id — never the IP or UA.
    expect(row).toMatchObject({
      meta_fbc: "fb.1.1794466925583.IwAR0abcdefghij",
      meta_fbp: "fb.1.1794466925000.987654321",
      meta_external_id: id.toLowerCase(),
    });
    expect(JSON.stringify(row)).not.toMatch(/203\.0\.113\.5|Mozilla|sb-auth/);
    const lead = events(w).find((e) => e["event_name"] === "Lead")!;

    const POST = await handler("@/routes/api/admin/leads");
    await POST({
      request: new Request("https://aidwar.in/api/admin/leads", {
        method: "POST",
        headers: { authorization: "Bearer boss", "content-type": "application/json" },
        body: JSON.stringify({ lead_id: id, status: "contacted" }),
      }),
    });
    const stage = events(w).find((e) => e["event_name"] === "LeadContacted")!;
    const lu = lead["user_data"] as Row;
    const su = stage["user_data"] as Row;
    expect(su["external_id"]).toEqual(lu["external_id"]);
    expect(su["ph"]).toEqual(lu["ph"]);
    expect(su["fbc"]).toBe(lu["fbc"]);
    expect(su["fbp"]).toBe("fb.1.1794466925000.987654321");
  });

  it("no _fbp cookie (no consent): none stored", async () => {
    const w = world();
    w.rows("demo_leads").splice(0);
    const submit = await handler("@/routes/api/public/demo-leads");
    await submit({
      request: new Request("https://aidwar.in/api/public/demo-leads", {
        method: "POST",
        headers: { "content-type": "application/json", referer: "https://aidwar.in/start" },
        body: JSON.stringify({ source: "landing_start", name: "Asha", phone: "98123 45670" }),
      }),
    });
    expect(w.rows("demo_leads")[0]).toMatchObject({ meta_fbc: null, meta_fbp: null });
  });

  it("no token → skipped and logged, nothing recorded as sent", async () => {
    vi.stubEnv("META_CAPI_TOKEN", "");
    const w = world();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await setStatus("won");
    expect(w.graph).toEqual([]);
    expect(w.rows("demo_leads")[0]!["meta_events_sent"]).toEqual({});
    expect(log.mock.calls.some((c) => String(c[0]).includes("token_missing"))).toBe(true);
  });

  it("a lead who signed up and opted out of sharing with Meta: nothing", async () => {
    const w = world({ linked_user_id: "u-1" });
    (w as unknown as { users: Map<string, Row> }).users.get("u-1")!["user_metadata"] = {
      meta_share_opt_out: true,
    };
    await setStatus("won");
    expect(w.graph).toEqual([]);
  });

  it("a test lead: nothing", async () => {
    const w = world({ is_test: true });
    await setStatus("contacted");
    expect(w.graph).toEqual([]);
  });

  it("the side sheet says which stages went to Meta", async () => {
    const { metaStageLines } = await import("./leads");
    expect(
      metaStageLines({
        meta_events_sent: {
          won: { event: "LeadWon", event_id: "x", at: "2026-11-12T11:00:00Z" },
          contacted: { event: "LeadContacted", event_id: "y", at: "2026-11-12T10:00:00Z" },
        },
      }),
    ).toEqual([
      { stage: "contacted", event: "LeadContacted", at: "2026-11-12T10:00:00Z" },
      { stage: "won", event: "LeadWon", at: "2026-11-12T11:00:00Z" },
    ]);
    expect(metaStageLines({ meta_events_sent: null })).toEqual([]);
    expect(readFileSync("src/routes/admin/leads.tsx", "utf8")).toContain(
      "Sent to Meta ✓ {m.event}",
    );
  });

  it("Subscribe / Purchase are untouched; the stage events are server-only (the relay doesn't take them)", () => {
    const relay = readFileSync("src/routes/api/public/meta-event.ts", "utf8");
    for (const e of ["LeadContacted", "SalesQualifiedLead", "Schedule", "LeadWon"]) {
      expect(relay).not.toContain(e);
    }
    const src = readFileSync("src/lib/lead-stage-events.server.ts", "utf8");
    expect(src).not.toMatch(/"Subscribe"|"Purchase"/);
  });
});

const dir = import.meta.dirname;
const M = (f: string) => join(dir, "../../supabase/aidwar-migrations", f);
const MIGRATION = M("20261410_batch77.sql");

describe("20261410, as text", () => {
  it("adds the four columns only, ends with the two OAuth guards", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    for (const col of [
      "ADD COLUMN IF NOT EXISTS meta_fbc text;",
      "ADD COLUMN IF NOT EXISTS meta_fbp text;",
      "ADD COLUMN IF NOT EXISTS meta_external_id text;",
      "ADD COLUMN IF NOT EXISTS meta_events_sent jsonb NOT NULL DEFAULT '{}'::jsonb;",
    ]) {
      expect(sql).toContain(col);
    }
    expect(sql).not.toMatch(/^\s*(DELETE|DROP|INSERT|UPDATE)\b/im);
    expect(
      sql
        .trim()
        .endsWith(
          "SELECT public.mcp_block_oauth_writes();\nSELECT public.mcp_block_oauth_reads();",
        ),
    ).toBe(true);
  });
});

describe.runIf(pgAvailable() || Boolean(process.env["CI"]))(
  "20261410_batch77.sql (real Postgres)",
  () => {
    let pg: ScratchPg;
    beforeAll(() => {
      pg = startScratchPg({
        schemaFile: join(dir, "test-support/batch76-schema.sql"),
        migrations: [
          M("20260915_demo_leads.sql"),
          M("20261380_batch72.sql"),
          M("20261400_batch76.sql"),
          MIGRATION,
          MIGRATION,
        ],
      });
    }, 120_000);
    afterAll(() => pg?.stop());

    it("applies twice; a lead starts with meta_events_sent = {}", () => {
      const id = pg
        .sql(
          `insert into public.demo_leads (phone, consent, consent_version, source) values ('+919812345670', true, 'v', 'landing_start') returning id`,
        )
        .trim();
      expect(
        pg
          .sql(
            `select meta_events_sent::text, meta_fbc is null, meta_external_id is null from public.demo_leads where id = '${id}'`,
          )
          .trim(),
      ).toMatch(/^\{\}\s*\|\s*t\s*\|\s*t$/);
    });
  },
);
