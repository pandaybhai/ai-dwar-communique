import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type MemoryDb, type Row } from "./test-support/memory-db";

/**
 * Batch 76 — the sales role: Leads & Demos only. Every /api/admin/* route is
 * called as a sales user; only leads (and the "what am I" access route)
 * answer, everything else is 403. Fakes only (in-memory database, fake auth);
 * nothing reaches a live system.
 */

const h = vi.hoisted(() => ({ db: null as null | { supabase: unknown } }));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.db!.supabase }));
vi.mock("@/lib/billing-notify.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./billing-notify.server")>()),
  resolvePlatformOrg: async () => "org-platform",
}));

const SALES = "5a1e5a1e-0000-4000-8000-000000000001";
const BOSS = "b0550000-0000-4000-8000-000000000002";
const OTHER = "07e40000-0000-4000-8000-000000000003";

function world(): MemoryDb {
  const db = memoryDb({
    profiles: [
      {
        id: SALES,
        email: "sales@example.com",
        full_name: "Sana",
        is_sales: true,
        is_super_admin: false,
        created_at: "2026-01-01",
      },
      {
        id: BOSS,
        email: "boss@example.com",
        full_name: "Vinay",
        is_sales: false,
        is_super_admin: true,
        created_at: "2026-01-01",
      },
      {
        id: OTHER,
        email: "other@example.com",
        full_name: "Ravi",
        is_sales: false,
        is_super_admin: false,
        created_at: "2026-01-01",
      },
    ],
    organization_members: [],
    demo_leads: [
      {
        id: "lead-1",
        source: "landing_start",
        name: "Asha",
        phone: "+919812345670",
        status: "new",
        assigned_to: null,
        is_test: false,
        created_at: "2026-11-12T10:00:00Z",
        qualification: {},
        first_attribution: {},
      },
    ],
    demo_lead_notes: [],
    platform_settings: [{ id: 1, lead_alert_numbers: ["+917981223192", "+919121883067"] }],
    activity_log: [],
  });
  Object.assign(db.supabase as object, {
    auth: {
      getUser: async (token: string) => ({
        data: {
          user:
            token === "sales"
              ? { id: SALES }
              : token === "boss"
                ? { id: BOSS }
                : token === "other"
                  ? { id: OTHER }
                  : null,
        },
      }),
    },
  });
  h.db = { supabase: db.supabase };
  return db;
}

type Handler = (a: { request: Request; params?: Record<string, string> }) => Promise<Response>;
async function handlersOf(file: string): Promise<Record<string, Handler>> {
  const mod = (await import(`@/routes/api/admin/${file.replace(/\.ts$/, "")}`)) as {
    Route: { options: { server: { handlers: Record<string, Handler> } } };
  };
  return mod.Route.options.server.handlers;
}
function req(method: string, token: string, path = "/api/admin/x", body?: unknown): Request {
  return new Request(`https://aidwar.in${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body !== undefined && method !== "GET" ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("a sales member sees Leads & Demos and nothing else", () => {
  it("every other /api/admin/* route answers 403 to a sales user (server-side)", async () => {
    world();
    const files = readdirSync(join(import.meta.dirname, "../routes/api/admin")).filter((f) =>
      f.endsWith(".ts"),
    );
    // Batch 76 adds access.ts; the rest are the admin APIs that existed before.
    expect(files.sort()).toEqual([
      "access.ts",
      "ai.ts",
      "billing.ts",
      "customers.ts",
      "design.ts",
      "feature-overrides.ts",
      "leads.ts",
      "onboarding.ts",
      "sending.ts",
      "super-admins.ts",
    ]);
    const answered: string[] = [];
    for (const file of files) {
      const handlers = await handlersOf(file);
      for (const [method, handler] of Object.entries(handlers)) {
        const res = await handler({
          request: req(method, "sales", `/api/admin/${file}`, { action: "list" }),
        });
        if (file === "leads.ts" || file === "access.ts") {
          answered.push(`${file} ${method} ${res.status}`);
          continue;
        }
        expect(res.status, `${file} ${method}`).toBe(403);
      }
    }
    expect(answered.sort()).toEqual(["access.ts GET 200", "leads.ts GET 200", "leads.ts POST 400"]);
  });

  it("someone with no admin role gets 403 on leads and access too", async () => {
    world();
    const leads = await handlersOf("leads.ts");
    expect((await leads["GET"]!({ request: req("GET", "other", "/api/admin/leads") })).status).toBe(
      403,
    );
    const access = await handlersOf("access.ts");
    expect(
      (await access["GET"]!({ request: req("GET", "other", "/api/admin/access") })).status,
    ).toBe(403);
  });

  it("on Leads a sales member can change status, add notes, set the follow-up and assign to themselves", async () => {
    const w = world();
    const leads = await handlersOf("leads.ts");
    const list = (await (
      await leads["GET"]!({ request: req("GET", "sales", "/api/admin/leads") })
    ).json()) as Row;
    expect(list).toMatchObject({ role: "sales", me: SALES, alert_numbers: null });
    expect((list["admins"] as Row[]).map((a) => a["name"]).sort()).toEqual(["Sana", "Vinay"]);
    const post = (body: Row) =>
      leads["POST"]!({ request: req("POST", "sales", "/api/admin/leads", body) });
    expect((await post({ lead_id: "lead-1", status: "contacted" })).status).toBe(200);
    expect(
      (await post({ lead_id: "lead-1", next_follow_up_at: "2026-11-13T05:30:00.000Z" })).status,
    ).toBe(200);
    expect((await post({ lead_id: "lead-1", note: "Called, wants a demo Friday" })).status).toBe(
      200,
    );
    expect((await post({ lead_id: "lead-1", assigned_to: SALES })).status).toBe(200);
    expect(w.rows("demo_leads")[0]).toMatchObject({
      status: "contacted",
      next_follow_up_at: "2026-11-13T05:30:00.000Z",
      assigned_to: SALES,
    });
    expect(w.rows("demo_lead_notes")).toHaveLength(1);
    // Never to someone else; letting go is fine.
    expect((await post({ lead_id: "lead-1", assigned_to: BOSS })).status).toBe(403);
    expect((await post({ lead_id: "lead-1", assigned_to: null })).status).toBe(200);
  });

  it("CSV export and the alert numbers are super admin only", async () => {
    const w = world();
    const leads = await handlersOf("leads.ts");
    expect(
      (await leads["GET"]!({ request: req("GET", "sales", "/api/admin/leads?format=csv") })).status,
    ).toBe(403);
    expect(
      (
        await leads["POST"]!({
          request: req("POST", "sales", "/api/admin/leads", {
            action: "alert_numbers",
            numbers: ["9000012345"],
          }),
        })
      ).status,
    ).toBe(403);
    expect(w.rows("platform_settings")[0]!["lead_alert_numbers"]).toEqual([
      "+917981223192",
      "+919121883067",
    ]);

    const csv = await leads["GET"]!({ request: req("GET", "boss", "/api/admin/leads?format=csv") });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const text = await csv.text();
    expect(text.split("\n")[0]).toContain("received_at,source,name,business,phone,sells,customers");
    expect(text).toContain("+919812345670");
    expect(text).not.toMatch(/ip_hash/);

    const saved = await leads["POST"]!({
      request: req("POST", "boss", "/api/admin/leads", {
        action: "alert_numbers",
        numbers: ["79812 23192", "+91 91218 83067", "79812 23192"],
      }),
    });
    expect(await saved.json()).toEqual({
      ok: true,
      alert_numbers: ["+917981223192", "+919121883067"],
    });
    const bad = await leads["POST"]!({
      request: req("POST", "boss", "/api/admin/leads", {
        action: "alert_numbers",
        numbers: ["12ab"],
      }),
    });
    expect(bad.status).toBe(400);
    expect(w.rows("activity_log").some((r) => r["action"] === "lead_alert_numbers_changed")).toBe(
      true,
    );
  });

  it("the access route answers the caller's own role, and whether they have a workspace", async () => {
    const w = world();
    const access = await handlersOf("access.ts");
    expect(
      await (await access["GET"]!({ request: req("GET", "sales", "/api/admin/access") })).json(),
    ).toEqual({
      role: "sales",
      has_workspace: false,
    });
    w.rows("organization_members").push({ organization_id: "org-1", user_id: SALES });
    expect(
      await (await access["GET"]!({ request: req("GET", "sales", "/api/admin/access") })).json(),
    ).toEqual({
      role: "sales",
      has_workspace: true,
    });
    expect(
      await (await access["GET"]!({ request: req("GET", "boss", "/api/admin/access") })).json(),
    ).toMatchObject({
      role: "super_admin",
    });
  });
});

describe("the sales team (Admin → Super admins)", () => {
  it("a super admin adds and removes members by email, recorded; a sales member can't", async () => {
    const w = world();
    const api = (await handlersOf("super-admins.ts"))["POST"]!;
    const call = (token: string, body: Row) =>
      api({ request: req("POST", token, "/api/admin/super-admins", body) });
    expect(await (await call("boss", { action: "list_sales" })).json()).toEqual({
      sales: [expect.objectContaining({ id: SALES })],
    });
    const added = (await (
      await call("boss", { action: "grant_sales", email: "OTHER@example.com" })
    ).json()) as Row;
    expect((added["sales"] as Row[]).map((m) => m["id"]).sort()).toEqual([SALES, OTHER].sort());
    expect(
      (await call("boss", { action: "grant_sales", email: "nobody@example.com" })).status,
    ).toBe(404);
    expect((await call("boss", { action: "grant_sales", email: "other@example.com" })).status).toBe(
      409,
    );
    await call("boss", { action: "revoke_sales", user_id: OTHER });
    expect(w.rows("profiles").find((p) => p["id"] === OTHER)!["is_sales"]).toBe(false);
    expect(
      w
        .rows("activity_log")
        .map((r) => r["action"])
        .sort(),
    ).toEqual(["sales_member_added", "sales_member_removed"]);
    // A sales member can't manage the team (or themselves).
    expect(
      (await call("sales", { action: "grant_sales", email: "other@example.com" })).status,
    ).toBe(403);
    // Super-admin powers are unchanged.
    expect((await (await call("boss", { action: "list" })).json()) as Row).toMatchObject({
      me: BOSS,
    });
  });

  it("nobody can raise their own is_sales: the profiles guard covers it (20261400)", () => {
    const sql = readFileSync(
      join(import.meta.dirname, "../../supabase/aidwar-migrations/20261400_batch76.sql"),
      "utf8",
    );
    expect(sql).toContain("new.is_sales := old.is_sales;");
    expect(sql).toContain("new.is_sales := false;");
    // The app never writes is_sales anywhere but the super-admin route.
    const route = readFileSync(
      join(import.meta.dirname, "../routes/api/admin/super-admins.ts"),
      "utf8",
    );
    expect(route.match(/is_sales: (true|false)/g)).toHaveLength(2);
  });
});

describe("the screens", () => {
  it("a sales member's nav is Leads & Demos only; other admin pages send them there", async () => {
    const { navFor } = await import("@/components/admin-shell");
    expect(navFor("sales").map((n) => n.to)).toEqual(["/admin/leads"]);
    expect(navFor("super_admin").length).toBeGreaterThan(5);
    const route = readFileSync(join(import.meta.dirname, "../routes/admin/route.tsx"), "utf8");
    expect(route).toContain(
      'if (location.pathname !== "/admin/leads") throw redirect({ to: "/admin/leads" });',
    );
    expect(route).toContain(
      'if (allowed === true) return { user: data.user, adminRole: "super_admin" as const };',
    );
    const page = readFileSync(join(import.meta.dirname, "../routes/admin/leads.tsx"), "utf8");
    expect(page).toContain('{data?.role === "super_admin" ? (\n        <LeadAlertNumbers');
    expect(page).toContain('data-testid="export-csv"');
    expect(page).toContain('data-testid="lead-whatsapp"');
  });

  it("after log-in a sales-only person lands on Leads & Demos; everyone else on /app", async () => {
    vi.resetModules();
    const answers: Array<{ data: Row | null }> = [
      { data: { role: "sales", has_workspace: false } },
      { data: { role: "sales", has_workspace: true } },
      { data: null },
    ];
    vi.doMock("@/lib/whatsapp-client", () => ({ callApi: async () => answers.shift() }));
    const { landingAfterLogin } = await import("./admin-landing");
    expect(await landingAfterLogin()).toBe("/admin/leads");
    expect(await landingAfterLogin()).toBe("/app");
    expect(await landingAfterLogin()).toBe("/app");
    vi.doUnmock("@/lib/whatsapp-client");
    const { leadWhatsAppLink } = await import("./leads");
    expect(leadWhatsAppLink("+91 98123 45670")).toBe("https://wa.me/919812345670");
  });
});
