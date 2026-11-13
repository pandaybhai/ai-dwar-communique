import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pgAvailable, startScratchPg, type ScratchPg } from "./test-support/scratch-pg";

/**
 * Batch 80 — 20261430 (the Basic plan, pay Meta directly) on a real,
 * throwaway Postgres, applied twice after the demo_leads migrations and
 * stand-ins for the live billing tables (test-support/batch80-stubs.sql).
 * Never the live DB.
 */

const dir = import.meta.dirname;
const M = (f: string) => join(dir, "../../supabase/aidwar-migrations", f);
const MIGRATION = M("20261430_batch80.sql");
const BASE_DEBIT = "20261066_live_only_billing.sql";
const BASE_AI = "20261084_batch28_ai_answers_only_replies.sql";

/** A function's body from a migration file (CREATE OR REPLACE … to the next end $function$;). */
function fnBody(file: string, name: string): string {
  const sql = readFileSync(M(file), "utf8");
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const end = sql.indexOf("end $function$;", start);
  return sql.slice(start, end);
}

describe("20261430, as text", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  it("ends with the two OAuth guards; no data is changed for an existing workspace", () => {
    expect(
      sql
        .trim()
        .endsWith(
          "SELECT public.mcp_block_oauth_writes();\nSELECT public.mcp_block_oauth_reads();",
        ),
    ).toBe(true);
    // Top-level statements only (a function body's own lines are indented).
    expect(sql).not.toMatch(/^(UPDATE|DELETE|DROP TABLE|DROP COLUMN)\b/im);
    // Basic: hidden from /pricing and the plan chooser, ₹999 / ₹9,990, the plan's own limits.
    expect(sql).toContain(
      "VALUES ('basic', 'Basic', 'Your AI salesperson on WhatsApp. Pay Meta directly — zero markup.', 5, true, false)",
    );
    expect(sql).toContain("SELECT p.id, 1, 999, 9990, 'INR',");
    expect(sql).toContain(
      `'{"numbers": 1, "members": 2, "pages": 100, "ai_answers": 300, "ai_monthly_cap": 300}'::jsonb`,
    );
    for (const f of ["'cashfree_billing'", "'meta_direct_billing'", "'ai_features'", "'billing'"]) {
      expect(sql).toContain(f);
    }
    // The flag is OFF by default: only Basic's features turn it on.
    expect(sql).toMatch(/'meta_direct_billing',\s*'Pays Meta directly',[\s\S]*?,\s*false\s*\)/);
  });

  it("the two billing functions are the live bodies plus exactly one Batch 80 rule each", () => {
    const strip = (s: string) =>
      s
        .split("\n")
        .filter((l) => !/Batch 80|meta_direct_billing/.test(l))
        .join("\n")
        .replace(/\s+/g, " ")
        .trim();
    const mineDebit = fnBody("20261430_batch80.sql", "billing_debit_message");
    expect(strip(mineDebit)).toBe(strip(fnBody(BASE_DEBIT, "billing_debit_message")));
    expect(mineDebit).toContain(
      "if public.org_flag_enabled(m.organization_id, 'meta_direct_billing') then return false; end if;",
    );
    const mineAi = fnBody("20261430_batch80.sql", "trg_ai_runs_billing");
    // The live body's last condition loses its "then" to the new line that carries it.
    expect(strip(mineAi).replace("'billing') then", "'billing')")).toBe(
      strip(fnBody(BASE_AI, "trg_ai_runs_billing")).replace("'billing') then", "'billing')"),
    );
    expect(mineAi).toContain(
      "and not public.org_flag_enabled(new.organization_id, 'meta_direct_billing') then",
    );
  });
});

describe.runIf(pgAvailable() || Boolean(process.env["CI"]))(
  "20261430_batch80.sql (real Postgres)",
  () => {
    let pg: ScratchPg;
    beforeAll(() => {
      pg = startScratchPg({
        schemaFile: join(dir, "test-support/batch76-schema.sql"),
        migrations: [
          M("20260915_demo_leads.sql"),
          M("20261380_batch72.sql"),
          M("20261400_batch76.sql"),
          M("20261410_batch77.sql"),
          M("20261420_batch78.sql"),
          join(dir, "test-support/batch80-stubs.sql"),
          MIGRATION,
          MIGRATION,
        ],
      });
      // Another plan (an existing one) for the "unchanged" checks.
      pg.sql(`
        insert into public.plans (key, name, is_public) values ('growth', 'Growth', true);
        insert into public.plan_versions (plan_id, price_monthly, features)
          select id, 4999, array['billing','ai_features'] from public.plans where key = 'growth';
        insert into public.feature_flags (key, default_enabled) values ('billing', false) on conflict do nothing;
      `);
    }, 120_000);
    afterAll(() => pg?.stop());

    const one = (q: string) => pg.sql(q).trim();
    const org = (plan: string, funding: string | null = null) =>
      one(
        `insert into public.organizations (name, funding_model, billing_enabled_at) values ('${plan} shop', ${funding ? `'${funding}'` : "null"}, now() - interval '1 day') returning id`,
      );
    const onPlan = (orgId: string, plan: string) =>
      pg.sql(
        `update public.organizations set plan_version_id = (select v.id from public.plan_versions v join public.plans p on p.id = v.plan_id where p.key = '${plan}') where id = '${orgId}'`,
      );

    it("Basic exists once (applied twice), hidden, ₹999, and its flag is off by default", () => {
      expect(one(`select count(*) from public.plans where key = 'basic'`)).toBe("1");
      expect(
        one(
          `select count(*) from public.plan_versions v join public.plans p on p.id = v.plan_id where p.key = 'basic'`,
        ),
      ).toBe("1");
      expect(
        one(
          `select p.is_public::text || ' ' || v.price_monthly || ' ' || v.price_annual from public.plans p join public.plan_versions v on v.plan_id = p.id where p.key = 'basic'`,
        ),
      ).toBe("false 999 9990");
      expect(
        one(`select default_enabled from public.feature_flags where key = 'meta_direct_billing'`),
      ).toBe("f");
      expect(
        one(`select flag_key from public.feature_registry where key = 'meta_direct_billing'`),
      ).toBe("meta_direct_billing");
    });

    it("a workspace moved onto Basic is meta_direct; another plan leaves funding alone", () => {
      const a = org("basic", "aidwar_prepaid");
      onPlan(a, "basic");
      expect(one(`select funding_model from public.organizations where id = '${a}'`)).toBe(
        "meta_direct",
      );
      const b = org("growth", "aidwar_prepaid");
      onPlan(b, "growth");
      expect(one(`select funding_model from public.organizations where id = '${b}'`)).toBe(
        "aidwar_prepaid",
      );
    });

    it("a message from a Basic workspace is never debited; any other workspace's still is (ZOORI unchanged)", () => {
      const basic = org("basic");
      onPlan(basic, "basic");
      const zoori = org("growth", "meta_direct");
      onPlan(zoori, "growth");
      for (const o of [basic, zoori]) {
        pg.sql(
          `insert into public.organization_feature_overrides values ('${o}', 'billing', true) on conflict do nothing`,
        );
      }
      const msg = (o: string) =>
        one(
          `insert into public.messages (organization_id, pricing_category, cost_amount) values ('${o}', 'marketing', 0.8631) returning id`,
        );
      expect(one(`select public.billing_debit_message('${msg(basic)}')`)).toBe("f");
      expect(
        one(`select count(*) from public.wallet_ledger where organization_id = '${basic}'`),
      ).toBe("0");
      expect(one(`select public.billing_debit_message('${msg(zoori)}')`)).toBe("t");
      expect(
        one(
          `select amount from public.wallet_ledger where organization_id = '${zoori}' and entry_type = 'debit_message'`,
        ),
      ).toBe("-1.04");
    });

    it("AI answers past the allowance: no debit on Basic; still debited on another plan", () => {
      const basic = org("basic");
      onPlan(basic, "basic");
      const other = org("growth");
      onPlan(other, "growth");
      for (const o of [basic, other]) {
        pg.sql(
          `insert into public.organization_feature_overrides values ('${o}', 'billing', true) on conflict do nothing`,
        );
        // allowance is 2 in the stand-in: the third answer is over it.
        for (let i = 0; i < 3; i++) {
          pg.sql(
            `insert into public.ai_runs (organization_id, status, task, conversation_id, billed_amount) values ('${o}', 'ok', 'agent_reply', gen_random_uuid(), 0.5)`,
          );
        }
      }
      expect(
        one(
          `select count(*) from public.wallet_ledger where organization_id = '${basic}' and entry_type = 'debit_ai'`,
        ),
      ).toBe("0");
      expect(
        one(
          `select count(*) from public.wallet_ledger where organization_id = '${other}' and entry_type = 'debit_ai'`,
        ),
      ).toBe("1");
      // The month's count is still kept for Basic (the inbox hand-over reads it).
      expect(
        one(`select answers from public.ai_usage_months where organization_id = '${basic}'`),
      ).toBe("3");
    });

    it("demo_leads: a /999 lead needs no /demo answers; /demo still does; /start unchanged", () => {
      const ins = (source: string) =>
        pg.sql(
          `insert into public.demo_leads (phone, consent, consent_version, source, name, business_name) values ('+919812345670', true, 'v', '${source}', 'Asha', 'Asha Jewellers') returning id`,
        );
      expect(() => ins("landing_999")).not.toThrow();
      expect(() => ins("landing_start")).not.toThrow();
      expect(() => ins("landing")).toThrow(/demo_leads_qualified_unless_landing/);
      expect(
        one(
          `select count(*) from information_schema.columns where table_name = 'demo_leads' and column_name in ('checkout_at', 'paid_at', 'payment_id')`,
        ),
      ).toBe("3");
    });
  },
);
