import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pgAvailable, startScratchPg, type ScratchPg } from "./test-support/scratch-pg";

/**
 * Batch 55 — 20261290 on a real (throwaway) Postgres, applied twice: it adds
 * gst_registered (default false), clears the demo GSTIN/PAN and the
 * "[DEMO GSTIN …]" footer text (keeping the rest), lets invoices.kind be
 * 'invoice', refuses GST on without a real GSTIN, and ends with
 * mcp_block_oauth_writes(). Never the live database.
 */

const dir = import.meta.dirname;
const MIGRATION = join(dir, "../../supabase/aidwar-migrations/20261290_batch55_no_gst.sql");
const ORG = "00000000-0000-0000-0000-0000000055a1";

describe.runIf(pgAvailable() || Boolean(process.env["CI"]))(
  "20261290_batch55_no_gst.sql (real Postgres)",
  () => {
    let pg: ScratchPg;
    beforeAll(() => {
      pg = startScratchPg({
        schemaFile: join(dir, "test-support/batch55-schema.sql"),
        migrations: [MIGRATION, MIGRATION],
      });
    }, 120_000);
    afterAll(() => pg?.stop());

    it("adds gst_registered, off by default", () => {
      expect(pg.sql("select gst_registered from public.platform_settings")).toBe("f");
    });

    it("clears the demo GSTIN and PAN and only the [DEMO GSTIN …] part of the footer", () => {
      expect(
        pg.sql(
          "select coalesce(supplier_gstin, '<null>') || '|' || coalesce(supplier_pan, '<null>') || '|' || invoice_footer from public.platform_settings",
        ),
      ).toBe("<null>|<null>|Thank you for choosing AiDwar. Questions: support@aidwar.in");
    });

    it("refuses GST on without a real GSTIN, allows it with one", () => {
      expect(() => pg.sql("update public.platform_settings set gst_registered = true")).toThrow(
        /platform_settings_gst_needs_gstin/,
      );
      expect(() =>
        pg.sql(
          "update public.platform_settings set supplier_gstin = '36AAACM0000D1Z5', gst_registered = true",
        ),
      ).toThrow(/platform_settings_gst_needs_gstin/);
      pg.sql(
        "update public.platform_settings set supplier_gstin = '36ABCDE1234F1Z5', gst_registered = true",
      );
      expect(pg.sql("select gst_registered from public.platform_settings")).toBe("t");
      pg.sql("update public.platform_settings set gst_registered = false, supplier_gstin = null");
    });

    it("lets an invoice be kind 'invoice' and keeps every kind it had", () => {
      for (const kind of ["tax_invoice", "invoice", "proforma", "credit_note"]) {
        pg.sql(
          `insert into public.invoices (organization_id, kind, purpose) values ('${ORG}', '${kind}', 'adjustment')`,
        );
      }
      expect(() =>
        pg.sql(
          `insert into public.invoices (organization_id, kind, purpose) values ('${ORG}', 'receipt', 'adjustment')`,
        ),
      ).toThrow(/invoices_kind_check/);
    });

    it("one no-GST plan-fee invoice per workspace per period", () => {
      const add = () =>
        pg.sql(
          `insert into public.invoices (organization_id, kind, purpose, status, period_start) values ('${ORG}', 'invoice', 'plan_fee', 'issued', '2026-11-01')`,
        );
      add();
      expect(add).toThrow(/plan_fee_nogst_invoice_period_uidx/);
    });

    it("is additive and ends with mcp_block_oauth_writes()", () => {
      const sql = readFileSync(MIGRATION, "utf8");
      const code = sql.replace(/--.*$/gm, "");
      expect(code).not.toMatch(/\bdrop\s+(table|column|index|function)\b/i);
      expect(code.trim().endsWith("SELECT public.mcp_block_oauth_writes();")).toBe(true);
    });
  },
);
