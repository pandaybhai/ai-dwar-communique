import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { inVirtualTime } from "./test-support/virtual-time";

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

describe("(4) tests on every change", () => {
  it("package.json runs the suite with `test`", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["test"]).toBe("vitest run");
  });

  it("CI runs typecheck and tests (blocking) and lint (advisory)", () => {
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toMatch(/pull_request:/);
    expect(ci).toMatch(/run: npx tsc --noEmit -p \./);
    expect(ci).toMatch(/run: bun run test/);
    expect(ci).toMatch(/name: Lint \(advisory\)\s+continue-on-error: true\s+run: bun run lint/);
    // Only lint may fail without failing the job.
    expect(ci.match(/continue-on-error: true/g)).toHaveLength(1);
  });

  it("build and test runs never rewrite src/build-info.ts (served in memory, builds only)", () => {
    const cfg = readFileSync(join(ROOT, "vite.config.ts"), "utf8");
    const plugin = cfg.slice(cfg.indexOf("function buildInfoGenerator"), cfg.indexOf("function featureRegistryGuard"));
    expect(plugin).toMatch(/apply: "build"/);
    expect(plugin).toMatch(/load\(id\)/);
    expect(plugin).not.toMatch(/writeFileSync/);
  });

  // .env stays tracked: it holds only public keys and Lovable builds from the
  // repo (VITE_AIDWAR_* has no fallback in src/integrations/aidwar/client.ts).
  it(".env stays tracked (Lovable builds from the repo)", () => {
    let tracked = "";
    try {
      tracked = execFileSync("git", ["ls-files", ".env"], { cwd: ROOT, encoding: "utf8" });
    } catch {
      return; // no git here: nothing to check
    }
    expect(tracked.trim()).toBe(".env");
  });

  it("the virtual clock makes round trips exact: three 40 ms trips in a row are 120 ms, two together 40 ms", async () => {
    const trip = () => new Promise<void>((r) => setTimeout(r, 40));
    const serial = await inVirtualTime(async () => {
      const t = Date.now();
      await trip();
      await Promise.resolve();
      await trip();
      await trip();
      return Date.now() - t;
    });
    expect(serial).toBe(120);
    const together = await inVirtualTime(async () => {
      const t = Date.now();
      await Promise.all([trip(), trip()]);
      return Date.now() - t;
    });
    expect(together).toBe(40);
  });
});
