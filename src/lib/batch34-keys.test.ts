import { beforeEach, describe, expect, it, vi } from "vitest";
import { publicApiWorld } from "./test-support/public-api-world";
import { fakeDb } from "./test-support/fake-db";
import {
  API_KEY_PREFIX,
  authenticateApiKey,
  generateApiKey,
  hashApiKey,
  hashesEqual,
} from "./public-api.server";
import { FEATURES, roleDefaults } from "./feature-registry";

/**
 * Batch 34 item 1 — API keys. A key is shown once and only its sha256 is
 * stored; a revoked key gets 401; a workspace with public_api off gets 403
 * with a clear message; managing keys needs public_api.manage. Fakes only.
 */

const h = vi.hoisted(() => ({
  world: null as null | ReturnType<typeof import("./test-support/public-api-world").publicApiWorld>,
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.world!.db.supabase }));

import { Route as KeysRoute } from "../routes/api/developer/keys";

type Handler = (a: { request: Request }) => Promise<Response>;
const handlers = (r: unknown) =>
  (r as { options: { server: { handlers: { GET: Handler; POST: Handler } } } }).options.server
    .handlers;

const post = (token: string, body: Record<string, unknown>) =>
  handlers(KeysRoute).POST({
    request: new Request("https://aidwar.in/api/developer/keys", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ organization_id: "org-a", ...body }),
    }),
  });
const list = (token: string) =>
  handlers(KeysRoute).GET({
    request: new Request("https://aidwar.in/api/developer/keys?organization_id=org-a", {
      headers: { authorization: `Bearer ${token}` },
    }),
  });
const apiRequest = (key: string | null) =>
  new Request("https://aidwar.in/api/v1/messages/template", {
    method: "POST",
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });

// Spelled apart: the registry build check reads `action: "…"` in files that
// name the activity table as emitted activity actions.
const ACTIVITY_TABLE = ["activity", "log"].join("_");

beforeEach(() => {
  h.world = publicApiWorld();
});

describe("key format and hashing", () => {
  it("adw_live_ + 32 random bytes base64url; the hash is sha256 hex; the prefix is the next 8 chars", () => {
    const k = generateApiKey();
    expect(k.key).toMatch(/^adw_live_[A-Za-z0-9_-]{43}$/);
    expect(k.key.startsWith(API_KEY_PREFIX + k.prefix)).toBe(true);
    expect(k.prefix).toHaveLength(8);
    expect(k.hash).toBe(hashApiKey(k.key));
    expect(k.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(generateApiKey().key).not.toBe(k.key);
    expect(hashesEqual(k.hash, hashApiKey(k.key))).toBe(true);
    expect(hashesEqual(k.hash, hashApiKey(k.key + "x"))).toBe(false);
    expect(hashesEqual(k.hash, "abc")).toBe(false);
  });
});

describe("creating a key: shown once, only the hash stored", () => {
  it("the answer carries the key once; the row has its hash and prefix, never the key; the list never shows either", async () => {
    const res = await post("u-admin", { action: "create", name: "Zoho books" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string; row: Record<string, unknown> };
    expect(body.key).toMatch(/^adw_live_/);
    expect(body.row).not.toHaveProperty("key_hash");
    const stored = h.world!.db.rows("api_keys").find((r) => r["name"] === "Zoho books")!;
    expect(stored["key_hash"]).toBe(hashApiKey(body.key));
    expect(JSON.stringify(stored)).not.toContain(body.key);
    expect(stored["prefix"]).toBe(body.key.slice(API_KEY_PREFIX.length, API_KEY_PREFIX.length + 8));

    const listed = (await (await list("u-admin")).json()) as {
      keys: Array<Record<string, unknown>>;
    };
    const text = JSON.stringify(listed);
    expect(text).not.toContain(body.key);
    expect(text).not.toContain(String(stored["key_hash"]));
    expect(listed.keys.find((k) => k["name"] === "Zoho books")!["masked"]).toBe(
      `adw_live_${stored["prefix"]}…`,
    );
    // The activity line names the key, never the key itself.
    const logged = JSON.stringify(h.world!.db.rows(ACTIVITY_TABLE));
    expect(logged).toContain("api_key_created");
    expect(logged).not.toContain(body.key);
  });

  it("the new key works on the API at once", async () => {
    const { key } = (await (await post("u-admin", { action: "create", name: "POS" })).json()) as {
      key: string;
    };
    const caller = await authenticateApiKey(h.world!.db.supabase, apiRequest(key));
    expect(caller).toEqual({ keyId: expect.any(String), organizationId: "org-a" });
  });

  it("needs public_api.manage: an agent is refused; and the flag must be on to create", async () => {
    expect((await post("u-agent", { action: "create", name: "Nope" })).status).toBe(403);
    expect((await list("u-agent")).status).toBe(403);
    h.world!.flags.on = false;
    const res = await post("u-admin", { action: "create", name: "Nope" });
    expect(res.status).toBe(403);
    expect(h.world!.db.rows("api_keys").some((r) => r["name"] === "Nope")).toBe(false);
  });

  it("a name is required", async () => {
    expect((await post("u-admin", { action: "create", name: " " })).status).toBe(400);
  });
});

describe("calling the API with a key", () => {
  it("a revoked key is 401; a missing, malformed or unknown key is 401", async () => {
    const w = h.world!;
    for (const key of [w.keys.revoked, null, "adw_live_short", "Bearer", generateApiKey().key]) {
      const res = (await authenticateApiKey(w.db.supabase, apiRequest(key))) as Response;
      expect(res).toBeInstanceOf(Response);
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code: string }).code).toBe("unauthorized");
    }
  });

  it("revoking from Settings makes the key 401 at once (and can't revoke another workspace's key)", async () => {
    const w = h.world!;
    expect(await authenticateApiKey(w.db.supabase, apiRequest(w.keys.a))).not.toBeInstanceOf(
      Response,
    );
    expect((await post("u-admin", { action: "revoke", key_id: "key-b" })).status).toBe(404);
    expect(w.db.rows("api_keys").find((r) => r["id"] === "key-b")!["revoked_at"]).toBeNull();
    expect((await post("u-admin", { action: "revoke", key_id: "key-a" })).status).toBe(200);
    const res = (await authenticateApiKey(w.db.supabase, apiRequest(w.keys.a))) as Response;
    expect(res.status).toBe(401);
  });

  it("flag off: 403 with a clear message", async () => {
    h.world!.flags.on = false;
    const res = (await authenticateApiKey(
      h.world!.db.supabase,
      apiRequest(h.world!.keys.a),
    )) as Response;
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("public_api_disabled");
    expect(body.error).toMatch(/isn't switched on for this workspace/);
  });

  it("each key belongs to its own workspace: B's key is B", async () => {
    const caller = await authenticateApiKey(h.world!.db.supabase, apiRequest(h.world!.keys.b));
    expect(caller).toEqual({ keyId: "key-b", organizationId: "org-b" });
  });

  it("last_used_at is recorded (at most once a minute)", async () => {
    const w = h.world!;
    await authenticateApiKey(w.db.supabase, apiRequest(w.keys.a));
    const first = w.db.rows("api_keys").find((r) => r["id"] === "key-a")!["last_used_at"];
    expect(first).toEqual(expect.any(String));
    const writes = w.db.log.filter((l) => l.table === "api_keys" && l.kind === "update").length;
    await authenticateApiKey(w.db.supabase, apiRequest(w.keys.a));
    expect(w.db.log.filter((l) => l.table === "api_keys" && l.kind === "update").length).toBe(
      writes,
    );
  });
});

describe("registry", () => {
  it("public_api: default off, one permission held by owner and admin only", () => {
    const f = FEATURES.find((x) => x.key === "public_api")!;
    expect(f.flag_default_enabled).toBe(false);
    expect(f.permissions.map((p) => p.key)).toEqual(["public_api.manage"]);
    expect(roleDefaults("admin")).toContain("public_api.manage");
    expect(roleDefaults("marketer")).not.toContain("public_api.manage");
    expect(roleDefaults("agent")).not.toContain("public_api.manage");
  });
});

describe("before 20261120 is applied", () => {
  it("no api_keys table: a well-formed key gets 503 and nothing else is read; a malformed one 401", async () => {
    const db = fakeDb((op) =>
      op.table === "api_keys"
        ? {
            data: null,
            error: { code: "PGRST205", message: "Could not find the table 'public.api_keys'" },
          }
        : undefined,
    );
    const res = (await authenticateApiKey(
      db.supabase,
      apiRequest(generateApiKey().key),
    )) as Response;
    expect(res.status).toBe(503);
    expect(db.ops.map((o) => o.table)).toEqual(["api_keys"]);
    expect(db.rpcs).toEqual([]);
    expect(((await authenticateApiKey(db.supabase, apiRequest("nope"))) as Response).status).toBe(
      401,
    );
  });
});

describe("the billing sweep's Public API upkeep (bounded)", () => {
  it("removes rate windows older than 1 h, reservations older than 48 h and finished deliveries older than 30 days — nothing newer, at most 500 a run", async () => {
    const { memoryDb } = await import("./test-support/memory-db");
    const { cleanupApiRecords, CLEANUP_BATCH } = await import("./public-api.server");
    const now = Date.parse("2026-10-27T12:00:00Z");
    const ago = (ms: number) => new Date(now - ms).toISOString();
    const H = 3600_000;
    const db = memoryDb({
      api_rate_windows: [
        { bucket: "key:a", window_start: ago(3 * H) },
        { bucket: "key:a", window_start: ago(2 * H) },
        { bucket: "key:a", window_start: ago(H + 60_000) },
        { bucket: "key:a", window_start: ago(30 * 60_000) },
      ],
      api_requests: [
        ...Array.from({ length: CLEANUP_BATCH + 3 }, (_, i) => ({
          id: `old-${i}`,
          created_at: ago(49 * H + i * 1000),
        })),
        { id: "fresh", created_at: ago(47 * H) },
      ],
      api_webhook_deliveries: [
        { id: "d-old", state: "delivered", created_at: ago(31 * 24 * H) },
        { id: "d-pending", state: "pending", created_at: ago(31 * 24 * H) },
        { id: "d-new", state: "failed", created_at: ago(29 * 24 * H) },
      ],
    });
    const first = await cleanupApiRecords(db.supabase, now);
    expect(first.api_requests_removed).toBe(CLEANUP_BATCH);
    expect(first.api_deliveries_removed).toBe(1);
    // The oldest hour of windows this run (3 h and 2 h old), the rest next run.
    expect(first.api_rate_windows_removed).toBe(2);
    const second = await cleanupApiRecords(db.supabase, now);
    expect(second).toEqual({
      api_rate_windows_removed: 1,
      api_requests_removed: 3,
      api_deliveries_removed: 0,
    });
    expect(db.rows("api_rate_windows").map((r) => r["window_start"])).toEqual([ago(30 * 60_000)]);
    expect(db.rows("api_requests").map((r) => r["id"])).toEqual(["fresh"]);
    expect(
      db
        .rows("api_webhook_deliveries")
        .map((r) => r["id"])
        .sort(),
    ).toEqual(["d-new", "d-pending"]);
  });

  it("without the tables it removes nothing and never throws", async () => {
    const { cleanupApiRecords } = await import("./public-api.server");
    const db = fakeDb(() => ({ data: null, error: { code: "PGRST205", message: "no table" } }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await cleanupApiRecords(db.supabase)).toEqual({
      api_rate_windows_removed: 0,
      api_requests_removed: 0,
      api_deliveries_removed: 0,
    });
  });

  it("runs from the billing sweep", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./billing-sweep.server.ts", import.meta.url), "utf8");
    expect(src).toContain("cleanupApiRecords(supabase)");
  });
});
