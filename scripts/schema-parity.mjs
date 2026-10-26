#!/usr/bin/env node
/**
 * After-deploy schema check (Batch 28 item 9).
 *
 * Reads every supabase/aidwar-migrations/*.sql file in name order, replays the
 * DDL it can see (functions, tables and their columns, ALTER TABLE ADD/DROP/
 * RENAME COLUMN, views, indexes, triggers and pg_cron jobs, minus anything a
 * later DROP / cron.unschedule removes) and writes scripts/schema-parity.sql:
 * ONE read-only SELECT that lists every expected object missing on the
 * database it runs against.
 *
 *   node scripts/schema-parity.mjs           # regenerate scripts/schema-parity.sql
 *   node scripts/schema-parity.mjs --check   # exit 1 if the committed file is stale
 *   node scripts/schema-parity.mjs --stdout  # print the SQL instead of writing it
 *
 * Plain Node ESM, no dependencies. It never connects to a database.
 * src/lib/batch28-schema-parity.test.ts fails when the committed SQL is stale.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MIGRATIONS_DIR = join(ROOT, "supabase", "aidwar-migrations");
export const OUTPUT_FILE = join(ROOT, "scripts", "schema-parity.sql");

// ---------------------------------------------------------------------------
// Lexing: split SQL into statements, blank out comments, and keep a "masked"
// copy where string / dollar-quoted contents are spaces (same length), so
// keyword searches never match inside a function body or a literal.
// ---------------------------------------------------------------------------

const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/** @returns {{ text: string, masked: string }[]} */
export function splitStatements(sql) {
  const out = [];
  let text = "";
  let masked = "";
  let depth = 0;
  let i = 0;
  const n = sql.length;
  const push = () => {
    if (text.trim()) out.push({ text, masked });
    text = "";
    masked = "";
  };
  const blank = (s) => s.replace(/[^\n]/g, " ");
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      let j = sql.indexOf("\n", i);
      if (j === -1) j = n;
      text += blank(sql.slice(i, j));
      masked += blank(sql.slice(i, j));
      i = j;
    } else if (c === "/" && next === "*") {
      let level = 0;
      let j = i;
      while (j < n) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          level++;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          level--;
          j += 2;
          if (level === 0) break;
        } else j++;
      }
      text += blank(sql.slice(i, j));
      masked += blank(sql.slice(i, j));
      i = j;
    } else if (c === "'") {
      const escapes = /[eE]/.test(sql[i - 1] ?? "") && !/[A-Za-z0-9_]/.test(sql[i - 2] ?? "");
      let j = i + 1;
      while (j < n) {
        if (escapes && sql[j] === "\\") j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      j = Math.min(j + 1, n);
      text += sql.slice(i, j);
      masked += "'" + blank(sql.slice(i + 1, j - 1)) + "'";
      i = j;
    } else if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"' && sql[j + 1] === '"') j += 2;
        else if (sql[j] === '"') break;
        else j++;
      }
      j = Math.min(j + 1, n);
      text += sql.slice(i, j);
      masked += sql.slice(i, j);
      i = j;
    } else if (c === "$" && !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? "") && DOLLAR_TAG.test(sql.slice(i))) {
      const tag = /** @type {RegExpExecArray} */ (DOLLAR_TAG.exec(sql.slice(i)))[0];
      let end = sql.indexOf(tag, i + tag.length);
      end = end === -1 ? n : end + tag.length;
      text += sql.slice(i, end);
      masked += tag + blank(sql.slice(i + tag.length, end - tag.length)) + tag;
      i = end;
    } else {
      if (c === "(") depth++;
      else if (c === ")") depth = Math.max(0, depth - 1);
      if (c === ";" && depth === 0) {
        push();
      } else {
        text += c;
        masked += c;
      }
      i++;
    }
  }
  push();
  return out;
}

/** Split `s` on top-level occurrences of `sep` (outside parens and quotes). */
function splitTopLevel(s, sep = ",") {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === c && s[j + 1] === c) j += 2;
        else if (s[j] === c) break;
        else j++;
      }
      cur += s.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "$" && DOLLAR_TAG.test(s.slice(i)) && !/[A-Za-z0-9_$]/.test(s[i - 1] ?? "")) {
      const tag = /** @type {RegExpExecArray} */ (DOLLAR_TAG.exec(s.slice(i)))[0];
      let end = s.indexOf(tag, i + tag.length);
      end = end === -1 ? s.length : end + tag.length;
      cur += s.slice(i, end);
      i = end - 1;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === sep && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Index of the parenthesis closing the one at `open`. */
function closingParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < s.length && !(s[j] === c && s[j + 1] !== c)) j += s[j] === c ? 2 : 1;
      i = j;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return s.length;
}

// ---------------------------------------------------------------------------
// Names and types.
// ---------------------------------------------------------------------------

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QNAME = String.raw`${IDENT}(?:\s*\.\s*${IDENT})?`;

function unquote(id) {
  return id.startsWith('"') ? id.slice(1, -1).replace(/""/g, '"') : id.toLowerCase();
}

/** "public.foo" / foo / "Foo" -> { schema, name } (schema defaults to public). */
function qualified(raw) {
  const parts = raw.match(new RegExp(IDENT, "g")) ?? [];
  if (parts.length >= 2) return { schema: unquote(parts[0]), name: unquote(parts[1]) };
  return { schema: "public", name: unquote(parts[0] ?? "") };
}

const TYPE_ALIASES = {
  int: "integer",
  int4: "integer",
  int8: "bigint",
  int2: "smallint",
  bool: "boolean",
  float8: "double precision",
  float4: "real",
  float: "double precision",
  decimal: "numeric",
  varchar: "character varying",
  char: "character",
  bpchar: "character",
  timestamptz: "timestamp with time zone",
  timestamp: "timestamp without time zone",
  timetz: "time with time zone",
  time: "time without time zone",
  varbit: "bit varying",
};

/** Canonical spelling of a type name, as format_type / to_regtype would read it. */
export function normalizeType(raw) {
  let t = raw.trim().replace(/\s+/g, " ").toLowerCase();
  let arr = "";
  const arrMatch = /(\s*\[\s*\d*\s*\])+$/.exec(t);
  if (arrMatch) {
    arr = "[]".repeat((arrMatch[0].match(/\[/g) ?? []).length);
    t = t.slice(0, arrMatch.index).trim();
  }
  if (/ array$/.test(t)) {
    arr += "[]";
    t = t.replace(/ array$/, "");
  }
  t = t.replace(/\s*\([^)]*\)/g, "").trim(); // typmods: numeric(12,2), varchar(20)
  t = t.replace(/^(pg_catalog|public)\./, "");
  t = t.replace(/^character varying$/, "character varying");
  t = t.replace(/^timestamp with time zone$/, "timestamp with time zone");
  if (/^timestamp (without time zone)?$/.test(t)) t = "timestamp without time zone";
  if (/^time (without time zone)?$/.test(t)) t = "time without time zone";
  t = TYPE_ALIASES[t] ?? t;
  return t + arr;
}

const MULTIWORD_TYPE =
  /^(double\s+precision|character\s+varying|bit\s+varying|national\s+character|timestamp(\s*\(\d+\))?\s+(with|without)\s+time\s+zone|time(\s*\(\d+\))?\s+(with|without)\s+time\s+zone|interval\s+\w+)\b/i;

/**
 * Input argument types of a function argument list (OUT args left out, as
 * pg_proc.proargtypes does). Each arg: [mode] [name] type [DEFAULT expr].
 */
export function argTypes(argList) {
  const types = [];
  for (let arg of splitTopLevel(argList)) {
    arg = arg.replace(/\s+(default\b|=)[\s\S]*$/i, "").trim();
    let mode = "in";
    const m = /^(in|out|inout|variadic)\s+/i.exec(arg);
    if (m) {
      mode = m[1].toLowerCase();
      arg = arg.slice(m[0].length);
    }
    if (mode === "out") continue;
    let type = arg;
    if (!MULTIWORD_TYPE.test(arg)) {
      const nm = new RegExp(`^(${IDENT})\\s+(.+)$`, "s").exec(arg);
      if (nm) type = nm[2];
    }
    types.push(normalizeType(type));
  }
  return types;
}

// ---------------------------------------------------------------------------
// The replay: an ordered map of expected objects, keyed by identity.
// ---------------------------------------------------------------------------

const KIND_ORDER = ["table", "column", "view", "function", "index", "trigger", "cron_job"];

class Expected {
  constructor() {
    /** @type {Map<string, any>} */
    this.items = new Map();
  }
  add(key, obj, { replace = true } = {}) {
    const prev = this.items.get(key);
    if (prev && !replace) return;
    // An object re-created later keeps the file that first introduced it.
    this.items.set(key, prev ? { ...obj, file: prev.file } : obj);
  }
  remove(pred) {
    for (const [k, v] of this.items) if (pred(v, k)) this.items.delete(k);
  }
  has(key) {
    return this.items.has(key);
  }
}

const relKey = (schema, name) => `${schema}.${name}`;

const DDL_START = new RegExp(
  [
    String.raw`\bcreate\s+(?:or\s+replace\s+)?function\b`,
    String.raw`\bcreate\s+(?:(?:unlogged|global|local)\s+)*table\b`,
    String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\b`,
    String.raw`\bcreate\s+(?:unique\s+)?index\b`,
    String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\b`,
    String.raw`\balter\s+table\b`,
    String.raw`\bdrop\s+(?:function|table|(?:materialized\s+)?view|index|trigger)\b`,
    String.raw`\bcron\s*\.\s*(?:un)?schedule\s*\(`,
  ].join("|"),
  "gi",
);

/**
 * Replays one statement (or one piece of a DO block). `masked` hides literal
 * contents so keywords are found only in real code.
 */
function replay(exp, file, text, masked) {
  if (/^\s*do\b/i.test(masked)) {
    const body = /\$([A-Za-z_][A-Za-z0-9_]*)?\$([\s\S]*?)\$\1\$/.exec(text);
    if (body) for (const s of splitStatements(body[2])) replay(exp, file, s.text, s.masked);
    return;
  }
  DDL_START.lastIndex = 0;
  let m;
  // Normally one DDL per statement; cron calls can repeat in a DO piece.
  while ((m = DDL_START.exec(masked))) {
    const at = m.index;
    handle(exp, file, text.slice(at), masked.slice(at));
    if (!/^cron/i.test(m[0])) break;
  }
}

function handle(exp, file, s, masked) {
  let m;
  const ws = String.raw`\s+`;

  // CREATE [OR REPLACE] FUNCTION name(args)
  if ((m = new RegExp(String.raw`^create\s+(?:or\s+replace\s+)?function\s+(${QNAME})\s*\(`, "i").exec(s))) {
    const { schema, name } = qualified(m[1]);
    const open = m[0].length - 1;
    const args = argTypes(s.slice(open + 1, closingParen(s, open)));
    exp.add(`function:${schema}.${name}(${args.join(",")})`, {
      kind: "function",
      schema,
      name,
      sub: null,
      args,
      detail: `${schema}.${name}(${args.join(", ")})`,
      file,
    });
    return;
  }

  // DROP FUNCTION [IF EXISTS] name[(args)] [, ...] [CASCADE|RESTRICT]
  if ((m = /^drop\s+function\s+(?:if\s+exists\s+)?/i.exec(s))) {
    const list = s.slice(m[0].length).replace(/\s+(cascade|restrict)\s*$/i, "");
    for (const item of splitTopLevel(list)) {
      const nm = new RegExp(`^(${QNAME})\\s*(\\(([\\s\\S]*)\\))?`).exec(item);
      if (!nm) continue;
      const { schema, name } = qualified(nm[1]);
      if (nm[2] === undefined) {
        exp.remove((v) => v.kind === "function" && v.schema === schema && v.name === name);
      } else {
        const key = `function:${schema}.${name}(${argTypes(nm[3] ?? "").join(",")})`;
        exp.remove((_v, k) => k === key);
      }
    }
    return;
  }

  // CREATE TABLE [IF NOT EXISTS] name ( ... )
  if (
    (m = new RegExp(
      String.raw`^create\s+(?:(?:unlogged|global|local)\s+)*table\s+(if\s+not\s+exists\s+)?(${QNAME})\s*\(`,
      "i",
    ).exec(s))
  ) {
    const { schema, name } = qualified(m[2]);
    if (/^create\s+(?:(?:global|local)\s+)?temp/i.test(s)) return;
    const tKey = `table:${relKey(schema, name)}`;
    if (exp.has(tKey)) return; // IF NOT EXISTS on an existing table changes nothing
    exp.add(tKey, { kind: "table", schema, name, sub: null, args: null, detail: null, file });
    const open = m[0].length - 1;
    const body = s.slice(open + 1, closingParen(s, open));
    for (const el of splitTopLevel(body)) {
      if (/^(constraint|primary\s+key|unique|check|foreign\s+key|exclude|like)\b/i.test(el)) continue;
      const cm = new RegExp(`^(${IDENT})\\s+([\\s\\S]*)$`).exec(el);
      if (!cm) continue;
      addColumn(exp, file, schema, name, unquote(cm[1]), cm[2]);
    }
    return;
  }

  // CREATE [OR REPLACE] [MATERIALIZED] VIEW name
  if (
    (m = new RegExp(
      String.raw`^create\s+(?:or\s+replace\s+)?(materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?(${QNAME})`,
      "i",
    ).exec(s))
  ) {
    const { schema, name } = qualified(m[2]);
    exp.add(`view:${relKey(schema, name)}`, {
      kind: "view",
      schema,
      name,
      sub: null,
      args: null,
      detail: m[1] ? "materialized view" : null,
      file,
    });
    return;
  }

  // DROP TABLE / VIEW [IF EXISTS] a, b [CASCADE]
  if ((m = /^drop\s+(table|(?:materialized\s+)?view)\s+(?:if\s+exists\s+)?/i.exec(s))) {
    const list = s.slice(m[0].length).replace(/\s+(cascade|restrict)\s*$/i, "");
    for (const item of splitTopLevel(list)) {
      const { schema, name } = qualified(item);
      dropRelation(exp, schema, name);
    }
    return;
  }

  // CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] name ON [ONLY] table
  if (
    (m = new RegExp(
      String.raw`^create\s+(unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(${IDENT})${ws}on${ws}(?:only${ws})?(${QNAME})`,
      "i",
    ).exec(s))
  ) {
    const table = qualified(m[3]);
    const name = unquote(m[2]);
    exp.add(
      `index:${relKey(table.schema, name)}`,
      {
        kind: "index",
        schema: table.schema,
        name,
        sub: null,
        args: null,
        table: table.name,
        detail: `${m[1] ? "unique " : ""}on ${table.schema}.${table.name}`,
        file,
      },
      { replace: false },
    );
    return;
  }

  // DROP INDEX [CONCURRENTLY] [IF EXISTS] a, b [CASCADE]
  if ((m = /^drop\s+index\s+(?:concurrently\s+)?(?:if\s+exists\s+)?/i.exec(s))) {
    const list = s.slice(m[0].length).replace(/\s+(cascade|restrict)\s*$/i, "");
    for (const item of splitTopLevel(list)) {
      const { schema, name } = qualified(item);
      exp.remove((_v, k) => k === `index:${relKey(schema, name)}`);
    }
    return;
  }

  // CREATE [OR REPLACE] [CONSTRAINT] TRIGGER name ... ON table
  if (
    (m = new RegExp(
      String.raw`^create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+(${IDENT})[\s\S]*?\son\s+(?:only\s+)?(${QNAME})`,
      "i",
    ).exec(masked))
  ) {
    const table = qualified(m[2]);
    const name = unquote(m[1]);
    exp.add(
      `trigger:${relKey(table.schema, table.name)}.${name}`,
      {
        kind: "trigger",
        schema: table.schema,
        name: table.name,
        sub: name,
        args: null,
        detail: `on ${table.schema}.${table.name}`,
        file,
      },
      { replace: false },
    );
    return;
  }

  // DROP TRIGGER [IF EXISTS] name ON table
  if (
    (m = new RegExp(
      String.raw`^drop\s+trigger\s+(?:if\s+exists\s+)?(${IDENT})${ws}on${ws}(${QNAME})`,
      "i",
    ).exec(s))
  ) {
    const table = qualified(m[2]);
    exp.remove((_v, k) => k === `trigger:${relKey(table.schema, table.name)}.${unquote(m[1])}`);
    return;
  }

  // ALTER TABLE [IF EXISTS] [ONLY] name action [, action ...]
  if (
    (m = new RegExp(
      String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${QNAME})\s+`,
      "i",
    ).exec(s))
  ) {
    const { schema, name } = qualified(m[1]);
    const rest = s.slice(m[0].length);
    let r;
    if ((r = new RegExp(`^rename\\s+to\\s+(${IDENT})`, "i").exec(rest))) {
      renameRelation(exp, schema, name, unquote(r[1]));
      return;
    }
    if ((r = new RegExp(`^rename\\s+(?:column\\s+)?(${IDENT})\\s+to\\s+(${IDENT})`, "i").exec(rest))) {
      const from = unquote(r[1]);
      const to = unquote(r[2]);
      const old = exp.items.get(`column:${relKey(schema, name)}.${from}`);
      exp.remove((_v, k) => k === `column:${relKey(schema, name)}.${from}`);
      addColumn(exp, old?.file ?? file, schema, name, to, old?.detail ?? "");
      return;
    }
    for (const action of splitTopLevel(rest)) {
      let a;
      if (
        (a = new RegExp(
          `^add\\s+(?:column\\s+)?(?:if\\s+not\\s+exists\\s+)?(${IDENT})\\s+([\\s\\S]*)$`,
          "i",
        ).exec(action)) &&
        !/^add\s+(constraint|primary\s+key|unique|check|foreign\s+key|exclude)\b/i.test(action)
      ) {
        addColumn(exp, file, schema, name, unquote(a[1]), a[2]);
      } else if (
        (a = new RegExp(`^drop\\s+(?:column\\s+)?(?:if\\s+exists\\s+)?(${IDENT})`, "i").exec(action)) &&
        !/^drop\s+constraint\b/i.test(action)
      ) {
        const col = unquote(a[1]);
        exp.remove((_v, k) => k === `column:${relKey(schema, name)}.${col}`);
      }
    }
    return;
  }

  // [SELECT|PERFORM] cron.schedule('job', 'schedule', cmd) / cron.unschedule('job')
  if ((m = /^cron\s*\.\s*(un)?schedule\s*\(/i.exec(s))) {
    const open = m[0].length - 1;
    const args = splitTopLevel(s.slice(open + 1, closingParen(s, open)));
    const lit = (a) => (a && /^'(?:[^']|'')*'$/.test(a) ? a.slice(1, -1).replace(/''/g, "'") : null);
    if (m[1]) {
      const job = lit(args[0]);
      if (job !== null) exp.remove((_v, k) => k === `cron_job:${job}`);
    } else if (args.length >= 3) {
      const job = lit(args[0]);
      if (job === null) return;
      const schedule = lit(args[1]);
      exp.add(`cron_job:${job}`, {
        kind: "cron_job",
        schema: "cron",
        name: job,
        sub: null,
        args: null,
        detail: schedule === null ? null : `schedule ${schedule}`,
        file,
      });
    }
  }
}

function addColumn(exp, file, schema, table, col, typeAndRest) {
  const type = /^[^\s(]+(?:\s*\([^)]*\))?(?:\s*\[\s*\])*/.exec(typeAndRest.trim());
  const multi = MULTIWORD_TYPE.exec(typeAndRest.trim());
  exp.add(
    `column:${relKey(schema, table)}.${col}`,
    {
      kind: "column",
      schema,
      name: table,
      sub: col,
      args: null,
      detail: multi ? normalizeType(multi[0]) : type ? normalizeType(type[0]) : null,
      file,
    },
    { replace: false },
  );
}

function dropRelation(exp, schema, name) {
  exp.remove(
    (v) =>
      v.schema === schema &&
      (((v.kind === "table" || v.kind === "view") && v.name === name) ||
        ((v.kind === "column" || v.kind === "trigger") && v.name === name) ||
        (v.kind === "index" && (v.name === name || v.table === name))),
  );
}

function renameRelation(exp, schema, from, to) {
  for (const [k, v] of [...exp.items]) {
    if (v.schema !== schema) continue;
    let nv = null;
    if ((v.kind === "table" || v.kind === "column" || v.kind === "trigger") && v.name === from)
      nv = { ...v, name: to };
    else if (v.kind === "index" && v.table === from)
      nv = { ...v, table: to, detail: v.detail.replace(`.${from}`, `.${to}`) };
    if (!nv) continue;
    exp.items.delete(k);
    const nk = nv.kind === "index" ? k : keyOf(nv);
    exp.items.set(nk, nv);
  }
}

function keyOf(v) {
  if (v.kind === "column" || v.kind === "trigger")
    return `${v.kind}:${relKey(v.schema, v.name)}.${v.sub}`;
  return `${v.kind}:${relKey(v.schema, v.name)}`;
}

/**
 * The expected objects after replaying every migration file in name order.
 * @param {{ name: string, sql: string }[]} [files]
 */
export function collectExpected(files = readMigrations()) {
  const exp = new Expected();
  for (const f of files) {
    for (const st of splitStatements(f.sql)) replay(exp, f.name, st.text, st.masked);
  }
  const rank = (k) => KIND_ORDER.indexOf(k);
  return [...exp.items.values()].sort(
    (a, b) =>
      rank(a.kind) - rank(b.kind) ||
      cmp(a.schema, b.schema) ||
      cmp(a.name, b.name) ||
      cmp(a.sub ?? "", b.sub ?? "") ||
      cmp((a.args ?? []).join(","), (b.args ?? []).join(",")),
  );
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function readMigrations(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

// ---------------------------------------------------------------------------
// SQL output.
// ---------------------------------------------------------------------------

const lit = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const arrLit = (a) =>
  a === null || a === undefined
    ? "NULL"
    : a.length === 0
      ? "'{}'::text[]"
      : `ARRAY[${a.map(lit).join(", ")}]`;

export function generateSql(expected = collectExpected()) {
  const counts = KIND_ORDER.map((k) => `${k} ${expected.filter((e) => e.kind === k).length}`);
  const rows = expected.map(
    (e) =>
      `    (${lit(e.kind)}, ${lit(e.schema)}, ${lit(e.name)}, ${lit(e.sub)}, ${arrLit(e.args)}, ${lit(e.detail)}, ${lit(e.file)})`,
  );
  return `-- After-deploy schema check (Batch 28 item 9). GENERATED — do not edit by hand.
--
-- Regenerate after adding or changing a migration:   node scripts/schema-parity.mjs
-- (src/lib/batch28-schema-parity.test.ts fails while this file is stale.)
--
-- READ-ONLY: one SELECT over the catalogs (pg_proc, pg_class, pg_attribute,
-- pg_trigger) and cron.job. It changes nothing; run it in the SQL editor of
-- the database you just deployed to. Every row returned is an object that the
-- files in supabase/aidwar-migrations/*.sql create (and no later file drops)
-- but that is MISSING on this database. No rows = parity.
--
-- Functions match on schema + name + input argument types (to_regtype of
-- each expected type against pg_proc.proargtypes); a function that exists
-- only with other arguments is still listed, its detail says what was found.
-- Cron jobs match on cron.job.jobname. pg_cron is enabled on this project
-- (CREATE EXTENSION pg_cron in 20261053_cron_jobs.sql); cron.job is read via
-- query_to_xml only when to_regclass('cron.job') finds it, so the query
-- still runs where pg_cron is absent (every cron job is then listed).
--
-- Expected objects: ${counts.join(", ")}.
WITH expected (kind, schema_name, object_name, sub_name, arg_types, detail, introduced_in_file) AS (
  VALUES
${rows.join(",\n")}
),
cron_jobs AS (
  SELECT (xpath('/row/jobname/text()', r))[1]::text AS jobname
  FROM unnest(xpath('/table/row',
    CASE WHEN to_regclass('cron.job') IS NOT NULL
      THEN query_to_xml('SELECT jobname FROM cron.job', true, false, '')
    END)) AS r
),
expected_fn AS (
  SELECT e.*,
    (SELECT coalesce(array_agg(to_regtype(t)::oid ORDER BY i), '{}'::oid[])
       FROM unnest(e.arg_types) WITH ORDINALITY AS u(t, i)) AS arg_oids
  FROM expected e
  WHERE e.kind = 'function'
),
missing AS (
  SELECT f.kind,
    f.schema_name || '.' || f.object_name || '(' || array_to_string(f.arg_types, ', ') || ')' AS name,
    coalesce('found only: ' || (
      SELECT string_agg(f.object_name || '(' || pg_get_function_identity_arguments(p.oid) || ')', '; ')
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = f.schema_name AND p.proname = f.object_name
    ), 'no function of this name') AS detail,
    f.introduced_in_file
  FROM expected_fn f
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = f.schema_name AND p.proname = f.object_name
      AND p.proargtypes::oid[] = f.arg_oids
  )
  UNION ALL
  SELECT e.kind, e.schema_name || '.' || e.object_name, e.detail, e.introduced_in_file
  FROM expected e
  WHERE e.kind IN ('table', 'view', 'index')
    AND NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = e.schema_name AND c.relname = e.object_name
        AND c.relkind = ANY (CASE e.kind
          WHEN 'table' THEN ARRAY['r', 'p']::"char"[]
          WHEN 'view' THEN ARRAY['v', 'm']::"char"[]
          ELSE ARRAY['i', 'I']::"char"[] END)
    )
  UNION ALL
  SELECT e.kind, e.schema_name || '.' || e.object_name || '.' || e.sub_name, e.detail, e.introduced_in_file
  FROM expected e
  WHERE e.kind = 'column'
    AND NOT EXISTS (
      SELECT 1 FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = e.schema_name AND c.relname = e.object_name
        AND a.attname = e.sub_name AND a.attnum > 0 AND NOT a.attisdropped
    )
  UNION ALL
  SELECT e.kind, e.sub_name, e.detail, e.introduced_in_file
  FROM expected e
  WHERE e.kind = 'trigger'
    AND NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = e.schema_name AND c.relname = e.object_name
        AND t.tgname = e.sub_name AND NOT t.tgisinternal
    )
  UNION ALL
  SELECT e.kind, e.object_name,
    CASE WHEN to_regclass('cron.job') IS NULL THEN 'pg_cron not installed (cron.job missing)'
      ELSE e.detail END,
    e.introduced_in_file
  FROM expected e
  WHERE e.kind = 'cron_job'
    AND NOT EXISTS (SELECT 1 FROM cron_jobs j WHERE j.jobname = e.object_name)
)
SELECT kind, name, detail, introduced_in_file
FROM missing
ORDER BY array_position(ARRAY[${KIND_ORDER.map(lit).join(", ")}], kind), introduced_in_file, name;
`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv) {
  const sql = generateSql();
  if (argv.includes("--stdout")) {
    process.stdout.write(sql);
    return 0;
  }
  if (argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(OUTPUT_FILE, "utf8");
    } catch {
      // missing file counts as stale
    }
    if (current === sql) return 0;
    process.stderr.write("scripts/schema-parity.sql is stale: run node scripts/schema-parity.mjs\n");
    return 1;
  }
  writeFileSync(OUTPUT_FILE, sql);
  process.stderr.write(`wrote ${OUTPUT_FILE}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
