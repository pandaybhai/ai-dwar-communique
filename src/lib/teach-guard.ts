/**
 * What may be taken as an owner teaching us an answer.
 *
 * A tap on a suggested question is not an answer. Neither is another question,
 * nor a one-word "ok". Getting this wrong writes nonsense into the business's
 * knowledge, so the test is deliberately strict.
 */

/** How long a teaching prompt stays open before ordinary chat resumes. */
export const TEACH_WINDOW_MS = 15 * 60 * 1000;

const CONTROL_WORDS = new Set([
  "ok",
  "okay",
  "yes",
  "no",
  "hi",
  "hey",
  "hello",
  "test me",
  "done",
  "cancel",
  "skip",
]);

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!]+$/, "");
}

/** "skip" and friends: the owner is calling the question off. */
export function isSkipWord(body: string): boolean {
  const t = normalize(body);
  return t === "skip" || t === "cancel";
}

/**
 * The short words that steer the chat rather than say anything about the
 * business. They are never a question, never an answer, never a fact.
 */
export type ControlWord = "skip" | "help" | "test" | "greeting" | "ack";

export function controlWord(body: string): ControlWord | null {
  const t = normalize(body);
  if (t === "skip" || t === "cancel") return "skip";
  if (t === "help") return "help";
  if (t === "test me" || t === "test") return "test";
  if (t === "hi" || t === "hey" || t === "hello") return "greeting";
  if (t === "ok" || t === "okay" || t === "yes" || t === "no" || t === "done") return "ack";
  return null;
}

/** A workspace code, anywhere in the message: "AD-CMCP". */
export const CODE_RE = /\bAD-[A-Z0-9]{4}\b/i;

/**
 * Nothing but an address, a code or a phone number. Storing one of these as a
 * business fact is how the notebook gets poisoned, so they never qualify.
 */
export function isBareReference(body: string): boolean {
  const t = (body ?? "").trim();
  if (!t) return true;
  if (CODE_RE.test(t)) return true;
  const stripped = t
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}(?:\/\S*)?\b/gi, " ")
    .replace(/[+]?\d[\d\s().-]{7,}\d/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return stripped.split(/\s+/).filter(Boolean).length < 3;
}


/** True when this message may be stored as the answer to a pending question. */
export function isTeachableAnswer(
  body: string,
  opts: { interactive?: boolean; suggestions?: string[] } = {},
): boolean {
  if (opts.interactive) return false;
  const text = (body ?? "").trim();
  if (!text) return false;
  if (text.endsWith("?")) return false;

  const norm = normalize(text);
  for (const s of opts.suggestions ?? []) {
    const sn = normalize(s ?? "");
    if (!sn) continue;
    // Button titles are truncated to 20 characters, so compare on prefixes too.
    if (sn === norm || sn.startsWith(norm) || norm.startsWith(sn)) return false;
  }

  const words = norm.split(" ").filter(Boolean);
  if (words.length < 3 && CONTROL_WORDS.has(norm)) return false;
  return true;
}

/** True when the teaching prompt is older than the window and should lapse. */
export function teachWindowExpired(askedAt: string | null | undefined, now = Date.now()): boolean {
  if (!askedAt) return false;
  const t = Date.parse(askedAt);
  if (Number.isNaN(t)) return false;
  return now - t > TEACH_WINDOW_MS;
}
