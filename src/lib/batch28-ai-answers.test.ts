import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgAvailable, startScratchPg, type ScratchPg } from "./test-support/scratch-pg";
import { fakeDb } from "./test-support/fake-db";
import { CUSTOMER_ANSWER_TASK, isCustomerAnswer, onlyCustomerAnswers } from "./ai-answers";

/**
 * Batch 28 item 11 — the AI allowance counted background work as customer
 * answers: trg_ai_runs_billing counted every ok ai_runs row (863 "answers" in
 * a month, 799 of them extract_facts; 272 over_answers that were all
 * extract_facts), and the over-allowance debit followed that count.
 *
 * An answer is now task 'agent_reply' with a conversation, minus background
 * work done inside a chat (metadata.purpose, e.g. reading a customer's photo)
 * and the owner's onboarding chat (metadata.channel 'onboarding'). Tested on
 * real Postgres with the live bodies (20261066), Batch 26a, then 20261084.
 */

const dir = join(import.meta.dirname, "../../supabase/aidwar-migrations");
const LIVE = join(dir, "20261066_live_only_billing.sql");
const WALLET = join(dir, "20261065_batch26a_wallet.sql");
const MIGRATION = join(dir, "20261084_batch28_ai_answers_only_replies.sql");
const SCHEMA = join(import.meta.dirname, "test-support/loadtest/schema.sql");
const STUBS = join(import.meta.dirname, "test-support/wallet-stubs.sql");
const runSql = pgAvailable() || Boolean(process.env["CI"]);

describe.runIf(runSql)("item 11 — what counts as an AI answer (real Postgres)", () => {
  let pg: ScratchPg;
  beforeAll(() => {
    pg = startScratchPg({ schemaFile: SCHEMA, migrations: [STUBS, LIVE, WALLET, MIGRATION] });
  }, 120_000);
  afterAll(() => pg?.stop());

  /** Billing on, `allowance` answers included, `credits` in the wallet. */
  const workspace = (allowance: number, credits = 100): string => {
    const id = pg.sql(
      `insert into organizations (name, billing_enabled_at) values ('Store', now() - interval '1 day') returning id`,
    );
    pg.sql(`insert into organization_billing_settings values ('${id}', 0)`);
    pg.sql(
      `update organization_billing_settings set ai_answers_included_override = ${allowance} where organization_id = '${id}'`,
    );
    if (credits > 0) pg.sql(`select wallet_apply('${id}', 'credit_purchase', ${credits})`);
    return id;
  };
  const run = (
    org: string,
    task: string,
    opts: { conversation?: boolean; metadata?: Record<string, unknown> } = {},
  ) =>
    pg.sql(
      `insert into ai_runs (organization_id, status, task, conversation_id, metadata, billed_amount, cost_amount)
       values ('${org}', 'ok', '${task}', ${opts.conversation === false ? "null" : "gen_random_uuid()"},
               '${JSON.stringify(opts.metadata ?? {})}'::jsonb, 2, 0.4) returning id`,
    );
  const month = (org: string) => {
    const [answers, over] = pg
      .sql(`select answers, over_answers from ai_usage_months where organization_id = '${org}'`)
      .split("|")
      .map(Number);
    return { answers, over };
  };
  const aiDebits = (org: string) =>
    Number(
      pg.sql(
        `select count(*) from wallet_ledger where organization_id = '${org}' and entry_type = 'debit_ai'`,
      ),
    );

  it("extract_facts (website reading) does not count and is never charged", () => {
    const org = workspace(0);
    for (let i = 0; i < 3; i++) run(org, "extract_facts", { conversation: false });
    expect(month(org)).toEqual({ answers: 0, over: 0 });
    expect(aiDebits(org)).toBe(0);
  });

  it("drafts, summaries, labels, Try me, the onboarding chat and a customer's photo read do not count", () => {
    const org = workspace(0);
    run(org, "suggest_reply");
    run(org, "summarise");
    run(org, "auto_tag");
    run(org, "agent_reply", { conversation: false });
    run(org, "agent_reply", { metadata: { channel: "onboarding", session_id: "s1" } });
    run(org, "agent_reply", { metadata: { purpose: "customer_image" } });
    expect(month(org)).toEqual({ answers: 0, over: 0 });
    expect(aiDebits(org)).toBe(0);
  });

  it("an agent_reply in a customer conversation counts", () => {
    const org = workspace(5);
    run(org, "agent_reply");
    run(org, "extract_facts", { conversation: false });
    run(org, "agent_reply");
    expect(month(org)).toEqual({ answers: 2, over: 0 });
    expect(aiDebits(org)).toBe(0);
  });

  it("an agent_reply over the allowance still debits — once, and background work between doesn't use the allowance up", () => {
    const org = workspace(1);
    for (let i = 0; i < 5; i++) run(org, "extract_facts", { conversation: false });
    run(org, "agent_reply"); // the one included answer
    expect(aiDebits(org)).toBe(0);
    const over = run(org, "agent_reply");
    expect(month(org)).toEqual({ answers: 2, over: 1 });
    expect(
      pg.sql(
        `select entry_type || ' ' || amount from wallet_ledger where reference_type = 'ai_run' and reference_id = '${over}'`,
      ),
    ).toBe("debit_ai -2.00");
    expect(pg.sql(`select billing_debit_ai_run('${over}')`)).toBe("f"); // never twice
  });

  it("billing_debit_ai_run (the sweep's retry) never charges background work", () => {
    const org = workspace(0);
    const reading = run(org, "extract_facts", { conversation: false });
    expect(pg.sql(`select billing_debit_ai_run('${reading}')`)).toBe("f");
    const answer = pg.sql(
      `insert into ai_runs (organization_id, status, task, conversation_id, billed_amount, cost_amount)
       values ('${org}', 'ok', 'agent_reply', gen_random_uuid(), 2, 0.4) returning id`,
    );
    // Charged by the trigger already (allowance 0) — the retry finds it charged.
    expect(pg.sql(`select billing_debit_ai_run('${answer}')`)).toBe("f");
    expect(aiDebits(org)).toBe(1);
  });

  it("the back-fill recounts this IST month from the rule, touches only ai_usage_months, and runs twice cleanly", () => {
    const org = workspace(1);
    run(org, "agent_reply");
    run(org, "extract_facts", { conversation: false });
    // What the old trigger had written.
    pg.sql(
      `update ai_usage_months set answers = 863, over_answers = 862 where organization_id = '${org}'`,
    );
    const ledgerBefore = pg.sql(`select count(*), coalesce(sum(amount), 0) from wallet_ledger`);
    pg.sql(readFileSync(MIGRATION, "utf8"));
    expect(month(org)).toEqual({ answers: 1, over: 0 });
    pg.sql(readFileSync(MIGRATION, "utf8"));
    expect(month(org)).toEqual({ answers: 1, over: 0 });
    expect(pg.sql(`select count(*), coalesce(sum(amount), 0) from wallet_ledger`)).toBe(
      ledgerBefore,
    );
  });
});

describe("item 11 — the new bodies are the old ones plus the filter only", () => {
  const body = (file: string, name: string) => {
    const s = readFileSync(join(dir, file), "utf8");
    const i = s.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    return s.slice(i, s.indexOf("$function$;", i) + 11);
  };
  /** Undo exactly the Batch 28 edits; what is left must be the live body byte for byte. */
  const unfilter = (sql: string) =>
    sql
      .replace(
        /\n\s*and public\.ai_run_is_customer_answer\(new\.task, new\.conversation_id, new\.metadata\)/,
        "",
      )
      .replace(
        /\n\s*and public\.ai_run_is_customer_answer\(task, conversation_id, metadata\);/,
        ";",
      )
      .replace(
        "count(*) filter (where public.ai_run_is_customer_answer(task, conversation_id, metadata)) answers",
        "count(*) answers",
      )
      .replace(", created_at, task, conversation_id, metadata\n", ", created_at\n")
      .replace(
        /\n\s*if not public\.ai_run_is_customer_answer\(r\.task, r\.conversation_id, r\.metadata\) then return false; end if;/,
        "",
      );

  it("trg_ai_runs_billing = 20261066's live body + the answer filter", () => {
    expect(
      unfilter(body("20261084_batch28_ai_answers_only_replies.sql", "trg_ai_runs_billing")),
    ).toBe(body("20261066_live_only_billing.sql", "trg_ai_runs_billing"));
  });

  it("billing_debit_ai_run = 20261065's body + the answer filter", () => {
    expect(
      unfilter(body("20261084_batch28_ai_answers_only_replies.sql", "billing_debit_ai_run")),
    ).toBe(body("20261065_batch26a_wallet.sql", "billing_debit_ai_run"));
  });

  it("the back-fill writes ai_usage_months only — no ledger or wallet statement", () => {
    // Outside the function bodies: the statements the file itself runs.
    const sql = readFileSync(MIGRATION, "utf8")
      .replace(/--.*$/gm, "")
      .replace(/\$function\$[\s\S]*?\$function\$/g, "");
    const writes = [...sql.matchAll(/\b(UPDATE|INSERT INTO|DELETE FROM)\s+public\.(\w+)/gi)].map(
      (m) => m[2],
    );
    expect(writes).toEqual(["ai_usage_months"]);
  });
});

describe("item 11 — the app counts answers the same way", () => {
  it("isCustomerAnswer: agent_reply in a conversation only", () => {
    const base = { status: "ok", task: CUSTOMER_ANSWER_TASK, conversation_id: "cv1", metadata: {} };
    expect(isCustomerAnswer(base)).toBe(true);
    expect(isCustomerAnswer({ ...base, task: "extract_facts" })).toBe(false);
    expect(isCustomerAnswer({ ...base, task: "suggest_reply" })).toBe(false);
    expect(isCustomerAnswer({ ...base, conversation_id: null })).toBe(false);
    expect(isCustomerAnswer({ ...base, metadata: { channel: "onboarding" } })).toBe(false);
    expect(isCustomerAnswer({ ...base, metadata: { purpose: "customer_image" } })).toBe(false);
    expect(isCustomerAnswer({ ...base, status: "error" })).toBe(false);
  });

  it("the Billing page's 'AI answers used' and the statement count with the same filters", async () => {
    const db = fakeDb(() => ({ data: null, error: null, count: 0 }));
    await onlyCustomerAnswers(
      db.supabase.from("ai_runs").select("id", { count: "exact", head: true }),
    );
    const op = db.ops[0]!;
    expect(db.has(op, "eq", "status", "ok")).toBe(true);
    expect(db.has(op, "eq", "task", "agent_reply")).toBe(true);
    expect(db.has(op, "not", "conversation_id", "is", null)).toBe(true);
    expect(db.has(op, "is", "metadata->>purpose", null)).toBe(true);
    for (const file of ["billing.server.ts", "billing-statement.server.ts"]) {
      const src = readFileSync(join(import.meta.dirname, file), "utf8");
      const counts = [
        ...src.matchAll(
          /\.from\("ai_runs"\)\s*\.select\("id", \{ count: "exact", head: true \}\)/g,
        ),
      ].length;
      const filtered = [...src.matchAll(/onlyCustomerAnswers\(\s*supabase\s*\.from\("ai_runs"\)/g)]
        .length;
      // Every ai_runs count is an answer count except the statement's escalations.
      expect(filtered, file).toBe(counts - (file === "billing-statement.server.ts" ? 1 : 0));
    }
  });
});
