/**
 * A throwaway local Postgres 16 for SQL tests (Batch 26a). Test-only; never
 * imported by the app. Starts in a temp directory, loads the load-test schema
 * (production tables and billing function bodies, loadtest/schema.sql), then
 * the given migrations, and is thrown away by stop().
 *
 * pgAvailable() is false when Postgres 16 isn't installed, so callers can
 * skip; on CI (CI=true) a missing Postgres is an error instead, so these
 * tests never silently stop running there.
 */
import { execFileSync } from "node:child_process";
import { chownSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PG_BIN = "/usr/lib/postgresql/16/bin";

export function pgAvailable(): boolean {
  return existsSync(`${PG_BIN}/initdb`) && existsSync(`${PG_BIN}/pg_ctl`);
}

export type ScratchPg = {
  /** Runs SQL, returns psql's unaligned, tuples-only output. Throws on error. */
  sql: (text: string) => string;
  /** The same for a SQL file (for text too long for a command line). */
  file: (path: string) => string;
  stop: () => void;
};

function asPostgres(cmd: string, args: string[]): string {
  const root = typeof process.getuid === "function" && process.getuid() === 0;
  const [bin, argv] = root ? ["runuser", ["-u", "postgres", "--", cmd, ...args]] : [cmd, args];
  return execFileSync(bin, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function startScratchPg(opts: { schemaFile: string; migrations: string[] }): ScratchPg {
  const port = 55_000 + Math.floor(Math.random() * 5_000);
  const data = mkdtempSync(join(tmpdir(), "aidwar-scratch-pg-"));
  try {
    chownSync(
      data,
      Number(execFileSync("id", ["-u", "postgres"], { encoding: "utf8" }).trim()),
      Number(execFileSync("id", ["-g", "postgres"], { encoding: "utf8" }).trim()),
    );
  } catch {
    // not root: the directory is already ours
  }
  asPostgres(`${PG_BIN}/initdb`, ["-D", data, "-A", "trust", "-U", "postgres", "--no-sync"]);
  writeFileSync(
    join(data, "postgresql.auto.conf"),
    [
      `port = ${port}`,
      `listen_addresses = '127.0.0.1'`,
      `unix_socket_directories = '${data}'`,
      "shared_preload_libraries = 'pg_stat_statements'",
      "fsync = off",
      "log_min_messages = warning",
    ].join("\n") + "\n",
  );
  asPostgres(`${PG_BIN}/pg_ctl`, ["-D", data, "-l", join(data, "server.log"), "-w", "start"]);

  const base = ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-At"];
  const stop = () => {
    try {
      asPostgres(`${PG_BIN}/pg_ctl`, ["-D", data, "-m", "immediate", "stop"]);
    } catch {
      // already gone
    }
    rmSync(data, { recursive: true, force: true });
  };
  try {
    execFileSync("psql", [...base, "-d", "postgres", "-c", "create database scratch"]);
    for (const file of [opts.schemaFile, ...opts.migrations]) {
      execFileSync("psql", [...base, "-d", "scratch", "-f", file], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    }
  } catch (error) {
    stop();
    throw error;
  }
  const sql = (text: string) =>
    execFileSync("psql", [...base, "-d", "scratch", "-c", text], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const file = (path: string) =>
    execFileSync("psql", [...base, "-d", "scratch", "-f", path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  return { sql, file, stop };
}
