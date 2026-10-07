import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Test-only, in-memory stand-in for the Supabase client: enough of the query
 * builder (select / insert / update / upsert / delete, the usual filters,
 * counts, maybeSingle) for a whole website read to run against real rows.
 * Never used by the app.
 */
export type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;
type RpcHandler = (args: Record<string, unknown>, db: MemoryDb) => { data: unknown; error: { code?: string; message: string } | null };

function field(row: Row, column: string): unknown {
  const json = column.match(/^(\w+)->>(\w+)$/);
  if (json) {
    const value = (row[json[1]!] as Record<string, unknown> | null | undefined)?.[json[2]!];
    return value == null ? null : typeof value === "string" ? value : JSON.stringify(value);
  }
  return row[column];
}

function likeToRe(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${escaped}$`, "s");
}

function cmp(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/** "a.is.null,b.eq.x" — the PostgREST or() forms the app uses. */
function orFilter(expr: string): Filter {
  const parts = expr.split(/,(?![^(]*\))/);
  const tests = parts.map((part): Filter => {
    const and = part.match(/^and\((.*)\)$/);
    if (and) {
      const inner = and[1]!.split(",").map((p) => orFilter(p));
      return (row) => inner.every((t) => t(row));
    }
    const [col, op, ...rest] = part.split(".");
    const value = rest.join(".");
    return (row) => {
      const v = field(row, col!);
      if (op === "is") return value === "null" ? v == null : String(v) === value;
      if (op === "eq") return String(v) === value;
      if (op === "gt") return Number(v) > Number(value);
      if (op === "lte") return v != null && cmp(v, value) <= 0;
      if (op === "ilike") return v != null && likeToRe(value.toLowerCase()).test(String(v).toLowerCase());
      return false;
    };
  });
  return (row) => tests.some((t) => t(row));
}

export type MemoryDb = ReturnType<typeof memoryDb>;

export function memoryDb(seed: Record<string, Row[]> = {}, rpcs: Record<string, RpcHandler> = {}) {
  const tables = new Map<string, Row[]>();
  for (const [name, rows] of Object.entries(seed)) tables.set(name, rows.map((r) => ({ ...r })));
  let nextId = 1;
  const table = (name: string) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };
  const log: Array<{ table: string; kind: string; payload?: unknown }> = [];

  const client = {
    from(name: string) {
      const filters: Filter[] = [];
      let kind: "select" | "insert" | "update" | "upsert" | "delete" = "select";
      let payload: unknown = null;
      let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
      let countMode = false;
      let head = false;
      let single = false;
      let returning = false;
      let limit = Infinity;
      let order: { col: string; asc: boolean } | null = null;
      const b: Record<string, unknown> = {};
      const add = (f: Filter) => {
        filters.push(f);
        return b;
      };
      b["eq"] = (c: string, v: unknown) => add((r) => String(field(r, c)) === String(v) && field(r, c) != null);
      b["neq"] = (c: string, v: unknown) => add((r) => String(field(r, c)) !== String(v));
      b["in"] = (c: string, vs: unknown[]) => add((r) => vs.map(String).includes(String(field(r, c))));
      b["like"] = (c: string, p: string) => add((r) => field(r, c) != null && likeToRe(p).test(String(field(r, c))));
      b["ilike"] = (c: string, p: string) => add((r) => field(r, c) != null && likeToRe(p.toLowerCase()).test(String(field(r, c)).toLowerCase()));
      b["is"] = (c: string, v: unknown) => add((r) => (v === null ? field(r, c) == null : field(r, c) === v));
      b["lt"] = (c: string, v: unknown) => add((r) => field(r, c) != null && cmp(field(r, c), v) < 0);
      b["lte"] = (c: string, v: unknown) => add((r) => field(r, c) != null && cmp(field(r, c), v) <= 0);
      b["gt"] = (c: string, v: unknown) => add((r) => field(r, c) != null && cmp(field(r, c), v) > 0);
      b["gte"] = (c: string, v: unknown) => add((r) => field(r, c) != null && cmp(field(r, c), v) >= 0);
      b["not"] = (c: string, op: string, v: unknown) =>
        add((r) => {
          if (op === "is") return v === null ? field(r, c) != null : field(r, c) !== v;
          if (op === "ilike") return field(r, c) != null && !likeToRe(String(v).toLowerCase()).test(String(field(r, c)).toLowerCase());
          if (op === "in") {
            const list = String(v).replace(/^\(|\)$/g, "").split(",");
            return !list.includes(String(field(r, c)));
          }
          return true;
        });
      b["or"] = (expr: string) => add(orFilter(expr));
      // "gilded:* & chevron:*" — every term starts a word of the row's text;
      // "(ruby:*) | (pearl:*)" — any one of the choices does.
      b["textSearch"] = (_col: string, query: string) => {
        const choices = query
          .split("|")
          .map((c) => c.replace(/[()]/g, "").split("&").map((t) => t.replace(/:\*|\s/g, "").toLowerCase()).filter(Boolean))
          .filter((c) => c.length > 0);
        return add((r) => {
          const words = ["title", "sku", "description", "category", "brand"]
            .map((c) => String(r[c] ?? ""))
            .join(" ")
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean);
          return choices.some((terms) => terms.every((t) => words.some((w) => w.startsWith(t))));
        });
      };
      b["order"] = (col: string, opts?: { ascending?: boolean }) => {
        order = { col, asc: opts?.ascending !== false };
        return b;
      };
      b["limit"] = (n: number) => {
        limit = n;
        return b;
      };
      b["range"] = (from: number, to: number) => {
        limit = to - from + 1;
        return b;
      };
      b["maybeSingle"] = () => {
        single = true;
        return b;
      };
      b["single"] = b["maybeSingle"];
      b["select"] = (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (kind !== "select") returning = true;
        if (opts?.count) countMode = true;
        if (opts?.head) head = true;
        return b;
      };
      for (const k of ["insert", "update", "upsert"] as const)
        b[k] = (p: unknown, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
          kind = k;
          payload = p;
          upsertOpts = opts ?? {};
          return b;
        };
      b["delete"] = () => {
        kind = "delete";
        return b;
      };
      const run = () => {
        const rows = table(name);
        const match = (r: Row) => filters.every((f) => f(r));
        log.push({ table: name, kind, payload });
        if (kind === "select") {
          let out = rows.filter(match);
          if (order) {
            const { col, asc } = order;
            out = [...out].sort((x, y) => (asc ? 1 : -1) * cmp(field(x, col), field(y, col)));
          }
          const count = out.length;
          out = out.slice(0, limit);
          if (head) return { data: null, error: null, count };
          if (single) return { data: out[0] ? { ...out[0] } : null, error: null, count };
          return { data: out.map((r) => ({ ...r })), error: null, count: countMode ? count : null };
        }
        if (kind === "insert" || kind === "upsert") {
          const list = (Array.isArray(payload) ? payload : [payload]) as Row[];
          const keys = (upsertOpts.onConflict ?? "").split(",").filter(Boolean);
          const saved: Row[] = [];
          for (const item of list) {
            const existing =
              kind === "upsert" && keys.length ? rows.find((r) => keys.every((k) => String(r[k]) === String(item[k]))) : undefined;
            if (existing) {
              if (!upsertOpts.ignoreDuplicates) Object.assign(existing, item, { updated_at: new Date().toISOString() });
              saved.push(existing);
              continue;
            }
            const row: Row = { id: `id-${nextId++}`, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...item };
            rows.push(row);
            saved.push(row);
          }
          if (single) return { data: saved[0] ? { ...saved[0] } : null, error: null };
          return { data: returning ? saved.map((r) => ({ ...r })) : null, error: null };
        }
        if (kind === "update") {
          const hit = rows.filter(match);
          for (const r of hit) Object.assign(r, payload as Row, { updated_at: new Date().toISOString() });
          if (single) return { data: hit[0] ? { ...hit[0] } : null, error: null };
          return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null, count: hit.length };
        }
        // delete
        const keep = rows.filter((r) => !match(r));
        const removed = rows.length - keep.length;
        tables.set(name, keep);
        return { data: null, error: null, count: removed };
      };
      b["then"] = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(run).then(res, rej);
      return b;
    },
    rpc(name: string, args: Record<string, unknown>) {
      const handler = rpcs[name];
      return Promise.resolve(handler ? handler(args, api) : { data: null, error: { code: "PGRST202", message: "not found" } });
    },
  };
  const api = {
    supabase: client as unknown as SupabaseClient,
    rows: (name: string) => table(name),
    log,
  };
  return api;
}
