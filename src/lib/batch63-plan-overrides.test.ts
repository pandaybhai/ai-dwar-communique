import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type MemoryDb } from "./test-support/memory-db";

/**
 * Batch 63 (A): a switch a person set survives every plan change.
 * Zoori, 2 Nov: a plan re-assign / trial reset rewrote every feature row —
 * Shopify and Catalogs came back on, new_design / aiden_workspace /
 * mcp_access went off — because Super Admin's switches were written straight
 * from the browser with no record that a person set them.
 */

vi.mock("@/lib/subscriptions.server", () => ({
  alignSubscriptionToPlan: async () => ({ action: "none" }),
}));

const ORG = "81c234b2-569f-40be-ad71-96c046de5d12";
const ADMIN = "00000000-0000-4000-8000-0000000000aa";
const GROWTH = "00000000-0000-4000-8000-00000000a001";
const PRO = "00000000-0000-4000-8000-00000000a002";

// The plans list Shopify and Catalogs; neither lists new_design, mcp_access or aiden_workspace.
const PLAN_FEATURES = [
  "inbox",
  "contacts",
  "campaigns",
  "templates",
  "ai_features",
  "flows",
  "shopify",
  "catalogs",
  "billing",
];

function world(
  overrides: Array<{ flag_key: string; enabled: boolean; source?: string }>,
  manualFlags: Record<string, boolean> = {},
) {
  return memoryDb({
    profiles: [{ id: ADMIN, is_super_admin: true }],
    organizations: [
      {
        id: ORG,
        name: "ZOORI Jewels INDIA",
        plan_version_id: GROWTH,
        plan_status: "trial",
        trial_ends_at: new Date(Date.now() + 5 * 864e5).toISOString(),
        plan_versions: { features: PLAN_FEATURES },
      },
    ],
    plan_versions: [
      {
        id: GROWTH,
        is_current: true,
        features: PLAN_FEATURES,
        limits: {},
        plans: { key: "growth", name: "Growth" },
      },
      {
        id: PRO,
        is_current: true,
        features: PLAN_FEATURES,
        limits: {},
        plans: { key: "pro", name: "Pro" },
      },
    ],
    organization_feature_overrides: overrides.map((o) => ({ organization_id: ORG, ...o })),
    organization_billing_settings: [
      { organization_id: ORG, limits_override: { _manual_flags: manualFlags } },
    ],
    organization_members: [],
    whatsapp_numbers: [],
  });
}

const flag = (db: MemoryDb, key: string) =>
  db
    .rows("organization_feature_overrides")
    .find((r) => r["organization_id"] === ORG && r["flag_key"] === key);

/** Zoori's hand-set switches, as Super Admin now writes them (source 'manual'). */
const ZOORI_MANUAL = [
  { flag_key: "shopify", enabled: false, source: "manual" },
  { flag_key: "catalogs", enabled: false, source: "manual" },
  { flag_key: "new_design", enabled: true, source: "manual" },
  { flag_key: "aiden_workspace", enabled: true, source: "manual" },
  { flag_key: "mcp_access", enabled: true, source: "manual" },
];

function expectZooriKept(db: MemoryDb) {
  for (const m of ZOORI_MANUAL) {
    expect([
      m.flag_key,
      flag(db, m.flag_key)?.["enabled"],
      flag(db, m.flag_key)?.["source"],
    ]).toEqual([m.flag_key, m.enabled, "manual"]);
  }
}

beforeEach(() => {
  vi.resetModules();
});

describe("plan changes never write a switch a person set", () => {
  it("assign_plan (confirmed) keeps every manual row and still applies the plan to the rest", async () => {
    const db = world([...ZOORI_MANUAL, { flag_key: "flows", enabled: false, source: "plan" }]);
    const { assignPlan } = await import("./billing.server");
    const r = await assignPlan(db.supabase, {
      organizationId: ORG,
      planKey: "pro",
      actorId: ADMIN,
      status: "active",
      confirm: true,
    });
    expect("ok" in r && r.ok).toBe(true);
    expectZooriKept(db);
    // A plan-owned row is still the plan's to write.
    expect(flag(db, "flows")?.["enabled"]).toBe(true);
    expect(flag(db, "billing")?.["enabled"]).toBe(true);
  });

  it("a trial reset (assign_plan status trial) keeps them too — the 2 Nov path", async () => {
    const db = world(ZOORI_MANUAL);
    const { assignPlan } = await import("./billing.server");
    const r = await assignPlan(db.supabase, {
      organizationId: ORG,
      planKey: "growth",
      actorId: ADMIN,
      status: "trial",
      trialDays: 14,
      confirm: true,
    });
    expect("ok" in r && r.ok).toBe(true);
    expectZooriKept(db);
  });

  it("before 20261350 is applied, _manual_flags alone keeps them (no source column)", async () => {
    const db = world(
      ZOORI_MANUAL.map(({ flag_key, enabled }) => ({ flag_key, enabled })),
      { shopify: false, catalogs: false, new_design: true, aiden_workspace: true, mcp: true },
    );
    const { assignPlan } = await import("./billing.server");
    await assignPlan(db.supabase, {
      organizationId: ORG,
      planKey: "growth",
      actorId: ADMIN,
      status: "trial",
      confirm: true,
    });
    for (const m of ZOORI_MANUAL)
      expect([m.flag_key, flag(db, m.flag_key)?.["enabled"]]).toEqual([m.flag_key, m.enabled]);
  });

  it("without a person's record the plan writes the row, exactly as before (the bug Zoori hit)", async () => {
    const db = world(
      ZOORI_MANUAL.map(({ flag_key, enabled }) => ({ flag_key, enabled, source: "plan" })),
    );
    const { assignPlan } = await import("./billing.server");
    await assignPlan(db.supabase, {
      organizationId: ORG,
      planKey: "growth",
      actorId: ADMIN,
      status: "trial",
      confirm: true,
    });
    expect(flag(db, "shopify")?.["enabled"]).toBe(true);
    expect(flag(db, "new_design")?.["enabled"]).toBe(false);
  });

  it("resync_plan_features keeps them", async () => {
    const db = world(ZOORI_MANUAL);
    const { resyncPlanFeatures } = await import("./billing.server");
    const r = await resyncPlanFeatures(db.supabase, { organizationId: ORG, actorId: ADMIN });
    expect("ok" in r && r.ok).toBe(true);
    if ("ok" in r)
      expect(r.kept_manual).toEqual(
        expect.arrayContaining(["shopify", "catalog", "new_design", "aiden_workspace", "mcp"]),
      );
    expectZooriKept(db);
  });

  it("extend_trial writes no feature row at all", async () => {
    const db = world(ZOORI_MANUAL);
    const before = JSON.stringify(db.rows("organization_feature_overrides"));
    const { extendTrial } = await import("./billing.server");
    const r = await extendTrial(db.supabase, { organizationId: ORG, days: 7, actorId: ADMIN });
    expect("ok" in r && r.ok).toBe(true);
    expect(JSON.stringify(db.rows("organization_feature_overrides"))).toBe(before);
  });

  it("a plan purchase (activatePlanFromPayment) writes no feature row (the billing trigger only sets billing)", async () => {
    const db = world(ZOORI_MANUAL);
    const before = JSON.stringify(db.rows("organization_feature_overrides"));
    const { activatePlanFromPayment } = await import("./plan-purchase.server");
    const ok = await activatePlanFromPayment(db.supabase, {
      id: "pay-1",
      organization_id: ORG,
      raw: { plan_version_id: PRO, plan_key: "pro" },
    });
    expect(ok).toBe(true);
    expect(JSON.stringify(db.rows("organization_feature_overrides"))).toBe(before);
  });

  it("the plan-change preview doesn't list a manual switch as going off", async () => {
    const db = world([{ flag_key: "new_design", enabled: true, source: "manual" }]);
    const { planChangePreview } = await import("./billing.server");
    const p = await planChangePreview(db.supabase, {
      organizationId: ORG,
      planKey: "growth",
      actorId: ADMIN,
    });
    expect("error" in p).toBe(false);
    if (!("error" in p)) expect(p.features_off.map((f) => f.key)).not.toContain("new_design");
  });
});

describe("Super Admin writes mark ownership; Reset to plan hands it back", () => {
  it("set marks the row manual and records _manual_flags; reset writes the plan's value and clears both", async () => {
    const db = world([{ flag_key: "shopify", enabled: true, source: "plan" }]);
    const own = await import("./feature-ownership.server");
    const set = await own.writeManualOverride(db.supabase, {
      organizationId: ORG,
      flagKey: "shopify",
      enabled: false,
      actorId: ADMIN,
      via: "test",
    });
    expect(set).toEqual({ ok: true, enabled: false, source: "manual" });
    expect(flag(db, "shopify")).toMatchObject({ enabled: false, source: "manual" });
    const settings = db.rows("organization_billing_settings")[0]!["limits_override"] as Record<
      string,
      Record<string, boolean>
    >;
    expect(settings["_manual_flags"]!["shopify"]).toBe(false);
    expect(await own.overrideIsManual(db.supabase, ORG, "shopify")).toBe(true);

    const reset = await own.resetOverrideToPlan(db.supabase, {
      organizationId: ORG,
      flagKey: "shopify",
      actorId: ADMIN,
    });
    expect(reset).toEqual({ ok: true, enabled: true, source: "plan" });
    expect(flag(db, "shopify")).toMatchObject({ enabled: true, source: "plan" });
    const after = db.rows("organization_billing_settings")[0]!["limits_override"] as Record<
      string,
      Record<string, boolean>
    >;
    expect("shopify" in after["_manual_flags"]!).toBe(false);
    expect(await own.overrideIsManual(db.supabase, ORG, "shopify")).toBe(false);
    const actions = db.rows("activity_log").map((r) => r["action"]);
    expect(actions).toEqual(["feature_override_set", "feature_override_reset_to_plan"]);
  });

  it("reset of a flag that isn't a plan feature removes the row (Super Admin > Flags' old Reset)", async () => {
    const db = world([{ flag_key: "some_custom_flag", enabled: true, source: "manual" }]);
    const own = await import("./feature-ownership.server");
    const reset = await own.resetOverrideToPlan(db.supabase, {
      organizationId: ORG,
      flagKey: "some_custom_flag",
      actorId: ADMIN,
    });
    expect(reset).toEqual({ ok: true, enabled: null, source: "default" });
    expect(flag(db, "some_custom_flag")).toBeUndefined();
  });

  it("the workspace's own AI-assistants switch is manual by column only (_manual_flags.mcp still means 'support switched it off')", async () => {
    const db = world([]);
    const { setMcpAccess } = await import("./mcp-workspace.server");
    const r = await setMcpAccess(db.supabase, {
      organizationId: ORG,
      userId: ADMIN,
      enabled: false,
    });
    expect(r).toEqual({ ok: true, enabled: false });
    expect(flag(db, "mcp_access")).toMatchObject({ enabled: false, source: "manual" });
    const limits = db.rows("organization_billing_settings")[0]!["limits_override"] as Record<
      string,
      Record<string, boolean>
    >;
    expect("mcp" in limits["_manual_flags"]!).toBe(false);
    // …so the owner can switch it back on.
    expect(
      await setMcpAccess(db.supabase, { organizationId: ORG, userId: ADMIN, enabled: true }),
    ).toEqual({ ok: true, enabled: true });
  });

  it("without the source column every write and read still works, exactly as before", async () => {
    const db = world([{ flag_key: "shopify", enabled: true }]);
    // A client that refuses the unknown column the way PostgREST does.
    const base = db.supabase as unknown as { from: (t: string) => Record<string, unknown> };
    const noColumn = {
      ...base,
      from(t: string) {
        const q = base.from(t) as Record<string, (...a: unknown[]) => unknown>;
        if (t !== "organization_feature_overrides") return q;
        const wrap = { ...q } as Record<string, (...a: unknown[]) => unknown>;
        wrap["select"] = (cols: unknown, ...rest: unknown[]) =>
          String(cols).includes("source")
            ? {
                eq: () =>
                  Promise.resolve({
                    data: null,
                    error: { code: "42703", message: 'column "source" does not exist' },
                  }),
              }
            : q["select"]!(cols, ...rest);
        wrap["upsert"] = (row: unknown, opts: unknown) =>
          "source" in (row as Record<string, unknown>)
            ? Promise.resolve({
                data: null,
                error: {
                  code: "PGRST204",
                  message: "Could not find the 'source' column in the schema cache",
                },
              })
            : q["upsert"]!(row, opts);
        return wrap;
      },
    };
    const own = await import("./feature-ownership.server");
    const rows = await own.readOverrideRows(noColumn as never, ORG);
    expect(rows).toEqual([{ flag_key: "shopify", enabled: true, source: null }]);
    const set = await own.writeManualOverride(noColumn as never, {
      organizationId: ORG,
      flagKey: "shopify",
      enabled: false,
      actorId: ADMIN,
      via: "test",
    });
    expect(set.ok).toBe(true);
    expect(flag(db, "shopify")).toMatchObject({ enabled: false });
    expect(await own.overrideIsManual(noColumn as never, ORG, "shopify")).toBe(true);
  });
});

describe("labels", () => {
  it("Super Admin reads who owns each switch", async () => {
    const { ownershipLabel } = await import("./feature-ownership");
    expect(
      ownershipLabel({
        hasRow: true,
        manual: true,
        enabled: false,
        fromPlan: true,
        globalDefault: false,
      }),
    ).toBe("Set by hand — off (differs from plan) · kept on plan changes");
    expect(
      ownershipLabel({
        hasRow: true,
        manual: false,
        enabled: true,
        fromPlan: true,
        globalDefault: false,
      }),
    ).toBe("From plan — on");
    expect(
      ownershipLabel({
        hasRow: false,
        manual: false,
        enabled: false,
        fromPlan: null,
        globalDefault: false,
      }),
    ).toBe("Global default — off");
  });
});
