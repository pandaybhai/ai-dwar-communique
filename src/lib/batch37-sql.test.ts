import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { pgAvailable, startScratchPg, type ScratchPg } from "./test-support/scratch-pg";

/**
 * Batch 37 — 20261150_batch37_public_api_v11.sql on a real (throwaway)
 * Postgres, after Batch 34's file: before it the new events are refused;
 * applied twice (idempotent), the event CHECK keeps every value it allowed
 * and adds the new ones, and dedupe_key dedupes. Never the live database.
 */

const B34 = join(
  import.meta.dirname,
  "../../supabase/aidwar-migrations/20261120_batch34_public_api.sql",
);
const B37 = join(
  import.meta.dirname,
  "../../supabase/aidwar-migrations/20261150_batch37_public_api_v11.sql",
);
const A = "00000000-0000-0000-0000-0000000000a1";
const B = "00000000-0000-0000-0000-0000000000b2";
const MSG = "00000000-0000-0000-0000-00000000c001";

/** One queued event: about MSG when it is message.received, else with an optional dedupe key. */
const insertEvent = (event: string, dedupeKey = "") =>
  `insert into public.api_webhook_deliveries (organization_id, message_id, event, payload, occurred_at, dedupe_key)
   values ('${A}', ${event === "message.received" ? `'${MSG}'` : "null"}, '${event}', '{}'::jsonb, now(), ${dedupeKey ? `'${dedupeKey}'` : "null"})`;

describe.runIf(pgAvailable() || Boolean(process.env["CI"]))(
  "20261150_batch37_public_api_v11.sql (real Postgres)",
  () => {
    let pg: ScratchPg;
    beforeAll(() => {
      pg = startScratchPg({
        schemaFile: join(import.meta.dirname, "test-support/loadtest/schema.sql"),
        migrations: [
          join(import.meta.dirname, "test-support/public-api-stubs.sql"),
          join(import.meta.dirname, "test-support/batch37-stubs.sql"),
          B34,
        ],
      });
      pg.sql(`
        insert into public.organizations (id, name) values ('${A}', 'A'), ('${B}', 'B');
        insert into public.messages (id, organization_id, direction) values ('${MSG}', '${A}', 'inbound');
        insert into public.contacts (id, organization_id, phone, opt_in_status, updated_at) values
          ('00000000-0000-0000-0000-0000000000d1', '${A}', '+911', 'opted_in', '2026-10-01 00:00:01.000001+00'),
          ('00000000-0000-0000-0000-0000000000d2', '${A}', '+912', 'unknown',  '2026-10-01 00:00:01.000002+00'),
          ('00000000-0000-0000-0000-0000000000d3', '${A}', '+913', 'opted_out', '2026-10-01 00:00:01.000002+00'),
          ('00000000-0000-0000-0000-0000000000d4', '${B}', '+914', 'opted_in', '2026-10-01 00:00:00+00');
        insert into public.tags (id, organization_id, name) values
          ('00000000-0000-0000-0000-0000000000e1', '${A}', 'VIP'),
          ('00000000-0000-0000-0000-0000000000e2', '${B}', 'vip');
        insert into public.contact_tags (contact_id, tag_id, organization_id) values
          ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000e1', '${A}'),
          ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000e2', '${B}');
      `);
    }, 120_000);
    afterAll(() => pg?.stop());

    it("before the file: Batch 34's queue refuses the new events (the code logs and goes on)", () => {
      expect(() =>
        pg.sql(
          `insert into public.api_webhook_deliveries (organization_id, message_id, event, payload, occurred_at) values ('${A}', '${MSG}', 'message.received', '{}', now())`,
        ),
      ).toThrow(/api_webhook_deliveries_event_check/);
      expect(() =>
        pg.sql(
          `insert into public.api_webhook_deliveries (organization_id, event, payload, occurred_at, dedupe_key) values ('${A}', 'contact.created', '{}', now(), 'k')`,
        ),
      ).toThrow(/dedupe_key/);
    });

    it("(3) applied twice: every old event still allowed, the new ones too", () => {
      pg.file(B37);
      pg.file(B37);
      const def = pg.sql(
        "select pg_get_constraintdef(oid) from pg_constraint where conname = 'api_webhook_deliveries_event_check'",
      );
      for (const e of [
        "message.sent",
        "message.delivered",
        "message.read",
        "message.failed",
        "webhook.test",
        "message.received",
        "contact.created",
        "contact.opted_out",
        "contact.opted_in",
        "template.status_changed",
        "template.category_changed",
      ])
        expect(def, e).toContain(`'${e}'`);
      expect(() => pg.sql(insertEvent("not.an.event"))).toThrow(/event_check/);
    });

    it("(3) one message.received per message; one contact.created per dedupe key; null keys never collide", () => {
      const once = (q: string) => pg.sql(`${q} on conflict do nothing`);
      once(insertEvent("message.received"));
      once(insertEvent("message.received"));
      once(insertEvent("contact.created", "contact.created:c1"));
      once(insertEvent("contact.created", "contact.created:c1"));
      once(insertEvent("contact.opted_out", "contact.opted_out:c1:1"));
      // PostgREST's on_conflict target exists as a plain unique index.
      pg.sql(
        `insert into public.api_webhook_deliveries (organization_id, event, payload, occurred_at, dedupe_key)
         values ('${A}', 'contact.created', '{}', now(), 'contact.created:c1')
         on conflict (organization_id, dedupe_key) do nothing`,
      );
      pg.sql(
        `insert into public.api_webhook_deliveries (organization_id, event, payload, occurred_at)
         values ('${A}', 'webhook.test', '{}', now()), ('${A}', 'webhook.test', '{}', now())`,
      );
      expect(
        pg.sql(
          "select string_agg(event || ':' || count, ',' order by event) from (select event, count(*) from public.api_webhook_deliveries group by event) s",
        ),
      ).toBe("contact.created:1,contact.opted_out:1,message.received:1,webhook.test:2");
    });

    it("(4) api_list_contacts: (updated_at, id) pages past a microsecond cursor, filters, tags; only the given workspace; service role only", () => {
      const page = (args: string) =>
        pg.sql(
          `select string_agg(phone || ':' || array_to_string(tags, '+'), ',') from public.api_list_contacts(${args})`,
        );
      expect(page(`'${A}', 2`)).toBe("+911:,+912:VIP");
      // The cursor is the last row's exact updated_at (microseconds) and id.
      expect(
        page(`'${A}', 10, '2026-10-01 00:00:01.000002+00', '00000000-0000-0000-0000-0000000000d2'`),
      ).toBe("+913:");
      expect(page(`'${A}', 10, null, null, 'vip'`)).toBe("+912:VIP");
      expect(page(`'${A}', 10, null, null, null, 'opted_out'`)).toBe("+913:");
      expect(page(`'${A}', 10, null, null, null, null, '2026-10-01 00:00:01.000002+00'`)).toBe(
        "+912:VIP,+913:",
      );
      expect(page(`'${B}', 10`)).toBe("+914:vip");
      expect(page(`'${A}', 1000`).split(",")).toHaveLength(3);
      expect(() =>
        pg.sql(
          `begin; set local role authenticated; select * from public.api_list_contacts('${A}'); commit;`,
        ),
      ).toThrow(/permission denied/);
      expect(
        pg.sql("select count(*) from pg_indexes where indexname = 'contacts_org_updated_idx'"),
      ).toBe("1");
    });
  },
);
