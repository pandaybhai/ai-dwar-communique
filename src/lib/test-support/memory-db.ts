import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Test-only: a small in-memory stand-in for PostgREST with state, so the
 * campaign worker and the status webhook can be run end to end in unit
 * tests (claims, conditional updates, counters, races). Supports the
 * filters, embeds, upserts and RPCs those paths use; RPCs are plain
 * functions over the same tables. Never used by the app.
 */

type Row = Record<string, unknown>;
type Filter = (row: Row, db: MemoryDb) => boolean;
type Reply = {
  data: unknown;
  error: { code?: string; message: string } | null;
  count?: number | null;
};

export type Embed = { table: string; local: string; remote: string };

export class MemoryDb {
  readonly tables = new Map<string, Row[]>();
  readonly rpcs = new Map<string, (args: Record<string, unknown>, db: MemoryDb) => unknown>();
  readonly calls: Array<{ table?: string; rpc?: string; kind: string }> = [];
  /** Embeds by "<table>.<name>": how a row of <table> finds its <name>. */
  readonly embeds = new Map<string, Embed>();
  /** Optional hook to fail or delay a call. */
  hook:
    | ((call: {
        table?: string;
        rpc?: string;
        kind: string;
      }) => Promise<Reply | undefined> | Reply | undefined)
    | null = null;

  rows(table: string): Row[] {
    let t = this.tables.get(table);
    if (!t) this.tables.set(table, (t = []));
    return t;
  }

  insert(table: string, row: Row): Row {
    const full = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...row };
    this.rows(table).push(full);
    return full;
  }

  get client(): SupabaseClient {
    return {
      from: (table: string) => new Query(this, table),
      rpc: async (name: string, args: Record<string, unknown> = {}) => {
        const call = { rpc: name, kind: "rpc" };
        this.calls.push(call);
        const hooked = await this.hook?.(call);
        if (hooked) return hooked;
        const fn = this.rpcs.get(name);
        if (!fn)
          return {
            data: null,
            error: { code: "PGRST202", message: `Could not find the function public.${name}` },
          };
        try {
          return { data: fn(args, this) ?? null, error: null };
        } catch (e) {
          return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
        }
      },
    } as unknown as SupabaseClient;
  }
}

function value(row: Row, column: string): unknown {
  const json = /^([a-z_]+)->>([a-z_]+)$/.exec(column);
  if (json) {
    const obj = row[json[1]!] as Row | null | undefined;
    const v = obj?.[json[2]!];
    return v === undefined || v === null ? null : String(v);
  }
  return row[column];
}

function parseList(raw: string): string[] {
  return raw
    .replace(/^\(/, "")
    .replace(/\)$/, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

class Query {
  private kind: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private filters: Filter[] = [];
  private embedFilters: Array<{ embed: string; column: string; test: (v: unknown) => boolean }> =
    [];
  private payload: unknown;
  private columns: string | null = null;
  private returning = false;
  private countMode = false;
  private head = false;
  private single: "single" | "maybe" | null = null;
  private orderBy: Array<{ column: string; asc: boolean }> = [];
  private limitN: number | null = null;
  private rangeFrom = 0;
  private onConflict = "id";
  private orUsed = false;

  constructor(
    private readonly db: MemoryDb,
    private readonly table: string,
  ) {}

  select(columns = "*", opts: { count?: string; head?: boolean } = {}) {
    this.columns = columns;
    if (this.kind !== "select") this.returning = true;
    if (opts.count) this.countMode = true;
    if (opts.head) this.head = true;
    return this;
  }
  insert(payload: unknown) {
    this.kind = "insert";
    this.payload = payload;
    return this;
  }
  update(payload: unknown) {
    this.kind = "update";
    this.payload = payload;
    return this;
  }
  upsert(payload: unknown, opts: { onConflict?: string } = {}) {
    this.kind = "upsert";
    this.payload = payload;
    this.onConflict = opts.onConflict ?? "id";
    return this;
  }
  delete() {
    this.kind = "delete";
    return this;
  }

  private where(column: string, test: (v: unknown) => boolean) {
    const embed = /^([a-z_]+)\.([a-z_]+)$/.exec(column);
    if (embed) this.embedFilters.push({ embed: embed[1]!, column: embed[2]!, test });
    else this.filters.push((row) => test(value(row, column)));
    return this;
  }
  eq(c: string, v: unknown) {
    return this.where(
      c,
      (x) => x === v || (x !== null && x !== undefined && String(x) === String(v)),
    );
  }
  neq(c: string, v: unknown) {
    return this.where(c, (x) => x !== null && x !== undefined && String(x) !== String(v));
  }
  in(c: string, vs: unknown[]) {
    const set = new Set(vs.map(String));
    return this.where(c, (x) => x !== null && x !== undefined && set.has(String(x)));
  }
  is(c: string, v: null) {
    return this.where(c, (x) => (v === null ? x === null || x === undefined : x === v));
  }
  not(c: string, op: string, v: unknown) {
    if (op === "is" && v === null) return this.where(c, (x) => x !== null && x !== undefined);
    if (op === "in") {
      const set = new Set(parseList(String(v)));
      return this.where(c, (x) => x !== null && x !== undefined && !set.has(String(x)));
    }
    throw new Error(`memory-db: not.${op} unsupported`);
  }
  lt(c: string, v: unknown) {
    return this.where(c, (x) => x !== null && x !== undefined && String(x) < String(v));
  }
  lte(c: string, v: unknown) {
    return this.where(c, (x) => x !== null && x !== undefined && String(x) <= String(v));
  }
  gt(c: string, v: unknown) {
    return this.where(c, (x) => x !== null && x !== undefined && String(x) > String(v));
  }
  gte(c: string, v: unknown) {
    return this.where(c, (x) => x !== null && x !== undefined && String(x) >= String(v));
  }
  or(expr: string) {
    // Supports the shapes used here: a,b where each is col.op.value or and(...).
    const parts = splitTop(expr);
    const tests = parts.map((p) => parseCondition(p));
    this.filters.push((row) => tests.some((t) => t(row)));
    this.orUsed = true;
    return this;
  }
  order(column: string, opts: { ascending?: boolean } = {}) {
    this.orderBy.push({ column, asc: opts.ascending !== false });
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  range(from: number, to: number) {
    this.rangeFrom = from;
    this.limitN = to - from + 1;
    return this;
  }
  maybeSingle() {
    this.single = "maybe";
    return this;
  }
  singleRow() {
    this.single = "single";
    return this;
  }

  then<T>(resolve: (v: Reply) => T, reject?: (e: unknown) => T) {
    return this.run().then(resolve, reject);
  }

  private matches(row: Row): boolean {
    if (!this.filters.every((f) => f(row, this.db))) return false;
    for (const ef of this.embedFilters) {
      const target = this.resolveEmbed(row, ef.embed);
      if (!target || !ef.test(target[ef.column])) return false;
    }
    return true;
  }

  private resolveEmbed(row: Row, name: string): Row | null {
    const e = this.db.embeds.get(`${this.table}.${name}`);
    if (!e) throw new Error(`memory-db: no embed ${this.table}.${name}`);
    const key = row[e.local];
    if (key === null || key === undefined) return null;
    return this.db.rows(e.table).find((r) => r[e.remote] === key) ?? null;
  }

  private project(row: Row): Row {
    if (!this.columns || this.columns === "*") return { ...row };
    const out: Row = {};
    for (const part of splitTop(this.columns)) {
      const embed = /^([a-z_]+)(!inner)?\((.*)\)$/.exec(part);
      if (embed) {
        const target = this.resolveEmbed(row, embed[1]!);
        if (!target) {
          out[embed[1]!] = null;
          continue;
        }
        const cols = splitTop(embed[3]!);
        out[embed[1]!] = Object.fromEntries(cols.map((c) => [c, target[c] ?? null]));
        continue;
      }
      out[part] = row[part] ?? null;
    }
    return out;
  }

  private async run(): Promise<Reply> {
    const call = { table: this.table, kind: this.kind };
    this.db.calls.push(call);
    const hooked = await this.db.hook?.(call);
    if (hooked) return hooked;
    const rows = this.db.rows(this.table);
    // Inner embeds drop rows without a match.
    const inner = this.columns
      ? [...this.columns.matchAll(/([a-z_]+)!inner\(/g)].map((m) => m[1]!)
      : [];
    const visible = (r: Row) => this.matches(r) && inner.every((n) => this.resolveEmbed(r, n));

    if (this.kind === "insert" || this.kind === "upsert") {
      const list = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
      const keys = this.onConflict.split(",");
      const written: Row[] = [];
      for (const item of list) {
        const existing =
          this.kind === "upsert"
            ? rows.find((r) => keys.every((k) => item[k] !== undefined && r[k] === item[k]))
            : undefined;
        if (existing) {
          Object.assign(existing, item, { updated_at: new Date().toISOString() });
          written.push(existing);
        } else {
          const unique = UNIQUE[this.table] ?? [];
          for (const cols of unique) {
            if (
              rows.some((r) =>
                cols.every((c) => item[c] !== undefined && item[c] !== null && r[c] === item[c]),
              )
            ) {
              return {
                data: null,
                error: {
                  code: "23505",
                  message: `duplicate key value violates unique constraint on ${this.table}(${cols})`,
                },
              };
            }
          }
          written.push(this.db.insert(this.table, { ...DEFAULTS[this.table], ...item }));
        }
      }
      const data = this.returning ? written.map((r) => this.project(r)) : null;
      return { data: this.single ? (data?.[0] ?? null) : data, error: null };
    }

    if (this.kind === "update") {
      const hit = rows.filter((r) => visible(r));
      for (const r of hit)
        Object.assign(
          r,
          this.payload as Row,
          "updated_at" in r ? { updated_at: new Date().toISOString() } : {},
        );
      // Like PostgREST: an or=() filter is applied again to the rows returned.
      const returned = this.orUsed ? hit.filter((r) => this.matches(r)) : hit;
      const data = this.returning ? returned.map((r) => this.project(r)) : null;
      return { data: this.single ? (data?.[0] ?? null) : data, error: null, count: hit.length };
    }

    if (this.kind === "delete") {
      const keep = rows.filter((r) => !visible(r));
      this.db.tables.set(this.table, keep);
      return { data: null, error: null };
    }

    let hit = rows.filter((r) => visible(r));
    for (const o of [...this.orderBy].reverse()) {
      hit = [...hit].sort((a, b) => {
        const x = String(a[o.column] ?? "");
        const y = String(b[o.column] ?? "");
        return (x < y ? -1 : x > y ? 1 : 0) * (o.asc ? 1 : -1);
      });
    }
    const count = hit.length;
    if (this.limitN !== null || this.rangeFrom)
      hit = hit.slice(this.rangeFrom, this.rangeFrom + (this.limitN ?? hit.length));
    if (this.head) return { data: null, error: null, count };
    const data = hit.map((r) => this.project(r));
    if (this.single) {
      if (data.length > 1 && this.single === "single")
        return { data: null, error: { message: "multiple rows" } };
      return { data: data[0] ?? null, error: null, ...(this.countMode ? { count } : {}) };
    }
    return { data, error: null, ...(this.countMode ? { count } : {}) };
  }
}
// supabase-js calls it .single(); the class can't use that name for the field.
(Query.prototype as unknown as Record<string, unknown>)["single"] = Query.prototype.singleRow;

const UNIQUE: Record<string, string[][]> = {
  messages: [["meta_message_id"]],
  campaign_recipients: [["campaign_id", "contact_id"]],
};
const DEFAULTS: Record<string, Row> = {
  campaign_recipients: {
    status: "queued",
    error: null,
    message_id: null,
    updated_at: new Date(0).toISOString(),
  },
};

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseCondition(p: string): (row: Row) => boolean {
  const and = /^and\((.*)\)$/.exec(p);
  if (and) {
    const tests = splitTop(and[1]!).map(parseCondition);
    return (row) => tests.every((t) => t(row));
  }
  const m = /^([a-z_]+)\.(eq|neq|lte|gte|lt|gt|is|in)\.(.*)$/.exec(p);
  if (!m) throw new Error(`memory-db: or(${p}) unsupported`);
  const [, col, op, raw] = m as unknown as [string, string, string, string];
  return (row) => {
    const v = row[col];
    switch (op) {
      case "eq":
        return String(v) === raw;
      case "neq":
        return String(v) !== raw;
      case "lte":
        return v !== null && v !== undefined && String(v) <= raw;
      case "gte":
        return v !== null && v !== undefined && String(v) >= raw;
      case "lt":
        return v !== null && v !== undefined && String(v) < raw;
      case "gt":
        return v !== null && v !== undefined && String(v) > raw;
      case "is":
        return raw === "null" ? v === null || v === undefined : String(v) === raw;
      case "in":
        return parseList(raw).includes(String(v));
      default:
        return false;
    }
  };
}
