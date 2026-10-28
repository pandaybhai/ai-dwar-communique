import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { pgAvailable, startScratchPg, type ScratchPg } from "./test-support/scratch-pg";

/**
 * Batch 35 — the migration on a real (throwaway) Postgres, applied twice: it
 * is idempotent. Deleting a flow ends its active runs (status 'ended',
 * end_reason 'flow_deleted') in one call and keeps runs, events and the
 * flow; restore undoes it within 30 days; the purge removes the definition
 * only. Never the live database.
 */

const MIGRATION = join(
  import.meta.dirname,
  "../../supabase/aidwar-migrations/20261130_batch35_merchant_asks.sql",
);
const ORG = "00000000-0000-0000-0000-0000000000a1";
const FLOW = "00000000-0000-0000-0000-0000000000f1";
const OLD = "00000000-0000-0000-0000-0000000000f2";
const STORE = "00000000-0000-0000-0000-0000000000f3";
const V_PUB = "00000000-0000-0000-0000-00000000aa01";
const V_DRAFT = "00000000-0000-0000-0000-00000000aa02";
const V_OLD_PUB = "00000000-0000-0000-0000-00000000aa03";
const V_OLD_DRAFT = "00000000-0000-0000-0000-00000000aa04";
const ACTOR = "00000000-0000-0000-0000-0000000000e1";

describe.runIf(pgAvailable() || Boolean(process.env["CI"]))(
  "20261130_batch35_merchant_asks.sql (real Postgres)",
  () => {
    let pg: ScratchPg;
    beforeAll(() => {
      pg = startScratchPg({
        schemaFile: join(import.meta.dirname, "test-support/loadtest/schema.sql"),
        migrations: [
          join(import.meta.dirname, "test-support/public-api-stubs.sql"),
          join(import.meta.dirname, "test-support/flows-stubs.sql"),
          MIGRATION,
          MIGRATION,
        ],
      });
      pg.sql(`
      insert into public.organizations (id, name) values ('${ORG}', 'A');
      insert into public.contacts (id, organization_id, phone) values
        ('00000000-0000-0000-0000-0000000000c1', '${ORG}', '+911'),
        ('00000000-0000-0000-0000-0000000000c2', '${ORG}', '+912'),
        ('00000000-0000-0000-0000-0000000000c3', '${ORG}', '+913'),
        ('00000000-0000-0000-0000-0000000000c4', '${ORG}', '+914');
      insert into public.flows (id, organization_id, key, name, is_enabled, config) values
        ('${FLOW}', '${ORG}', 'v2:menu', 'Menu', true, '{"v2": true}'),
        ('${OLD}', '${ORG}', 'v2:old', 'Old', false, '{"v2": true}'),
        ('${STORE}', '${ORG}', 'abandoned_checkout', 'Cart', true, '{}');
      insert into public.flow_versions (id, organization_id, flow_id, version, status) values
        ('${V_PUB}', '${ORG}', '${FLOW}', 1, 'published'),
        ('${V_DRAFT}', '${ORG}', '${FLOW}', 2, 'draft'),
        ('${V_OLD_PUB}', '${ORG}', '${OLD}', 1, 'published'),
        ('${V_OLD_DRAFT}', '${ORG}', '${OLD}', 2, 'draft');
      insert into public.flow_runs (organization_id, flow_id, version_id, contact_id, current_node_id, status, waiting_for, wake_at) values
        ('${ORG}', '${FLOW}', '${V_PUB}', '00000000-0000-0000-0000-0000000000c1', 'ask', 'waiting', 'reply', now()),
        ('${ORG}', '${FLOW}', '${V_PUB}', '00000000-0000-0000-0000-0000000000c2', 'wait', 'paused', null, null),
        ('${ORG}', '${FLOW}', '${V_PUB}', '00000000-0000-0000-0000-0000000000c3', 'send', 'running', null, null),
        ('${ORG}', '${FLOW}', '${V_PUB}', '00000000-0000-0000-0000-0000000000c4', 'end', 'done', null, null),
        ('${ORG}', '${OLD}', '${V_OLD_PUB}', '00000000-0000-0000-0000-0000000000c1', 'end', 'done', null, null);
      insert into public.flow_triggers (organization_id, flow_id, kind, config) values
        ('${ORG}', '${FLOW}', 'keyword', '{"keywords": ["menu"]}'),
        ('${ORG}', '${OLD}', 'keyword', '{"keywords": ["old"]}');
      insert into public.flow_http_secrets (organization_id, flow_id, scope) values ('${ORG}', '${OLD}', 'https://api.example.com/x');
    `);
    }, 120_000);
    afterAll(() => pg?.stop());

    it("(1)(3)(4) registry rows list the new activity actions once, after the old ones", () => {
      expect(
        pg.sql(
          "select array_to_string(activity_actions, ',') from public.feature_registry where key = 'campaigns'",
        ),
      ).toBe("campaign_created,campaign_test_sent");
      expect(
        pg.sql(
          "select array_to_string(activity_actions, ',') from public.feature_registry where key = 'settings'",
        ),
      ).toBe(
        "organization.created,whatsapp_profile_updated,whatsapp_profile_photo_updated,whatsapp_display_name_requested",
      );
      expect(
        pg.sql(
          "select array_to_string(activity_actions, ',') from public.feature_registry where key = 'flows_v2'",
        ),
      ).toBe("flow_v2_created,flow_v2_restored,flow_v2_deleted,flow_v2_undeleted");
    });

    it("(4) the status check keeps every old value and allows 'ended'", () => {
      const def = pg.sql(
        "select pg_get_constraintdef(oid) from pg_constraint where conname = 'flow_runs_status_check'",
      );
      for (const v of [
        "running",
        "waiting",
        "paused",
        "done",
        "failed",
        "expired",
        "cancelled",
        "ended",
      ])
        expect(def).toContain(`'${v}'`);
    });

    it("(4) delete: one call marks the flow, switches it off and ends every active run silently; history stays", () => {
      expect(pg.sql(`select public.flow_soft_delete('${ORG}', '${FLOW}', '${ACTOR}')`)).toBe("3");
      expect(
        pg.sql(
          `select is_enabled || '|' || (config ? 'deleted_at') || '|' || (config->>'enabled_before') from public.flows where id = '${FLOW}'`,
        ),
      ).toBe("false|true|true");
      expect(
        pg.sql(
          `select string_agg(current_node_id || ':' || status || ':' || coalesce(end_reason, '-'), ',' order by current_node_id) from public.flow_runs where flow_id = '${FLOW}'`,
        ),
      ).toBe("ask:ended:flow_deleted,end:done:-,send:ended:flow_deleted,wait:ended:flow_deleted");
      expect(
        pg.sql(
          `select count(*) from public.flow_runs where flow_id = '${FLOW}' and status = 'ended' and wake_at is null and waiting_for is null and ended_at is not null`,
        ),
      ).toBe("3");
      expect(
        pg.sql(
          `select count(*) || '|' || min(detail->>'reason') from public.flow_run_events where event = 'ended'`,
        ),
      ).toBe("3|flow_deleted");
      // Again: nothing more happens.
      expect(pg.sql(`select public.flow_soft_delete('${ORG}', '${FLOW}', '${ACTOR}')`)).toBe("0");
      expect(pg.sql(`select count(*) from public.flow_run_events`)).toBe("3");
      // A built-in store flow is never touched.
      expect(() =>
        pg.sql(`select public.flow_soft_delete('${ORG}', '${STORE}', '${ACTOR}')`),
      ).toThrow(/FLOW_NOT_FOUND/);
    });

    it("(4) restore within 30 days puts the flow back exactly; ended runs stay ended", () => {
      expect(pg.sql(`select public.flow_restore_deleted('${ORG}', '${FLOW}')`)).toBe("t");
      expect(
        pg.sql(
          `select is_enabled || '|' || (config ? 'deleted_at') || '|' || config::text from public.flows where id = '${FLOW}'`,
        ),
      ).toBe('true|false|{"v2": true}');
      expect(
        pg.sql(
          `select count(*) from public.flow_runs where flow_id = '${FLOW}' and status = 'ended'`,
        ),
      ).toBe("3");
    });

    it("(4) purge after 30 days: the definition goes, the flow row, run history and the versions runs use stay; no restore", () => {
      pg.sql(`select public.flow_soft_delete('${ORG}', '${OLD}', '${ACTOR}');
            update public.flows set config = jsonb_set(config, '{deleted_at}', to_jsonb(now() - interval '31 days')) where id = '${OLD}';`);
      expect(() => pg.sql(`select public.flow_restore_deleted('${ORG}', '${OLD}')`)).toThrow(
        /FLOW_RESTORE_EXPIRED/,
      );
      expect(pg.sql("select public.purge_deleted_flows()")).toBe("1");
      expect(
        pg.sql(`select count(*) from public.flows where id = '${OLD}' and config ? 'purged_at'`),
      ).toBe("1");
      expect(
        pg.sql(
          `select string_agg(id::text, ',') from public.flow_versions where flow_id = '${OLD}'`,
        ),
      ).toBe(V_OLD_PUB);
      expect(pg.sql(`select count(*) from public.flow_runs where flow_id = '${OLD}'`)).toBe("1");
      expect(pg.sql(`select count(*) from public.flow_http_secrets where flow_id = '${OLD}'`)).toBe(
        "0",
      );
      expect(
        pg.sql(
          `select is_enabled || '|' || config::text from public.flow_triggers where flow_id = '${OLD}'`,
        ),
      ).toBe("false|{}");
      // The live flow and its triggers are untouched; a second purge does nothing.
      expect(pg.sql(`select count(*) from public.flow_versions where flow_id = '${FLOW}'`)).toBe(
        "2",
      );
      expect(pg.sql(`select is_enabled from public.flow_triggers where flow_id = '${FLOW}'`)).toBe(
        "t",
      );
      expect(pg.sql("select public.purge_deleted_flows()")).toBe("0");
    });
  },
);
