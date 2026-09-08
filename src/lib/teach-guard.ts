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
