/**
 * Batch 38: a small, dependency-free highlighter for the developer portal's
 * code panels — JSON, shell (cURL), JavaScript, Python, PHP and Go. It only
 * colours strings, numbers, keywords, JSON keys and comments; the text is
 * never changed (joining the tokens gives the code back exactly). Pure.
 */

export type Token = {
  t: "plain" | "string" | "number" | "keyword" | "key" | "comment" | "punct";
  v: string;
};

const KEYWORDS: Record<string, string[]> = {
  node: [
    "import",
    "from",
    "const",
    "let",
    "await",
    "async",
    "function",
    "return",
    "if",
    "throw",
    "new",
    "for",
    "export",
    "true",
    "false",
    "null",
    "of",
  ],
  python: [
    "import",
    "def",
    "return",
    "if",
    "not",
    "and",
    "or",
    "True",
    "False",
    "None",
    "for",
    "in",
    "with",
    "as",
  ],
  php: ["function", "return", "if", "true", "false", "null", "array", "string", "bool"],
  go: [
    "package",
    "import",
    "func",
    "return",
    "if",
    "err",
    "nil",
    "var",
    "true",
    "false",
    "string",
    "bool",
  ],
  curl: ["curl", "export"],
  bash: ["curl", "export"],
  json: ["true", "false", "null"],
};

const COMMENT: Record<string, RegExp> = {
  node: /\/\/[^\n]*|\/\*[\s\S]*?\*\//y,
  go: /\/\/[^\n]*/y,
  php: /\/\/[^\n]*|#[^\n]*/y,
  python: /#[^\n]*/y,
  curl: /(?<=^|\s)#[^\n]*/y,
  bash: /(?<=^|\s)#[^\n]*/y,
};

const STRING = /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/y;
const NUMBER = /-?\b\d+(?:\.\d+)?\b/y;
const WORD = /[A-Za-z_$][\w$]*/y;
const PUNCT = /[{}[\](),:;]/y;

export function highlight(lang: string, code: string): Token[] {
  const words = new Set(KEYWORDS[lang] ?? []);
  const comment = COMMENT[lang];
  const out: Token[] = [];
  const push = (t: Token["t"], v: string) => {
    const last = out[out.length - 1];
    if (last && last.t === t && t === "plain") last.v += v;
    else out.push({ t, v });
  };
  let i = 0;
  const at = (re: RegExp) => {
    re.lastIndex = i;
    const m = re.exec(code);
    return m && m.index === i ? m[0] : null;
  };
  while (i < code.length) {
    const c = comment ? at(comment) : null;
    if (c) {
      push("comment", c);
      i += c.length;
      continue;
    }
    const s = at(STRING);
    if (s) {
      // A JSON / object key: a string followed by a colon.
      const rest = code.slice(i + s.length);
      const isKey =
        (lang === "json" ||
          lang === "node" ||
          lang === "python" ||
          lang === "php" ||
          lang === "curl") &&
        /^\s*:/.test(rest);
      push(isKey ? "key" : "string", s);
      i += s.length;
      continue;
    }
    const n = at(NUMBER);
    if (n && !/[\w$]/.test(code[i - 1] ?? "")) {
      push("number", n);
      i += n.length;
      continue;
    }
    const w = at(WORD);
    if (w) {
      push(words.has(w) ? "keyword" : "plain", w);
      i += w.length;
      continue;
    }
    const p = at(PUNCT);
    if (p) {
      push("punct", p);
      i += p.length;
      continue;
    }
    push("plain", code[i]!);
    i += 1;
  }
  return out;
}
