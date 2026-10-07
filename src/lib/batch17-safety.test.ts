import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Batch 17 — lock the doors, nothing lost.
 * Each item adds its own describe block below.
 */

const ROOT = new URL("../../", import.meta.url).pathname;
const migration = (name: string) =>
  readFileSync(join(ROOT, "supabase/aidwar-migrations", name), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

/** Code that runs in the browser: not *.server.ts, not api routes, not tests. */
function browserFiles(): string[] {
  return walk(join(ROOT, "src")).filter(
    (p) =>
      !/\.server\.tsx?$/.test(p) &&
      !/\.test\.tsx?$/.test(p) &&
      !p.includes("/routes/api/") &&
      !p.includes("/test-support/") &&
      !p.includes("/src/server/"),
  );
}

describe("(1) workspace DB functions are server-only", () => {
  const sql = migration("20261030_batch17_function_grants.sql");
  const fns = [
    "ai_month_spend(uuid)",
    "org_flag_enabled(uuid, text)",
    "record_knowledge_use(uuid, uuid[])",
    "seed_org_ai_skills(uuid)",
  ];

  it("revokes each from public, anon and authenticated and keeps service_role", () => {
    for (const fn of fns) {
      const esc = fn.replace(/[()[\]]/g, "\\$&");
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${esc} FROM public, anon, authenticated;`));
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${esc} TO service_role;`));
    }
  });

  it("is idempotent, bounded by lock_timeout, and never changes a body or data", () => {
    expect(sql).toMatch(/SET lock_timeout = '5s';/);
    expect(sql).not.toMatch(/^\s*(CREATE|DROP|ALTER|UPDATE|INSERT|DELETE)\b/im);
  });

  it("no browser code calls them (so no caller loses access)", () => {
    const callers = browserFiles().filter((p) =>
      /\.rpc\(\s*["'](ai_month_spend|org_flag_enabled|record_knowledge_use|seed_org_ai_skills)["']/.test(
        readFileSync(p, "utf8"),
      ),
    );
    expect(callers).toEqual([]);
  });
});
