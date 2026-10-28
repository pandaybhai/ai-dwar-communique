import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { batch38World, call, ORG } from "./test-support/batch38-world";
import {
  API_PLANS,
  PLAN_AVAILABILITY,
  endpointFor,
  eventFor,
  planAllows,
  type ApiPlan,
} from "./public-api-plans";
import { forgetWorkspacePlans } from "./public-api-plans.server";
import { WEBHOOK_EVENT_NAMES } from "./public-api";

/**
 * Batch 38 item 5 — one plan table (public-api-plans.ts) for every endpoint
 * and event. The server enforces it in authenticateApiKey (so the Batch 34
 * and 37 endpoints too): an endpoint outside the workspace's plan is a 403
 * endpoint_not_in_plan naming the plan needed, before anything is read or
 * sent. Today every row lists Scale and Enterprise, so nothing changes.
 */

const h = vi.hoisted(() => ({
  world: null as null | ReturnType<typeof import("./test-support/batch38-world").batch38World>,
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.world!.db.supabase }));

import { Route as CampaignsRoute } from "../routes/api/v1/campaigns/index";
import { Route as TemplateRoute } from "../routes/api/v1/messages/template";

const ROUTES = join(import.meta.dirname, "../routes/api/v1");

/** Every route file under /api/v1 with the methods it answers. */
function routeFiles(): Array<{ file: string; path: string; methods: string[] }> {
  const out: Array<{ file: string; path: string; methods: string[] }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) {
        const text = readFileSync(full, "utf8");
        const path = /createFileRoute\("([^"]+)"\)/.exec(text)?.[1] ?? "";
        const methods = Array.from(text.matchAll(/^\s+(GET|POST|PATCH|DELETE|PUT):/gm)).map(
          (m) => m[1]!,
        );
        out.push({ file: full, path, methods });
      }
    }
  };
  walk(ROUTES);
  return out;
}

const rows = (t: string) => h.world!.db.rows(t);
const saved = PLAN_AVAILABILITY.map((r) => [...r.plans]);
function onPlan(key: string | null) {
  rows("plans").push(
    { id: "p-scale", key: "scale", name: "Scale" },
    { id: "p-ent", key: "enterprise", name: "Enterprise" },
    { id: "p-growth", key: "growth", name: "Growth" },
  );
  rows("plan_versions").push(
    { id: "v-scale", plan_id: "p-scale" },
    { id: "v-ent", plan_id: "p-ent" },
    { id: "v-growth", plan_id: "p-growth" },
  );
  const version = key ? { scale: "v-scale", enterprise: "v-ent", growth: "v-growth" }[key] : null;
  rows("organizations").find((o) => o["id"] === ORG)!["plan_version_id"] = version ?? null;
}
function narrow(method: string, path: string, plans: ApiPlan[]) {
  const row = PLAN_AVAILABILITY.find(
    (r) => r.kind === "endpoint" && r.method === method && r.path === path,
  )!;
  row.plans = plans;
}

beforeEach(() => {
  h.world = batch38World();
  forgetWorkspacePlans();
});
afterEach(() => {
  PLAN_AVAILABILITY.forEach((r, i) => (r.plans = [...saved[i]!]));
  vi.unstubAllGlobals();
});

describe("the table", () => {
  it("has a row for every method of every /api/v1 route file, and every webhook event", () => {
    const files = routeFiles();
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      expect(f.methods.length, f.file).toBeGreaterThan(0);
      // "/api/v1/campaigns/$campaignId/cancel" -> a request path for it.
      const sample = f.path.replace(/\/$/, "").replace(/\$[A-Za-z]+/g, "x1");
      for (const m of f.methods) expect(endpointFor(m, sample), `${m} ${f.path}`).not.toBeNull();
    }
    for (const e of [...WEBHOOK_EVENT_NAMES, "campaign.completed"])
      expect(eventFor(e), e).not.toBeNull();
  });

  it("today every row is on every plan that has the API: nothing changes for anyone", () => {
    for (const row of PLAN_AVAILABILITY) expect(row.plans).toEqual([...API_PLANS]);
  });

  it("a static segment wins over a {name} one; an unknown endpoint has no row", () => {
    expect(endpointFor("POST", "/api/v1/campaigns/estimate")!.path).toBe(
      "/api/v1/campaigns/estimate",
    );
    expect(endpointFor("GET", "/api/v1/campaigns/abc")!.path).toBe(
      "/api/v1/campaigns/{campaign_id}",
    );
    expect(endpointFor("POST", "/api/v1/campaigns/abc/cancel")!.path).toBe(
      "/api/v1/campaigns/{campaign_id}/cancel",
    );
    expect(endpointFor("DELETE", "/api/v1/campaigns")).toBeNull();
  });

  it("a plan outside the API's plans (trial, or an override) is never told no; Scale is, for an Enterprise-only row", () => {
    const row = { ...PLAN_AVAILABILITY[0]!, plans: ["enterprise"] as ApiPlan[] };
    expect(planAllows(row, "scale")).toBe(false);
    expect(planAllows(row, "Enterprise")).toBe(true);
    expect(planAllows(row, "growth")).toBe(true);
    expect(planAllows(row, null)).toBe(true);
  });
});

describe("the server enforces it", () => {
  it("an endpoint outside the workspace's plan: 403 endpoint_not_in_plan with the plan needed, nothing created", async () => {
    onPlan("scale");
    narrow("POST", "/api/v1/campaigns", ["enterprise"]);
    const res = await call(CampaignsRoute, "POST", "/api/v1/campaigns", {
      key: h.world!.keys.a,
      body: {
        name: "x",
        template_name: "festive_offer",
        audience: { all: true },
        variables: ["a", "b"],
      },
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "endpoint_not_in_plan", plan_needed: "enterprise" });
    expect(String(res.body["error"])).toContain("Enterprise");
    expect(rows("campaigns")).toHaveLength(0);
    // The rest of the API still answers on Scale.
    expect(
      (await call(CampaignsRoute, "GET", "/api/v1/campaigns", { key: h.world!.keys.a })).status,
    ).toBe(200);
  });

  it("the same plan on Enterprise, and with no plan of the API's (override), is allowed", async () => {
    narrow("POST", "/api/v1/campaigns", ["enterprise"]);
    const body = {
      name: "x",
      template_name: "festive_offer",
      audience: { all: true },
      variables: ["a", "b"],
    };
    onPlan("enterprise");
    expect(
      (await call(CampaignsRoute, "POST", "/api/v1/campaigns", { key: h.world!.keys.a, body }))
        .status,
    ).toBe(201);
    forgetWorkspacePlans();
    rows("organizations").find((o) => o["id"] === ORG)!["plan_version_id"] = "v-growth";
    expect(
      (await call(CampaignsRoute, "POST", "/api/v1/campaigns", { key: h.world!.keys.a, body }))
        .status,
    ).toBe(201);
  });

  it("covers the Batch 34 send too, before the body is read or Meta is called", async () => {
    const fetches: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => {
      fetches.push(String(u));
      return new Response("no", { status: 599 });
    });
    onPlan("scale");
    narrow("POST", "/api/v1/messages/template", ["enterprise"]);
    const res = await call(TemplateRoute, "POST", "/api/v1/messages/template", {
      key: h.world!.keys.a,
      body: {},
    });
    expect(res.status).toBe(403);
    expect(res.body["code"]).toBe("endpoint_not_in_plan");
    expect(fetches).toEqual([]);
  });

  it("a plan that can't be read is a 503, never allowed", async () => {
    narrow("POST", "/api/v1/campaigns", ["enterprise"]);
    const supabase = h.world!.db.supabase as unknown as { from: (t: string) => unknown };
    const from = supabase.from.bind(supabase);
    supabase.from = (t: string) => {
      const q = from(t) as Record<string, unknown>;
      if (t !== "plan_versions") return q;
      const then = q["then"] as (
        res: (v: unknown) => unknown,
        rej: (e: unknown) => unknown,
      ) => Promise<unknown>;
      q["then"] = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        then(() => res({ data: null, error: { message: "boom" } }), rej);
      return q;
    };
    rows("organizations").find((o) => o["id"] === ORG)!["plan_version_id"] = "v-x";
    const res = await call(CampaignsRoute, "POST", "/api/v1/campaigns", {
      key: h.world!.keys.a,
      body: {},
    });
    expect(res.status).toBe(503);
  });
});
