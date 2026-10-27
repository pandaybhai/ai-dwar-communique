import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { pgAvailable, startScratchPg, type ScratchPg } from "./test-support/scratch-pg";

/**
 * Batch 34 — the migration on a real (throwaway) Postgres, applied twice:
 * it is idempotent. Never the live database.
 */

const MIGRATION = join(
  import.meta.dirname,
  "../../supabase/aidwar-migrations/20261120_batch34_public_api.sql",
);
const A = "00000000-0000-0000-0000-0000000000a1";
const B = "00000000-0000-0000-0000-0000000000b2";
const HASH = "a".repeat(64);

describe.runIf(pgAvailable() || Boolean(process.env["CI"]))(
  "20261120_batch34_public_api.sql (real Postgres)",
  () => {
    let pg: ScratchPg;
    beforeAll(() => {
      pg = startScratchPg({
        schemaFile: join(import.meta.dirname, "test-support/loadtest/schema.sql"),
        migrations: [
          join(import.meta.dirname, "test-support/public-api-stubs.sql"),
          PLANS,
          MIGRATION,
          MIGRATION,
        ],
      });
      pg.sql(`
      insert into public.organizations (id, name) values ('${A}', 'A'), ('${B}', 'B');
      insert into public.api_keys (id, organization_id, name, prefix, key_hash)
        values ('00000000-0000-0000-0000-00000000aaa1', '${A}', 'Billing', 'abcdefgh', '${HASH}');
    `);
    }, 120_000);
    afterAll(() => pg?.stop());

    it("(1) the flag is created off, with its registry row and permission for owner and admin", () => {
      expect(
        pg.sql("select default_enabled from public.feature_flags where key = 'public_api'"),
      ).toBe("f");
      expect(pg.sql("select flag_key from public.feature_registry where key = 'public_api'")).toBe(
        "public_api",
      );
      expect(
        pg.sql(
          "select category || '|' || min_role from public.permissions where key = 'public_api.manage'",
        ),
      ).toBe("public_api|admin");
      expect(
        pg.sql(
          "select string_agg(role, ',' order by role) from public.role_permissions where permission_key = 'public_api.manage'",
        ),
      ).toBe("admin,owner");
    });

    it("(1) Scale and Enterprise list public_api once (every version), other plans don't", () => {
      expect(
        pg.sql(
          "select string_agg(p.key || ':' || array_to_string(v.features, '+'), ',' order by p.key, v.id) from public.plan_versions v join public.plans p on p.id = v.plan_id",
        ),
      ).toBe(
        "enterprise:inbox+public_api,growth:inbox,scale:inbox+templates+public_api,scale:inbox+public_api",
      );
    });

    it("(2) api_keys: one row per hash; a member reads every column but key_hash, and may only set revoked_at", () => {
      expect(() =>
        pg.sql(
          `insert into public.api_keys (organization_id, name, prefix, key_hash) values ('${B}', 'Dup', 'zzzzzzzz', '${HASH}')`,
        ),
      ).toThrow(/api_keys_key_hash_key/);
      expect(() =>
        pg.sql(
          `insert into public.api_keys (organization_id, name, prefix, key_hash) values ('${B}', 'Raw', 'zzzzzzzz', 'adw_live_x')`,
        ),
      ).toThrow(/key_hash_check/);

      const asMember = (q: string) =>
        pg.sql(`begin; set local role authenticated; set local test.allow = 'yes'; ${q}; commit;`);
      expect(asMember("select name || '|' || prefix from public.api_keys")).toBe(
        "Billing|abcdefgh",
      );
      expect(() => asMember("select key_hash from public.api_keys")).toThrow(/permission denied/);
      expect(() => asMember("update public.api_keys set name = 'x'")).toThrow(/permission denied/);
      expect(() =>
        asMember(
          `insert into public.api_keys (organization_id, name, prefix, key_hash) values ('${A}', 'n', 'zzzzzzzz', '${"b".repeat(64)}')`,
        ),
      ).toThrow(/permission denied/);
      asMember("update public.api_keys set revoked_at = now()");
      expect(pg.sql("select revoked_at is not null from public.api_keys")).toBe("t");

      // Without public_api.manage the rows aren't there at all.
      expect(
        pg.sql(
          "begin; set local role authenticated; set local test.allow = 'no'; select count(*) from public.api_keys; commit;",
        ),
      ).toBe("0");
    });

    it("(3) api_requests: one reservation per workspace and key — the second identical insert fails", () => {
      pg.sql(
        `insert into public.api_requests (organization_id, idempotency_key, request_hash) values ('${A}', 'inv-1', 'h')`,
      );
      expect(() =>
        pg.sql(
          `insert into public.api_requests (organization_id, idempotency_key, request_hash) values ('${A}', 'inv-1', 'h')`,
        ),
      ).toThrow(/api_requests_org_key_key/);
      // Another workspace's same key is its own.
      pg.sql(
        `insert into public.api_requests (organization_id, idempotency_key, request_hash) values ('${B}', 'inv-1', 'h')`,
      );
      expect(() =>
        pg.sql(
          "begin; set local role authenticated; select count(*) from public.api_requests; commit;",
        ),
      ).toThrow(/permission denied/);
    });

    it("(3) api_rate_take counts every call in the window; over the limit it refuses with seconds to wait", () => {
      const take = () =>
        pg.sql("select allowed || '|' || retry_after from public.api_rate_take('key:t', 3, 3600)");
      expect([take(), take(), take()]).toEqual(["true|0", "true|0", "true|0"]);
      const [allowed, wait] = take().split("|");
      expect(allowed).toBe("false");
      expect(Number(wait)).toBeGreaterThanOrEqual(1);
      expect(Number(wait)).toBeLessThanOrEqual(3600);
      expect(pg.sql("select hits from public.api_rate_windows where bucket = 'key:t'")).toBe("4");
      // Another bucket is counted on its own.
      expect(pg.sql("select allowed from public.api_rate_take('key:u', 3, 60)")).toBe("t");
      expect(() =>
        pg.sql(
          "begin; set local role authenticated; select public.api_rate_take('x', 1, 60); commit;",
        ),
      ).toThrow(/permission denied/);
    });

    it("(1)(4) a rebuilt check keeps every value the old one allowed — not only the stored ones — plus the new one", () => {
      // permissions: 'cards' was allowed with no permission using it.
      const perm = pg.sql(
        "select pg_get_constraintdef(oid) from pg_constraint where conname = 'permissions_category_check'",
      );
      for (const v of ["inbox", "templates", "billing", "cards", "public_api"])
        expect(perm).toContain(`'${v}'`);
      pg.sql("insert into public.permissions (key, category) values ('cards.check', 'cards')");
      pg.sql("delete from public.permissions where key = 'cards.check'");
      // workspace_connections: live allows 'cashfree' and has no rows; it stays allowed.
      const prov = pg.sql(
        "select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.workspace_connections'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%provider%'",
      );
      for (const v of ["google", "razorpay", "cashfree", "api_webhook"])
        expect(prov).toContain(`'${v}'`);
      pg.sql(
        `insert into public.workspace_connections (organization_id, provider) values ('${B}', 'cashfree')`,
      );
      pg.sql(`delete from public.workspace_connections where organization_id = '${B}'`);
    });

    it("(4) workspace_connections takes the api_webhook provider (and still refuses an unknown one)", () => {
      pg.sql(
        `insert into public.workspace_connections (organization_id, provider, public_config) values ('${A}', 'api_webhook', '{"url":"https://x.example.com"}')`,
      );
      pg.sql(
        `insert into public.workspace_connections (organization_id, provider) values ('${A}', 'google')`,
      );
      expect(() =>
        pg.sql(
          `insert into public.workspace_connections (organization_id, provider) values ('${A}', 'other')`,
        ),
      ).toThrow(/check/);
      // One webhook per workspace.
      expect(() =>
        pg.sql(
          `insert into public.workspace_connections (organization_id, provider) values ('${A}', 'api_webhook')`,
        ),
      ).toThrow(/duplicate key/);
    });

    it("(4) deliveries: one per (message, event) — PostgREST's ignore-duplicates upsert writes once; a claim leases, a second claim skips it", () => {
      pg.sql(`
        insert into public.conversations (id, organization_id) values ('00000000-0000-0000-0000-0000000c0001', '${A}');
        insert into public.messages (id, organization_id, conversation_id, direction, type, status, metadata)
          values ('00000000-0000-0000-0000-00000000d001', '${A}', '00000000-0000-0000-0000-0000000c0001', 'outbound', 'template', 'sent', '{"source":"api"}');
      `);
      const upsert = `insert into public.api_webhook_deliveries (organization_id, message_id, event, payload, occurred_at)
        values ('${A}', '00000000-0000-0000-0000-00000000d001', 'message.sent', '{}', now())
        on conflict (message_id, event) do nothing`;
      pg.sql(upsert);
      pg.sql(upsert);
      expect(pg.sql("select count(*) from public.api_webhook_deliveries")).toBe("1");
      // A test event has no message: many are fine.
      pg.sql(
        `insert into public.api_webhook_deliveries (organization_id, event, payload, occurred_at) values ('${A}', 'webhook.test', '{}', now()), ('${A}', 'webhook.test', '{}', now())`,
      );
      expect(() =>
        pg.sql(
          `insert into public.api_webhook_deliveries (organization_id, event, payload, occurred_at) values ('${A}', 'message.bounced', '{}', now())`,
        ),
      ).toThrow(/event_check/);

      expect(pg.sql("select count(*) from public.api_webhook_claim(10, 120)")).toBe("3");
      expect(pg.sql("select count(*) from public.api_webhook_claim(10, 120)")).toBe("0");
      expect(
        pg.sql("select count(*) from public.api_webhook_deliveries where lease_until > now()"),
      ).toBe("3");
      // Not due yet, or no longer pending: never claimed.
      pg.sql("update public.api_webhook_deliveries set lease_until = null");
      pg.sql(
        "update public.api_webhook_deliveries set next_attempt_at = now() + interval '1 minute' where event = 'message.sent'",
      );
      pg.sql(
        "update public.api_webhook_deliveries set state = 'delivered' where event = 'webhook.test'",
      );
      expect(pg.sql("select count(*) from public.api_webhook_claim(10, 120)")).toBe("0");
      expect(() =>
        pg.sql(
          "begin; set local role authenticated; select * from public.api_webhook_claim(1, 1); commit;",
        ),
      ).toThrow(/permission denied/);

      // The message (or its workspace) deleted: its deliveries go with it.
      pg.sql("delete from public.messages where id = '00000000-0000-0000-0000-00000000d001'");
      expect(
        pg.sql("select count(*) from public.api_webhook_deliveries where message_id is not null"),
      ).toBe("0");
    });
  },
);

const PLANS = join(import.meta.dirname, "test-support/public-api-plans.sql");
