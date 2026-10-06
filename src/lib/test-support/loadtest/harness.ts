/**
 * Load-test harness (Batch 12). Test-only; never imported by the app.
 *
 *  - A throwaway local Postgres 16 with the production tables, indexes,
 *    triggers and functions the sender and the webhook touch (schema.sql),
 *    plus the Batch 12 migration.
 *  - A real PostgREST in front of it, so supabase-js, the filters and the
 *    RPCs behave exactly as against Supabase.
 *  - A fetch shim: every outgoing request runs inside an "invocation" with
 *    Cloudflare's limit of 6 requests waiting at once, plus a modelled
 *    network round trip (database and Graph separately).
 *  - A fake Meta Graph API: 80 msg/s per number (130429 above that), some
 *    131049 / transient errors, and sent → delivered → read status webhooks
 *    for every accepted message, posted back through the real webhook code.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, rmSync, chownSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- infra

export type Infra = {
  dbUrl: string;
  pgrstUrl: string;
  serviceKey: string;
  psql: (sql: string) => string;
  stop: () => void;
};

const PG_BIN = "/usr/lib/postgresql/16/bin";
const POSTGREST_VERSION = "v12.2.3";

function asPostgres(cmd: string, args: string[], opts: { cwd?: string } = {}): string {
  const root = typeof process.getuid === "function" && process.getuid() === 0;
  const [bin, argv] = root ? ["runuser", ["-u", "postgres", "--", cmd, ...args]] : [cmd, args];
  return execFileSync(bin, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

function signJwt(payload: Record<string, unknown>, secret: string): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${head}.${createHmac("sha256", secret).update(head).digest("base64url")}`;
}

function ensurePostgrest(dir: string): string {
  const bin = join(dir, "postgrest");
  if (existsSync(bin)) return bin;
  const tar = join(dir, "postgrest.tar.xz");
  const url = `https://github.com/PostgREST/postgrest/releases/download/${POSTGREST_VERSION}/postgrest-${POSTGREST_VERSION}-linux-static-x64.tar.xz`;
  execFileSync("curl", ["-sSfL", "-o", tar, url], { stdio: "inherit" });
  execFileSync("tar", ["-xJf", tar, "-C", dir]);
  return bin;
}

export async function startInfra(opts: {
  pgPort: number;
  pgrstPort: number;
  pool: number;
  migrations: string[];
  schemaFile: string;
}): Promise<Infra> {
  const base = process.env["LOADTEST_DIR"] ?? join(tmpdir(), "aidwar-loadtest");
  mkdirSync(base, { recursive: true });
  const pgrstBin = ensurePostgrest(base);
  const data = join(base, `pg-${opts.pgPort}`);
  rmSync(data, { recursive: true, force: true });
  mkdirSync(data, { recursive: true });
  try {
    chownSync(
      data,
      Number(execFileSync("id", ["-u", "postgres"], { encoding: "utf8" }).trim()),
      Number(execFileSync("id", ["-g", "postgres"], { encoding: "utf8" }).trim()),
    );
  } catch {
    // not root: the data dir is already ours
  }
  asPostgres(`${PG_BIN}/initdb`, ["-D", data, "-A", "trust", "-U", "postgres", "--no-sync"]);
  const conf = [
    `port = ${opts.pgPort}`,
    `listen_addresses = '127.0.0.1'`,
    `unix_socket_directories = '${data}'`,
    "max_connections = 400",
    // Close to Supabase's small computes, so DB time is not flattered.
    "shared_buffers = 256MB",
    "work_mem = 4MB",
    "shared_preload_libraries = 'pg_stat_statements'",
    "pg_stat_statements.track = all",
    "pg_stat_statements.max = 10000",
    "deadlock_timeout = 200ms",
    "log_lock_waits = on",
    "log_min_messages = warning",
  ].join("\n");
  writeFileSync(join(data, "postgresql.auto.conf"), conf + "\n");
  asPostgres(`${PG_BIN}/pg_ctl`, ["-D", data, "-l", join(data, "server.log"), "-w", "start"]);

  const psqlArgs = [
    "-h",
    "127.0.0.1",
    "-p",
    String(opts.pgPort),
    "-U",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-q",
    "-At",
  ];
  execFileSync("psql", [...psqlArgs, "-d", "postgres", "-c", "create database loadtest"]);
  const psql = (sql: string) =>
    execFileSync("psql", [...psqlArgs, "-d", "loadtest", "-c", sql], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  execFileSync("psql", [...psqlArgs, "-d", "loadtest", "-f", opts.schemaFile], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (const m of opts.migrations) {
    execFileSync("psql", [...psqlArgs, "-d", "loadtest", "-f", m], {
      stdio: ["ignore", "ignore", "inherit"],
    });
  }

  const secret = "loadtest-jwt-secret-loadtest-jwt-secret-0123456789";
  const pgrst: ChildProcess = spawn(pgrstBin, [], {
    env: {
      ...process.env,
      PGRST_DB_URI: `postgres://authenticator:loadtest@127.0.0.1:${opts.pgPort}/loadtest`,
      PGRST_DB_SCHEMAS: "public",
      PGRST_DB_ANON_ROLE: "anon",
      PGRST_JWT_SECRET: secret,
      PGRST_SERVER_PORT: String(opts.pgrstPort),
      PGRST_SERVER_HOST: "127.0.0.1",
      PGRST_DB_POOL: String(opts.pool),
      PGRST_DB_POOL_ACQUISITION_TIMEOUT: "30",
      PGRST_LOG_LEVEL: "error",
      PGRST_DB_CHANNEL_ENABLED: "false",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const pgrstUrl = `http://127.0.0.1:${opts.pgrstPort}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await realFetch(`${pgrstUrl}/`);
      if (r.status < 500) break;
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  return {
    dbUrl: `postgres://postgres@127.0.0.1:${opts.pgPort}/loadtest`,
    pgrstUrl,
    serviceKey: signJwt({ role: "service_role", iss: "loadtest" }, secret),
    psql,
    stop: () => {
      pgrst.kill("SIGTERM");
      try {
        asPostgres(`${PG_BIN}/pg_ctl`, ["-D", data, "-m", "fast", "-w", "stop"]);
      } catch {
        // already down
      }
      if (!process.env["LOADTEST_KEEP"]) rmSync(data, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------- invocations & fetch

/** FIFO counting semaphore. */
export class Semaphore {
  private queue: Array<() => void> = [];
  constructor(private free: number) {}
  async acquire(): Promise<void> {
    if (this.free > 0) {
      this.free -= 1;
      return;
    }
    await new Promise<void>((r) => this.queue.push(r));
  }
  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.free += 1;
  }
}

export type Invocation = { kind: "worker" | "webhook"; sem: Semaphore; db: number };
export const invocation = new AsyncLocalStorage<Invocation>();
export const realFetch: typeof fetch = globalThis.fetch.bind(globalThis);

/** Reservoir of latency samples (ms). */
export class Samples {
  private values: number[] = [];
  private seen = 0;
  constructor(private readonly cap = 200_000) {}
  add(v: number) {
    this.seen += 1;
    if (this.values.length < this.cap) this.values.push(v);
    else {
      const i = Math.floor(Math.random() * this.seen);
      if (i < this.cap) this.values[i] = v;
    }
  }
  pct(p: number): number {
    if (!this.values.length) return NaN;
    const sorted = [...this.values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
  }
  get count() {
    return this.seen;
  }
}

export type FetchStats = {
  dbRequests: { worker: number; webhook: number; other: number };
  dbErrors: number;
  dbErrorSamples: string[];
  dbLatency: Samples;
  graphLatency: Samples;
  byPath: Map<string, number>;
};

export function installFetch(opts: {
  supabaseOrigin: string;
  pgrstUrl: string;
  dbRttMs: number;
  graphMs: number;
  meta: FakeMeta;
}): FetchStats {
  const stats: FetchStats = {
    dbRequests: { worker: 0, webhook: 0, other: 0 },
    dbErrors: 0,
    dbErrorSamples: [],
    dbLatency: new Samples(),
    graphLatency: new Samples(),
    byPath: new Map(),
  };
  const jitter = (ms: number) => ms * (0.75 + Math.random() * 0.5);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const ctx = invocation.getStore();
    const started = performance.now();
    if (url.startsWith("https://graph.facebook.com/")) {
      await ctx?.sem.acquire();
      try {
        const m = /\/v[\d.]+\/([^/]+)\/messages$/.exec(new URL(url).pathname);
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        await sleep(jitter(opts.graphMs));
        const answer = opts.meta.send(m?.[1] ?? "", body);
        return new Response(JSON.stringify(answer.body), {
          status: answer.status,
          headers: { "content-type": "application/json" },
        });
      } finally {
        ctx?.sem.release();
        stats.graphLatency.add(performance.now() - started);
      }
    }
    if (url.startsWith(opts.supabaseOrigin)) {
      const target =
        opts.pgrstUrl + url.slice(opts.supabaseOrigin.length).replace(/^\/rest\/v1/, "");
      const path = new URL(target).pathname;
      stats.byPath.set(
        `${init?.method ?? "GET"} ${path}`,
        (stats.byPath.get(`${init?.method ?? "GET"} ${path}`) ?? 0) + 1,
      );
      if (ctx) {
        stats.dbRequests[ctx.kind] += 1;
        ctx.db += 1;
      } else stats.dbRequests.other += 1;
      await ctx?.sem.acquire();
      try {
        // Half the round trip there, half back; the slot is held throughout.
        await sleep(jitter(opts.dbRttMs) / 2);
        const res = await realFetch(target, init);
        const text = await res.text();
        await sleep(jitter(opts.dbRttMs) / 2);
        if (res.status >= 400) {
          stats.dbErrors += 1;
          if (stats.dbErrorSamples.length < 20)
            stats.dbErrorSamples.push(`${res.status} ${path} ${text.slice(0, 300)}`);
        }
        return new Response(res.status === 204 || res.status === 205 ? null : text, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
      } finally {
        ctx?.sem.release();
        stats.dbLatency.add(performance.now() - started);
      }
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  return stats;
}

// ------------------------------------------------------------- fake Meta

type Number = { pn: string; waba: string; display: string };

export class FakeMeta {
  private seq = 0;
  readonly accepted = new Map<string, number>(); // biz_opaque → sends accepted
  readonly firstAcceptAt = new Map<string, number>(); // campaign → ms
  readonly lastAcceptAt = new Map<string, number>(); // campaign → ms
  readonly perSecond = new Map<string, Map<number, number>>(); // pn → second → accepted
  readonly attempts = new Map<string, Map<number, number>>(); // pn → second → attempts
  readonly refused = { rate: 0, marketing: 0, transient: 0 };
  duplicates = 0;
  readonly sendTimes: Array<{ at: number; campaign: string; recipient: string }> = [];
  constructor(
    private readonly opts: {
      mps: number;
      marketingCapRate: number;
      transientRate: number;
      failAfterSentRate: number;
      numbers: Map<string, Number>;
      onStatus: (s: StatusEvent) => void;
      statusDelays: { sent: [number, number]; delivered: [number, number]; read: [number, number] };
    },
  ) {}

  send(
    pn: string,
    body: Record<string, unknown>,
  ): { status: number; body: Record<string, unknown> } {
    const now = Date.now();
    const sec = Math.floor(now / 1000);
    const bucket = (map: Map<string, Map<number, number>>) => {
      let m = map.get(pn);
      if (!m) map.set(pn, (m = new Map()));
      m.set(sec, (m.get(sec) ?? 0) + 1);
      return m.get(sec)!;
    };
    bucket(this.attempts);
    const used = this.perSecond.get(pn)?.get(sec) ?? 0;
    if (used >= this.opts.mps) {
      this.refused.rate += 1;
      return {
        status: 400,
        body: {
          error: { code: 130429, message: "(#130429) Rate limit hit", type: "OAuthException" },
        },
      };
    }
    if (Math.random() < this.opts.transientRate) {
      this.refused.transient += 1;
      return { status: 503, body: { error: { code: 131016, message: "Service unavailable" } } };
    }
    if (Math.random() < this.opts.marketingCapRate) {
      this.refused.marketing += 1;
      return {
        status: 400,
        body: {
          error: {
            code: 131049,
            message: "This message was not delivered to maintain healthy ecosystem engagement.",
          },
        },
      };
    }
    bucket(this.perSecond);
    const tag = String(body["biz_opaque_callback_data"] ?? "");
    const prev = this.accepted.get(tag) ?? 0;
    if (prev > 0) this.duplicates += 1;
    this.accepted.set(tag, prev + 1);
    const campaign = /^aidwar:c:([^:]+):r:(.+)$/.exec(tag);
    if (campaign) {
      if (!this.firstAcceptAt.has(campaign[1]!)) this.firstAcceptAt.set(campaign[1]!, now);
      this.lastAcceptAt.set(campaign[1]!, now);
      this.sendTimes.push({ at: now, campaign: campaign[1]!, recipient: campaign[2]! });
    }
    this.seq += 1;
    const wamid = `wamid.LOAD${this.seq.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const number = this.opts.numbers.get(pn)!;
    const to = String(body["to"] ?? "");
    const d = this.opts.statusDelays;
    const rnd = ([a, b]: [number, number]) => a + Math.random() * (b - a);
    const sentAt = rnd(d.sent);
    this.opts.onStatus({ at: now + sentAt, number, wamid, to, tag, status: "sent" });
    if (Math.random() < this.opts.failAfterSentRate) {
      this.opts.onStatus({
        at: now + sentAt + rnd(d.delivered),
        number,
        wamid,
        to,
        tag,
        status: "failed",
      });
    } else {
      this.opts.onStatus({
        at: now + sentAt + rnd(d.delivered),
        number,
        wamid,
        to,
        tag,
        status: "delivered",
      });
      this.opts.onStatus({
        at: now + sentAt + rnd(d.delivered) + rnd(d.read),
        number,
        wamid,
        to,
        tag,
        status: "read",
      });
    }
    return {
      status: 200,
      body: {
        messaging_product: "whatsapp",
        contacts: [{ input: to, wa_id: to }],
        messages: [{ id: wamid }],
      },
    };
  }

  /** Highest accepted per calendar second, per number. */
  maxPerSecond(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [pn, m] of this.perSecond) out.set(pn, Math.max(0, ...m.values()));
    return out;
  }
}

export type StatusEvent = {
  at: number;
  number: Number;
  wamid: string;
  to: string;
  tag: string;
  status: "sent" | "delivered" | "read" | "failed";
};

export function statusPayload(s: StatusEvent): Record<string, unknown> {
  const status: Record<string, unknown> = {
    id: s.wamid,
    status: s.status,
    timestamp: String(Math.floor(s.at / 1000)),
    recipient_id: s.to,
    biz_opaque_callback_data: s.tag,
  };
  if (s.status === "sent" || s.status === "delivered") {
    status["conversation"] = { id: "conv", origin: { type: "marketing" } };
    status["pricing"] = { billable: true, pricing_model: "PMP", category: "marketing" };
  }
  if (s.status === "failed") {
    status["errors"] = [{ code: 131026, title: "Message undeliverable" }];
  }
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: s.number.waba,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: s.number.display, phone_number_id: s.number.pn },
              statuses: [status],
            },
          },
        ],
      },
    ],
  };
}

/** Samples active database connections (client backends doing work) every `everyMs`. */
export function sampleConnections(
  dbUrl: string,
  everyMs: number,
): { stop: () => { max: number; p95: number; avg: number; samples: number } } {
  const values: number[] = [];
  let running = true;
  const sql =
    "select count(*) from pg_stat_activity where datname='loadtest' and backend_type='client backend' and state <> 'idle' and pid <> pg_backend_pid()";
  const tick = () => {
    if (!running) return;
    execFile("psql", [dbUrl, "-At", "-c", sql], { encoding: "utf8" }, (err, out) => {
      if (!err) values.push(Number(String(out).trim()));
      if (running) setTimeout(tick, everyMs);
    });
  };
  setTimeout(tick, everyMs);
  return {
    stop: () => {
      running = false;
      const sorted = [...values].sort((a, b) => a - b);
      return {
        max: sorted.at(-1) ?? 0,
        p95: sorted[Math.floor(0.95 * (sorted.length - 1))] ?? 0,
        avg: values.reduce((s, v) => s + v, 0) / Math.max(1, values.length),
        samples: values.length,
      };
    },
  };
}
