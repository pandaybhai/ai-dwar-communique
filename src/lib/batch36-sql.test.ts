import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { pgAvailable, startScratchPg, type ScratchPg } from "./test-support/scratch-pg";

/**
 * Batch 36 — 20261140_batch36_opt_in_default.sql on a real (throwaway)
 * Postgres, applied twice: it is idempotent, adds two nullable columns and
 * narrows nothing (opt_in_status keeps its default 'unknown' and its CHECK).
 * Never the live database.
 */

const MIGRATION = join(
  import.meta.dirname,
  "../../supabase/aidwar-migrations/20261140_batch36_opt_in_default.sql",
);
const ORG = "00000000-0000-0000-0000-0000000036a1";

describe.runIf(pgAvailable() || Boolean(process.env["CI"]))(
  "20261140_batch36_opt_in_default.sql (real Postgres)",
  () => {
    let pg: ScratchPg;
    beforeAll(() => {
      pg = startScratchPg({
        schemaFile: join(import.meta.dirname, "test-support/loadtest/schema.sql"),
        migrations: [
          join(import.meta.dirname, "test-support/public-api-stubs.sql"),
          join(import.meta.dirname, "test-support/batch36-stubs.sql"),
          MIGRATION,
          MIGRATION,
        ],
      });
      pg.sql(`
        insert into public.organizations (id, name) values ('${ORG}', 'A');
        insert into public.contacts (organization_id, phone) values ('${ORG}', '+91360001');
      `);
    }, 120_000);
    afterAll(() => pg?.stop());

    it("adds opt_in_source (text) and opted_in_at (timestamptz), both nullable", () => {
      expect(
        pg.sql(`
          select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by column_name)
            from information_schema.columns
           where table_schema = 'public' and table_name = 'contacts'
             and column_name in ('opt_in_source', 'opted_in_at')`),
      ).toBe("opt_in_source:text:YES,opted_in_at:timestamp with time zone:YES");
    });

    it("narrows nothing: a new contact is still 'unknown' with no consent record; the CHECK is unchanged", () => {
      expect(
        pg.sql(`select opt_in_status || ':' || coalesce(opt_in_source, '-') || ':' || coalesce(opted_in_at::text, '-')
                  from public.contacts where phone = '+91360001'`),
      ).toBe("unknown:-:-");
      expect(
        pg.sql("select pg_get_constraintdef(oid) from pg_constraint where conname = 'contacts_opt_in_status_check'"),
      ).toMatch(/opted_in.*opted_out.*unknown/);
      // any source value is accepted (no CHECK on the new column)
      pg.sql(`update public.contacts set opt_in_status = 'opted_in', opt_in_source = 'keyword', opted_in_at = now()
               where phone = '+91360001'`);
      expect(pg.sql("select opt_in_source from public.contacts where phone = '+91360001'")).toBe("keyword");
    });

    it("lists the new activity actions once on the contacts registry row, after the old ones", () => {
      expect(
        pg.sql("select array_to_string(activity_actions, ',') from public.feature_registry where key = 'contacts'"),
      ).toBe("contact_created,optin_changed,contacts_opted_in,contacts_import_consent");
    });
  },
);
