import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { pgAvailable, startScratchPg, type ScratchPg } from "./test-support/scratch-pg";

/**
 * Batch 51 — 20261250 on a real (throwaway) Postgres, applied twice: it is
 * idempotent and additive. RLS on the two new tables is checked as the
 * authenticated role with has_permission / auth.uid answering from settings.
 * Never the live database.
 */

const dir = import.meta.dirname;
const MIGRATION = join(dir, "../../supabase/aidwar-migrations/20261250_batch51_gaps.sql");
const A = "00000000-0000-0000-0000-0000000051a1";
const B = "00000000-0000-0000-0000-0000000051b2";
const U = "00000000-0000-0000-0000-0000000051c3";
const V = "00000000-0000-0000-0000-0000000051d4";
const CA = "00000000-0000-0000-0000-00000051ca01";
const CB = "00000000-0000-0000-0000-00000051cb01";
const SA = "00000000-0000-0000-0000-000000515a01";

describe.runIf(pgAvailable() || Boolean(process.env["CI"]))(
  "20261250_batch51_gaps.sql (real Postgres)",
  () => {
    let pg: ScratchPg;
    beforeAll(() => {
      pg = startScratchPg({
        schemaFile: join(dir, "test-support/loadtest/schema.sql"),
        migrations: [join(dir, "test-support/batch51-stubs.sql"), MIGRATION, MIGRATION],
      });
      pg.sql(`
        insert into public.organizations (id, name) values ('${A}', 'Shop A'), ('${B}', 'Shop B');
        insert into public.contacts (id, organization_id, phone) values ('${CA}', '${A}', '+911'), ('${CB}', '${B}', '+912');
        insert into public.segments (id, organization_id, name) values ('${SA}', '${A}', 'Picked by hand');
      `);
    }, 120_000);
    afterAll(() => pg?.stop());

    /** One statement as a signed-in member of a workspace with these permissions. */
    const as = (uid: string, perms: string, statement: string) =>
      pg.sql(
        `begin; set local role authenticated; set local test.uid = '${uid}'; set local test.perms = '${perms}'; ${statement}; commit;`,
      );

    it("adds message_templates.deleted_at (nullable) and lists template_deleted once", () => {
      expect(
        pg.sql(
          "select is_nullable || ':' || data_type from information_schema.columns where table_name = 'message_templates' and column_name = 'deleted_at'",
        ),
      ).toBe("YES:timestamp with time zone");
      expect(
        pg.sql(
          "select array_to_string(activity_actions, ',') from public.feature_registry where key = 'templates'",
        ),
      ).toBe("template_created,template_deleted,template_synced");
      expect(
        pg.sql(
          "select array_to_string(activity_actions, ',') from public.feature_registry where key = 'contacts'",
        ),
      ).toBe("contact_created,contact_note_added,contact_note_deleted,segment_created");
      expect(
        pg.sql(
          "select array_to_string(data_tables, ',') from public.feature_registry where key = 'contacts'",
        ),
      ).toBe("contact_notes,contacts,segment_members,segments");
    });

    it("segment_members: segments.manage adds this workspace's customers only; contacts.view reads", () => {
      as(
        U,
        "segments.manage",
        `insert into public.segment_members (segment_id, contact_id, organization_id, added_by) values ('${SA}', '${CA}', '${A}', '${U}')`,
      );
      // Another workspace's customer, or no segments.manage: refused by RLS.
      expect(() =>
        as(
          U,
          "segments.manage",
          `insert into public.segment_members (segment_id, contact_id, organization_id) values ('${SA}', '${CB}', '${A}')`,
        ),
      ).toThrow(/row-level security/);
      expect(() =>
        as(
          U,
          "contacts.view",
          `insert into public.segment_members (segment_id, contact_id, organization_id) values ('${SA}', '${CA}', '${A}')`,
        ),
      ).toThrow(/row-level security/);
      expect(as(U, "contacts.view", "select count(*) from public.segment_members")).toContain("1");
      expect(as(U, "", "select count(*) from public.segment_members")).toContain("0");
    });

    it("contact_notes: written as yourself with contacts.edit or inbox.reply, deleted only by the writer", () => {
      as(
        U,
        "contacts.view,inbox.reply",
        `insert into public.contact_notes (organization_id, contact_id, author_id, body) values ('${A}', '${CA}', '${U}', 'Prefers a call after 6 pm')`,
      );
      as(
        V,
        "contacts.view,contacts.edit",
        `insert into public.contact_notes (organization_id, contact_id, body) values ('${A}', '${CA}', 'Gift wrap every order')`,
      );
      // auth.uid() is the default writer.
      expect(
        pg.sql(`select author_id from public.contact_notes where body = 'Gift wrap every order'`),
      ).toBe(V);
      // Writing as someone else, without the permission, or for another workspace's customer: refused.
      expect(() =>
        as(
          U,
          "contacts.view,inbox.reply",
          `insert into public.contact_notes (organization_id, contact_id, author_id, body) values ('${A}', '${CA}', '${V}', 'x')`,
        ),
      ).toThrow(/row-level security/);
      expect(() =>
        as(
          U,
          "contacts.view",
          `insert into public.contact_notes (organization_id, contact_id, body) values ('${A}', '${CA}', 'x')`,
        ),
      ).toThrow(/row-level security/);
      expect(() =>
        as(
          U,
          "contacts.view,contacts.edit",
          `insert into public.contact_notes (organization_id, contact_id, body) values ('${A}', '${CB}', 'x')`,
        ),
      ).toThrow(/row-level security/);
      // An empty note isn't a note.
      expect(() =>
        as(
          U,
          "contacts.view,contacts.edit",
          `insert into public.contact_notes (organization_id, contact_id, body) values ('${A}', '${CA}', '   ')`,
        ),
      ).toThrow(/check constraint/);
      // Read with contacts.view; nothing without it.
      expect(as(U, "contacts.view", "select count(*) from public.contact_notes")).toContain("2");
      expect(as(U, "inbox.reply", "select count(*) from public.contact_notes")).toContain("0");
      // U can't delete V's note; V can.
      as(
        U,
        "contacts.view,contacts.edit",
        "delete from public.contact_notes where body = 'Gift wrap every order'",
      );
      expect(pg.sql("select count(*) from public.contact_notes")).toBe("2");
      as(
        V,
        "contacts.view",
        "delete from public.contact_notes where body = 'Gift wrap every order'",
      );
      expect(pg.sql("select count(*) from public.contact_notes")).toBe("1");
      // No update path at all.
      expect(() =>
        as(U, "contacts.view,contacts.edit", "update public.contact_notes set body = 'changed'"),
      ).toThrow(/permission denied/);
    });

    it("rows go with their segment or customer", () => {
      pg.sql(`delete from public.segments where id = '${SA}'`);
      expect(pg.sql("select count(*) from public.segment_members")).toBe("0");
      pg.sql(`delete from public.contacts where id = '${CA}'`);
      expect(pg.sql("select count(*) from public.contact_notes")).toBe("0");
    });
  },
);
