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
import {
  chownSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Postgres 16's binaries when installed (as before), else the newest other
 * version under /usr/lib/postgresql (Batch 66: ubuntu-latest moved to Ubuntu
 * 26 without 16, so CI pins ubuntu-24.04, which ships it; a machine with only
 * another version still runs these tests).
 */
function findPgBin(): string {
  const root = "/usr/lib/postgresql";
  const has = (bin: string) => existsSync(`${bin}/initdb`) && existsSync(`${bin}/pg_ctl`);
  if (has(`${root}/16/bin`)) return `${root}/16/bin`;
  let versions: string[] = [];
  try {
    versions = readdirSync(root).filter((v) => /^\d+$/.test(v));
  } catch {
    // no Postgres at all
  }
  const found = versions
    .sort((a, b) => Number(b) - Number(a))
    .map((v) => `${root}/${v}/bin`)
    .find(has);
  return found ?? `${root}/16/bin`;
}

const PG_BIN = findPgBin();

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

/**
 * initdb + start on a random port. Several SQL test files start their own
 * server at once (eight since Batch 35, eighteen by Batch 76), so two can pick
 * the same port; a start that fails is retried on a new port (five tries),
 * and the last failure carries the server log. The port is picked below
 * Linux's ephemeral range (32768–60999): every psql call opens a client
 * connection whose local port comes from that range, so a port picked inside
 * it can already be held by another test's connection ("Address already in
 * use", seen on CI 12 Nov).
 */
function initAndStart(): { port: number; data: string } {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = 20_000 + Math.floor(Math.random() * 12_000);
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
    try {
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
      return { port, data };
    } catch (error) {
      let log = "";
      try {
        log = readFileSync(join(data, "server.log"), "utf8").slice(-2000);
      } catch {
        // no log yet
      }
      lastError = new Error(`${error instanceof Error ? error.message : String(error)}\n${log}`);
      try {
        asPostgres(`${PG_BIN}/pg_ctl`, ["-D", data, "-m", "immediate", "stop"]);
      } catch {
        // never started
      }
      rmSync(data, { recursive: true, force: true });
    }
  }
  throw lastError;
}

export function startScratchPg(opts: { schemaFile: string; migrations: string[] }): ScratchPg {
  const { port, data } = initAndStart();

  const base = [
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-U",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-q",
    "-At",
  ];
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
