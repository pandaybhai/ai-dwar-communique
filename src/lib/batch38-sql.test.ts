import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { pgAvailable, startScratchPg, type ScratchPg } from "./test-support/scratch-pg";

/**
 * Batch 38 — 20261160 on a real (throwaway) Postgres, after Batch 34's file,
 * applied twice: it is idempotent. Never the live database.
 */

const dir = import.meta.dirname;
const MIGRATION = join(dir, "../../supabase/aidwar-migrations/20261160_batch38_public_api_v12.sql");
const A = "00000000-0000-0000-0000-0000000000a1";
const B = "00000000-0000-0000-0000-0000000000b2";
const U = "00000000-0000-0000-0000-0000000000c3";

describe.runIf(pgAvailable() || Boolean(process.env["CI"]))(
  "20261160_batch38_public_api_v12.sql (real Postgres)",
  () => {
    let pg: ScratchPg;
    beforeAll(() => {
      pg = startScratchPg({
        schemaFile: join(dir, "test-support/loadtest/schema.sql"),
        migrations: [
          join(dir, "test-support/public-api-stubs.sql"),
          join(dir, "test-support/public-api-plans.sql"),
          join(dir, "../../supabase/aidwar-migrations/20261120_batch34_public_api.sql"),
          join(dir, "test-support/batch37-stubs.sql"),
          join(dir, "../../supabase/aidwar-migrations/20261150_batch37_public_api_v11.sql"),
          join(dir, "test-support/batch38-stubs.sql"),
          // Rows that exist before the file is applied.
          join(dir, "test-support/batch38-seed.sql"),
          MIGRATION,
          MIGRATION,
        ],
      });
    }, 120_000);
    afterAll(() => pg?.stop());

    it("(1) campaign.completed is allowed, once per campaign by dedupe_key; every value allowed before still is", () => {
      const def = pg.sql(
        "select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.api_webhook_deliveries'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%event%'",
      );
      for (const v of [
        "message.sent",
        "message.delivered",
        "message.read",
        "message.failed",
        "webhook.test",
        "campaign.completed",
      ])
        expect(def).toContain(`'${v}'`);
      const queue = () =>
        pg.sql(
          `insert into public.api_webhook_deliveries (organization_id, event, payload, occurred_at, dedupe_key)
           values ('${A}', 'campaign.completed', '{}', now(), 'campaign.completed:c1')
           on conflict (organization_id, dedupe_key) do nothing`,
        );
      queue();
      queue();
      expect(
        pg.sql(
          "select count(*) from public.api_webhook_deliveries where dedupe_key = 'campaign.completed:c1'",
        ),
      ).toBe("1");
      // Another workspace's same key is its own; an unknown event is still refused.
      pg.sql(
        `insert into public.api_webhook_deliveries (organization_id, event, payload, occurred_at, dedupe_key) values ('${B}', 'campaign.completed', '{}', now(), 'campaign.completed:c1')`,
      );
      expect(() =>
        pg.sql(
          `insert into public.api_webhook_deliveries (organization_id, event, payload, occurred_at) values ('${A}', 'campaign.exploded', '{}', now())`,
        ),
      ).toThrow(/check/);
    });

    it("(2) conversations.updated_at: existing rows untouched (NULL), set by the trigger on every update from now on", () => {
      expect(pg.sql("select count(*) from public.conversations where updated_at is null")).toBe(
        "4",
      );
      pg.sql(
        "update public.conversations set status = 'closed' where id = '00000000-0000-0000-0000-000000000001'",
      );
      expect(
        pg.sql(
          "select updated_at > now() - interval '1 minute' from public.conversations where id = '00000000-0000-0000-0000-000000000001'",
        ),
      ).toBe("t");
      pg.sql(
        `insert into public.conversations (id, organization_id) values ('00000000-0000-0000-0000-000000000004', '${A}')`,
      );
      expect(
        pg.sql(
          "select updated_at is not null from public.conversations where id = '00000000-0000-0000-0000-000000000004'",
        ),
      ).toBe("t");
      pg.sql(
        "update public.conversations set status = 'open' where id = '00000000-0000-0000-0000-000000000001'",
      );
    });

    it("(2) api_list_conversations: one workspace, oldest change first, cursor, filters; service role only", () => {
      const ids = (args: string) =>
        pg.sql(
          `select string_agg(right(id::text, 1), ',') from public.api_list_conversations(${args})`,
        );
      // ...3 (created 15 Sep, no message), ...2 (2 Oct), then ...4 (made) and ...1 (updated again) just now.
      expect(ids(`'${A}'`)).toBe("3,2,4,1");
      expect(ids(`'${A}', 2`)).toBe("3,2");
      expect(
        ids(`'${A}', 10, '2026-10-02T00:00:00Z', '00000000-0000-0000-0000-000000000002'`),
      ).toBe("4,1");
      expect(ids(`'${A}', 10, null, null, 'closed'`)).toBe("2");
      expect(ids(`'${A}', 10, null, null, null, null, false, now() - interval '1 minute'`)).toBe(
        "4,1",
      );
      pg.sql(
        `update public.conversations set assigned_to = '${U}' where id = '00000000-0000-0000-0000-000000000002'`,
      );
      expect(ids(`'${A}', 10, null, null, null, '${U}'`)).toBe("2");
      expect(ids(`'${A}', 10, null, null, null, null, true`)).toBe("3,4,1");
      expect(ids(`'${B}'`)).toBe("9");
      expect(pg.sql(`select count(*) from public.api_list_conversations('${A}', 100000)`)).toBe(
        "4",
      );
      expect(() =>
        pg.sql(
          `begin; set local role authenticated; select * from public.api_list_conversations('${A}'); commit;`,
        ),
      ).toThrow(/permission denied/);
    });

    it("(3) api_console_credentials: a sha256 only, at most 10 minutes, unreadable to members", () => {
      pg.sql(
        `insert into public.api_console_credentials (organization_id, created_by, token_hash, expires_at) values ('${A}', '${U}', '${"a".repeat(64)}', now() + interval '10 minutes')`,
      );
      expect(() =>
        pg.sql(
          `insert into public.api_console_credentials (organization_id, created_by, token_hash, expires_at) values ('${A}', '${U}', '${"a".repeat(64)}', now() + interval '5 minutes')`,
        ),
      ).toThrow(/api_console_credentials_token_hash_key/);
      expect(() =>
        pg.sql(
          `insert into public.api_console_credentials (organization_id, created_by, token_hash, expires_at) values ('${A}', '${U}', 'adw_console_x', now() + interval '5 minutes')`,
        ),
      ).toThrow(/check/);
      expect(() =>
        pg.sql(
          `insert into public.api_console_credentials (organization_id, created_by, token_hash, expires_at) values ('${A}', '${U}', '${"b".repeat(64)}', now() + interval '11 minutes')`,
        ),
      ).toThrow(/check/);
      expect(() =>
        pg.sql(
          "begin; set local role authenticated; set local test.allow = 'yes'; select count(*) from public.api_console_credentials; commit;",
        ),
      ).toThrow(/permission denied/);
    });

    it("(4) the inbox's registry row lists the two new activity actions once", () => {
      expect(
        pg.sql(
          "select array_to_string(activity_actions, ',') from public.feature_registry where key = 'inbox'",
        ),
      ).toBe(
        "contact_tags_changed,conversation_assigned,conversation_closed,conversation_reopened",
      );
    });

    it("(1) the account events are allowed too, and every Batch 37 event still is", () => {
      const def = pg.sql(
        "select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.api_webhook_deliveries'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%event%'",
      );
      for (const v of [
        "message.received",
        "contact.created",
        "template.status_changed",
        "phone_number.quality_changed",
        "account.status_changed",
        "messaging_limit.changed",
      ])
        expect(def).toContain(`'${v}'`);
    });

    it("(5) the Settings webhook became entry #1: same url, every event, the SAME secret; its row is kept", () => {
      expect(
        pg.sql(
          `select url || '|' || coalesce(array_to_string(events, ','), 'ALL') || '|' || status || '|' || legacy from public.api_webhook_endpoints_for('${A}')`,
        ),
      ).toBe("https://legacy.example.com/aidwar|ALL|active|true");
      expect(pg.sql(`select secret from public.api_webhook_endpoints_for('${A}')`)).toBe(
        "whsec_legacy_original",
      );
      expect(
        pg.sql("select count(*) from public.workspace_connections where provider = 'api_webhook'"),
      ).toBe("1");
      // Applied twice, read again: still one copy.
      expect(
        pg.sql(`select count(*) from public.api_webhook_endpoints where organization_id = '${A}'`),
      ).toBe("1");
      // The table never holds a secret.
      expect(
        pg.sql(
          "select count(*) from public.api_webhook_endpoints where secret_vault_name like 'api_webhook_endpoint_%'",
        ),
      ).toBe("1");
    });

    it("(5) at most 5 webhooks per workspace; https only; the secret set and removed through Vault", () => {
      for (let i = 2; i <= 5; i += 1)
        pg.sql(
          `insert into public.api_webhook_endpoints (organization_id, url) values ('${A}', 'https://h${i}.example.com')`,
        );
      expect(() =>
        pg.sql(
          `insert into public.api_webhook_endpoints (organization_id, url) values ('${A}', 'https://h6.example.com')`,
        ),
      ).toThrow(/webhook_limit_reached/);
      expect(() =>
        pg.sql(
          `insert into public.api_webhook_endpoints (organization_id, url) values ('${B}', 'http://plain.example.com')`,
        ),
      ).toThrow(/check/);
      const id = pg.sql(
        `insert into public.api_webhook_endpoints (organization_id, url) values ('${B}', 'https://b.example.com') returning id`,
      );
      pg.sql(`select public.api_webhook_endpoint_set_secret('${id}', 'whsec_b')`);
      expect(pg.sql(`select secret from public.api_webhook_endpoints_for('${B}')`)).toBe("whsec_b");
      pg.sql(`select public.api_webhook_endpoint_delete('${id}')`);
      expect(
        pg.sql(`select count(*) from vault.secrets where name = 'api_webhook_endpoint_${id}'`),
      ).toBe("0");
      // Removing entry #1 removes the Settings row it came from, so it isn't copied back.
      const legacy = pg.sql(
        `select id from public.api_webhook_endpoints where legacy_connection_id is not null`,
      );
      pg.sql(`select public.api_webhook_endpoint_delete('${legacy}')`);
      expect(
        pg.sql("select count(*) from public.workspace_connections where provider = 'api_webhook'"),
      ).toBe("0");
      expect(
        pg.sql(`select count(*) from public.api_webhook_endpoints_for('${A}') where legacy`),
      ).toBe("0");
      for (const fn of [
        `public.api_webhook_endpoints_for('${A}')`,
        `public.api_webhook_adopt_legacy('${A}')`,
      ])
        expect(() => pg.sql(`begin; set local role authenticated; select ${fn}; commit;`)).toThrow(
          /permission denied/,
        );
      expect(() =>
        pg.sql(
          "begin; set local role authenticated; set local test.allow = 'yes'; select count(*) from public.api_webhook_endpoints; commit;",
        ),
      ).toThrow(/permission denied/);
    });

    it("(5) attempts: one row per (delivery, webhook)", () => {
      const ep = pg.sql(
        `select id from public.api_webhook_endpoints where organization_id = '${A}' limit 1`,
      );
      const d = pg.sql(
        `insert into public.api_webhook_deliveries (organization_id, event, payload, occurred_at) values ('${A}', 'webhook.test', '{}', now()) returning id`,
      );
      pg.sql(
        `insert into public.api_webhook_attempts (delivery_id, endpoint_id) values ('${d}', '${ep}')`,
      );
      expect(() =>
        pg.sql(
          `insert into public.api_webhook_attempts (delivery_id, endpoint_id) values ('${d}', '${ep}')`,
        ),
      ).toThrow(/api_webhook_attempts_pkey/);
    });
  },
);
