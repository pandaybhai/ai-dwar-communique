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
        migrations: [join(import.meta.dirname, "test-support/public-api-stubs.sql"), B34],
      });
      pg.sql(`
        insert into public.organizations (id, name) values ('${A}', 'A'), ('${B}', 'B');
        insert into public.messages (id, organization_id, direction) values ('${MSG}', '${A}', 'inbound');
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
  },
);
