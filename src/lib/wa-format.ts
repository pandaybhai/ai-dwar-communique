/**
 * Batch 35: WhatsApp's own text formatting, for template authoring and for
 * showing messages the way the customer's phone shows them (display only —
 * the stored text is never changed).
 *
 * The markers are WhatsApp's (faq.whatsapp.com "How to format your
 * messages"): *bold*, _italic_, ~strikethrough~, ```monospace```, `inline
 * code`, "- " / "* " bulleted lines, "1. " numbered lines, "> " quotes.
 * A {{n}} template variable is never split by a marker.
 */

export type InlineStyle = "bold" | "italic" | "strike" | "mono" | "code";
export type InlineNode = { text: string } | { style: InlineStyle; children: InlineNode[] };
export type LineKind = "plain" | "bullet" | "number" | "quote";
export type FormattedLine = { kind: LineKind; marker: string; nodes: InlineNode[] };

const PAIRS: Array<{ marker: string; style: InlineStyle }> = [
  { marker: "*", style: "bold" },
  { marker: "_", style: "italic" },
  { marker: "~", style: "strike" },
];

const VARIABLE = /\{\{\s*\d+\s*\}\}/g;

/** Where every {{n}} sits in the text, as [start, end) ranges. */
export function variableRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of text.matchAll(VARIABLE)) out.push([m.index!, m.index! + m[0].length]);
  return out;
}

const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);
const isWordChar = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/**
 * WhatsApp's rule for a pair of markers on one line: the opener follows the
 * start of the line, a space or punctuation and is followed by a non-space;
 * the closer follows a non-space and is followed by the end, a space or
 * punctuation. "snake_case_word" and "2*3*4" stay plain.
 */
function findCloser(text: string, marker: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === "\n") return -1;
    if (text[i] !== marker) continue;
    if (i === open + 1) return -1;
    if (isSpace(text[i - 1])) continue;
    if (isWordChar(text[i + 1])) continue;
    return i;
  }
  return -1;
}

function canOpen(text: string, i: number): boolean {
  return !isWordChar(text[i - 1]) && !isSpace(text[i + 1]);
}

/** Parses one stretch of text into styled runs. Nesting works like WhatsApp: *_both_*. */
export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let plain = "";
  const flush = () => {
    if (plain) nodes.push({ text: plain });
    plain = "";
  };
  let i = 0;
  while (i < text.length) {
    // ```monospace``` — may hold anything, other markers included.
    if (text.startsWith("```", i)) {
      const end = text.indexOf("```", i + 3);
      if (end > i + 3) {
        flush();
        nodes.push({ style: "mono", children: [{ text: text.slice(i + 3, end) }] });
        i = end + 3;
        continue;
      }
    }
    const ch = text[i]!;
    if (ch === "`" && canOpen(text, i)) {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1 && !text.slice(i + 1, end).includes("\n")) {
        flush();
        nodes.push({ style: "code", children: [{ text: text.slice(i + 1, end) }] });
        i = end + 1;
        continue;
      }
    }
    const pair = PAIRS.find((p) => p.marker === ch);
    if (pair && canOpen(text, i)) {
      const end = findCloser(text, ch, i);
      if (end > 0) {
        flush();
        nodes.push({ style: pair.style, children: parseInline(text.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    plain += ch;
    i += 1;
  }
  flush();
  return nodes;
}

/** Splits text into lines, each a bullet, a numbered item, a quote or plain. */
export function parseWhatsAppText(text: string): FormattedLine[] {
  // A ```block``` may span lines: keep it whole on the line it opens.
  const lines: string[] = [];
  let buffer = "";
  let inBlock = false;
  for (const line of String(text ?? "").split("\n")) {
    const fences = (line.match(/```/g) ?? []).length;
    buffer = buffer ? `${buffer}\n${line}` : line;
    if (fences % 2 === 1) inBlock = !inBlock;
    if (!inBlock) {
      lines.push(buffer);
      buffer = "";
    }
  }
  if (buffer) lines.push(buffer);

  return lines.map((line) => {
    const bullet = line.match(/^([-*]) (.*)$/s);
    if (bullet) return { kind: "bullet", marker: "•", nodes: parseInline(bullet[2]!) };
    const numbered = line.match(/^(\d{1,3})\. (.*)$/s);
    if (numbered)
      return { kind: "number", marker: `${numbered[1]}.`, nodes: parseInline(numbered[2]!) };
    const quote = line.match(/^> ?(.*)$/s);
    if (quote) return { kind: "quote", marker: "", nodes: parseInline(quote[1]!) };
    return { kind: "plain", marker: "", nodes: parseInline(line) };
  });
}

/** The text with every marker taken out, e.g. for a one-line list preview. */
export function stripWhatsAppFormatting(text: string): string {
  const flat = (nodes: InlineNode[]): string =>
    nodes.map((n) => ("text" in n ? n.text : flat(n.children))).join("");
  return parseWhatsAppText(text)
    .map(
      (l) =>
        (l.kind === "bullet" ? "• " : l.kind === "number" ? `${l.marker} ` : "") + flat(l.nodes),
    )
    .join("\n");
}

/* ------------------------------------------------------------------ *
 * Authoring: the toolbar and its checks
 * ------------------------------------------------------------------ */

export type InlineAction = "bold" | "italic" | "strike" | "mono";
export type LineAction = "bullet" | "number" | "quote";

const MARKERS: Record<InlineAction, string> = { bold: "*", italic: "_", strike: "~", mono: "```" };

export type Edit = { text: string; start: number; end: number };

/** Moves a cursor that sits inside a {{n}} to the variable's nearer edge. */
function outsideVariable(text: string, pos: number, prefer: "start" | "end"): number {
  for (const [s, e] of variableRanges(text)) {
    if (pos > s && pos < e) return prefer === "start" ? s : e;
  }
  return pos;
}

/**
 * Wraps the selection in a WhatsApp marker. A selection edge inside {{n}} is
 * moved to the variable's edge first, so a marker never lands inside one;
 * spaces at the edges stay outside the markers (WhatsApp ignores "* bold *").
 * With nothing selected the two markers go in at the cursor.
 */
export function wrapSelection(
  text: string,
  start: number,
  end: number,
  action: InlineAction,
): Edit {
  const marker = MARKERS[action];
  let s = outsideVariable(text, Math.min(start, end), "start");
  let e = outsideVariable(text, Math.max(start, end), "end");
  while (s < e && /\s/.test(text[s]!)) s += 1;
  while (e > s && /\s/.test(text[e - 1]!)) e -= 1;
  const inner = text.slice(s, e);
  // Already wrapped: take the markers off instead.
  if (text.slice(s - marker.length, s) === marker && text.slice(e, e + marker.length) === marker) {
    const next = text.slice(0, s - marker.length) + inner + text.slice(e + marker.length);
    return { text: next, start: s - marker.length, end: e - marker.length };
  }
  const next = text.slice(0, s) + marker + inner + marker + text.slice(e);
  return { text: next, start: s + marker.length, end: e + marker.length };
}

/** Starts every selected line with "- ", "1. " (counting up) or "> "; again to take it off. */
export function prefixLines(text: string, start: number, end: number, action: LineAction): Edit {
  const from = text.lastIndexOf("\n", Math.max(0, Math.min(start, end) - 1)) + 1;
  const toNl = text.indexOf("\n", Math.max(start, end));
  const to = toNl === -1 ? text.length : toNl;
  const lines = text.slice(from, to).split("\n");
  const pattern = action === "bullet" ? /^[-*] / : action === "number" ? /^\d{1,3}\. / : /^> /;
  const allHave = lines.every((l) => pattern.test(l));
  const changed = lines.map((l, i) => {
    if (allHave) return l.replace(pattern, "");
    const bare = l.replace(/^([-*] |\d{1,3}\. |> )/, "");
    return (action === "bullet" ? "- " : action === "number" ? `${i + 1}. ` : "> ") + bare;
  });
  const block = changed.join("\n");
  return {
    text: text.slice(0, from) + block + text.slice(to),
    start: from,
    end: from + block.length,
  };
}

/**
 * What's wrong with the formatting of a template's text, in plain words:
 * a marker inside a {{n}}, or an opening marker that is never closed on its
 * line (or a ``` never closed at all).
 */
export function formattingProblems(text: string, label = "The body"): string[] {
  const problems: string[] = [];
  const value = String(text ?? "");
  for (const m of value.matchAll(/\{\{[^{}]*\}\}/g)) {
    if (/[*_~`]/.test(m[0])) {
      problems.push(
        `${label} has a style mark inside ${m[0]} — put * _ ~ \` outside the variable, like *{{1}}*.`,
      );
      break;
    }
  }
  if ((value.match(/```/g) ?? []).length % 2 === 1) {
    problems.push(`${label} has a \`\`\` that is never closed.`);
  }
  // Unclosed *, _ or ~ : an opener WhatsApp would treat as one, with no closer on its line.
  const noBlocks = value
    .replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length))
    .replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));
  const names: Record<string, string> = { "*": "bold *", _: "italic _", "~": "strikethrough ~" };
  outer: for (const line of noBlocks.split("\n")) {
    // A "* " bullet at the start of a line isn't a marker.
    const body = line.replace(/^\* /, "  ");
    for (let i = 0; i < body.length; i++) {
      const ch = body[i]!;
      if (!(ch in names) || !canOpen(body, i)) continue;
      const end = findCloser(body, ch, i);
      if (end < 0) {
        problems.push(
          `${label} has a ${names[ch]} that is never closed — add the closing ${ch} or remove it.`,
        );
        break outer;
      }
      i = end;
    }
  }
  return problems;
}
