import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cronSecretAccepted } from "./cron-auth.server";

/**
 * The cron secret was once committed in plain text in three Lovable
 * migrations (supabase/migrations/20260814100*). It is rotated
 * (docs/cron-secret-rotation.md), the files now read it from the Vault, and
 * this keeps any secret value out of the repo for good.
 */

function files(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, ext, out);
    else if (ext.test(name)) out.push(path);
  }
  return out;
}

describe("the cron secret is never in the repo", () => {
  it("no SQL file carries an x-cron-secret value: every job reads it from the Vault", () => {
    const sql = files("supabase", /\.sql$/);
    expect(sql.length).toBeGreaterThan(100);
    for (const f of sql) {
      const text = readFileSync(f, "utf8");
      // A JSON header with a value ("<CRON_SECRET>" placeholders in old docs-only files are fine).
      expect(text, f).not.toMatch(/"x-cron-secret"\s*:\s*"(?!<CRON_SECRET>")[^"]+"/i);
      // A jsonb_build_object pair with a literal value.
      expect(text, f).not.toMatch(/'x-cron-secret'\s*,\s*'[^']+'/i);
    }
    for (const f of files("supabase/migrations", /\.sql$/)) {
      const text = readFileSync(f, "utf8");
      if (/x-cron-secret/i.test(text)) {
        expect(text, f).toContain(
          "(select decrypted_secret from vault.decrypted_secrets where name = 'aidwar_cron_secret')",
        );
      }
    }
  });

  it("no app source, script or workflow names a value for it either", () => {
    const sources = [
      ...files("src", /\.(ts|tsx|mjs|js)$/).filter((f) => !/\.test\.tsx?$|test-support/.test(f)),
      ...files("scripts", /\.(mjs|js|ts|sql|sh)$/),
      ...files(".github", /\.ya?ml$/),
    ];
    for (const f of sources) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/CRON_SECRET\s*[:=]\s*["'][A-Za-z0-9_-]{12,}["']/);
      expect(text, f).not.toMatch(/x-cron-secret["']?\s*[:,]\s*["'][A-Za-z0-9_-]{12,}["']/i);
    }
  });

  it("every internal route checks the header through cronSecretAccepted (no route reads CRON_SECRET itself)", () => {
    const routes = files("src/routes/api/internal", /\.ts$/);
    const checked = routes.filter((f) => /x-cron-secret/i.test(readFileSync(f, "utf8")));
    expect(checked.length).toBe(15);
    for (const f of checked) {
      const text = readFileSync(f, "utf8");
      expect(text, f).toContain("cronSecretAccepted(");
      expect(text, f).not.toContain('process.env["CRON_SECRET"]');
    }
  });
});

describe("rotation without a missed cron run", () => {
  it("only CRON_SECRET matches normally", () => {
    const env = { CRON_SECRET: "new-secret-value-1234" };
    expect(cronSecretAccepted("new-secret-value-1234", env)).toBe(true);
    expect(cronSecretAccepted("old-secret-value-1234", env)).toBe(false);
    expect(cronSecretAccepted(null, env)).toBe(false);
    expect(cronSecretAccepted("", env)).toBe(false);
  });

  it("while CRON_SECRET_PREVIOUS is set, the old value still works; once it's removed, it doesn't", () => {
    const during = {
      CRON_SECRET: "new-secret-value-1234",
      CRON_SECRET_PREVIOUS: "old-secret-value-1234",
    };
    expect(cronSecretAccepted("old-secret-value-1234", during)).toBe(true);
    expect(cronSecretAccepted("new-secret-value-1234", during)).toBe(true);
    expect(cronSecretAccepted("other-value-12345678", during)).toBe(false);
    expect(
      cronSecretAccepted("old-secret-value-1234", { CRON_SECRET: "new-secret-value-1234" }),
    ).toBe(false);
  });

  it("unset or empty secrets never match anything (not even an empty header)", () => {
    expect(cronSecretAccepted("", {})).toBe(false);
    expect(cronSecretAccepted("x", {})).toBe(false);
    expect(cronSecretAccepted("", { CRON_SECRET: "", CRON_SECRET_PREVIOUS: " " })).toBe(false);
    expect(cronSecretAccepted(" ", { CRON_SECRET: " " })).toBe(false);
  });
});
