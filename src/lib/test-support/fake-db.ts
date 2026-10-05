import type { SupabaseClient } from "@supabase/supabase-js";

/** Test-only stand-in for the Supabase query builder. Never used by the app. */
export type FakeOp = {
  table: string;
  kind: "select" | "update" | "insert" | "delete" | "upsert";
  filters: Array<[string, unknown[]]>;
  payload?: unknown;
  /** Arguments given to .select(columns, options). */
  select?: unknown[];
};
export type FakeRpc = { name: string; args: Record<string, unknown> };
type Reply = { data: unknown; error: { code?: string; message: string } | null; count?: number | null };

export function fakeDb(
  onQuery: (op: FakeOp) => Reply | undefined,
  onRpc: (call: FakeRpc) => Reply | undefined = () => undefined,
) {
  const ops: FakeOp[] = [];
  const rpcs: FakeRpc[] = [];
  const client = {
    from(table: string) {
      const op: FakeOp = { table, kind: "select", filters: [] };
      const b: Record<string, unknown> = {};
      for (const m of ["eq", "neq", "in", "or", "not", "lt", "lte", "gt", "gte", "is", "ilike", "order", "limit", "range", "maybeSingle", "single"])
        b[m] = (...a: unknown[]) => {
          op.filters.push([m, a]);
          return b;
        };
      b["select"] = (...a: unknown[]) => {
        op.select = a;
        return b;
      };
      for (const k of ["update", "insert", "upsert"] as const)
        b[k] = (p: unknown) => {
          op.kind = k;
          op.payload = p;
          return b;
        };
      b["delete"] = () => {
        op.kind = "delete";
        return b;
      };
      b["then"] = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
        ops.push(op);
        return Promise.resolve(onQuery(op) ?? { data: null, error: null }).then(res, rej);
      };
      return b;
    },
    rpc(name: string, args: Record<string, unknown>) {
      const call = { name, args };
      rpcs.push(call);
      return Promise.resolve(onRpc(call) ?? { data: null, error: null });
    },
  };
  const has = (op: FakeOp, f: string, ...a: unknown[]) =>
    op.filters.some(([n, args]) => n === f && a.every((x, i) => JSON.stringify(args[i]) === JSON.stringify(x)));
  return { supabase: client as unknown as SupabaseClient, ops, rpcs, has };
}
