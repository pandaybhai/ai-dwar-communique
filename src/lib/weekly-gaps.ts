import { normalizeKeyword } from "@/lib/opt-out";

/**
 * What counts as a real thing the employee couldn't answer.
 *
 * The weekly report is a trust document. Listing a greeting, an opt-out, or a
 * question that was answered fine an hour later as a "failure" makes the whole
 * report read as noise, so all three are filtered out here rather than shown.
 */

const GREETINGS = new Set([
  "hi", "hey", "hello", "hlo", "helo", "yo", "hey there", "hi there", "hello there",
  "hi buddy", "hey buddy", "hii", "hiii", "heyy", "namaste", "namaskar", "salaam",
  "good morning", "good afternoon", "good evening", "good night", "gm", "gn",
  "thanks", "thank you", "thanks a lot", "thank u", "thx", "ty", "shukriya", "dhanyavad",
  "ok", "okay", "okk", "k", "fine", "cool", "great", "nice", "got it", "sure",
  "yes", "no", "yep", "yeah", "nope", "hmm", "haan", "nahi", "theek hai", "acha",
  "bye", "goodbye", "see you", "welcome", "you too", "np", "no problem",
  "test", "testing", "?", "..",
]);

/** Phrases that mean "stop messaging me" or "keep messaging me" in any spelling. */
const OPT_INTENT = [
  "mat bhejo", "band karo", "band kar", "stop sending", "stop messaging", "stop the messages",
  "unsubscribe", "opt out", "opt me out", "remove me", "do not message", "dont message",
  "don t message", "no more messages", "keep sending", "dont stop sending", "don t stop sending",
  "resubscribe", "subscribe me", "shuru karo", "start sending",
];

export function normalizeQuestion(text: string): string {
  return normalizeKeyword(text ?? "");
}

/** True for greetings, thanks and other chatter with nothing learnable in it. */
export function isSmallTalk(text: string): boolean {
  const t = normalizeQuestion(text);
  if (!t) return true;
  if (GREETINGS.has(t)) return true;
  // Two short words that are both chatter ("hey hi", "ok thanks").
  const words = t.split(" ");
  if (words.length <= 3 && words.every((w) => GREETINGS.has(w))) return true;
  // No question and very short — "hey buddy", "cool man".
  if (words.length <= 2 && !t.includes("?") && GREETINGS.has(words[0] ?? "")) return true;
  return false;
}

/** True when the message is an opt-out / opt-in intent the keyword layer owns. */
export function isOptIntent(text: string): boolean {
  const t = normalizeQuestion(text);
  if (!t) return false;
  return OPT_INTENT.some((p) => t.includes(p));
}

export type GapCandidate = {
  status: string;
  escalation_signal: string | null;
  input_summary: string | null;
  created_at: string;
};

export type Gap = { question: string; times: number; last_at: string };

/**
 * Keeps only questions the employee escalated with no source to answer from,
 * that nothing else in the system handled and that it never answered elsewhere
 * in the same week.
 */
export function genuineGaps(
  rows: GapCandidate[],
  opts: { answeredQuestions?: Iterable<string>; handledElsewhere?: Iterable<string> } = {},
): Gap[] {
  const answered = new Set(Array.from(opts.answeredQuestions ?? [], normalizeQuestion));
  const handled = new Set(Array.from(opts.handledElsewhere ?? [], normalizeQuestion));

  const gaps = new Map<string, Gap>();
  for (const r of rows) {
    if (r.status !== "escalated" || r.escalation_signal !== "no_source") continue;
    const question = (r.input_summary ?? "").trim();
    const key = normalizeQuestion(question);
    if (!question || !key) continue;
    if (isSmallTalk(question) || isOptIntent(question)) continue;
    if (answered.has(key) || handled.has(key)) continue;
    const existing = gaps.get(key);
    if (existing) existing.times += 1;
    else gaps.set(key, { question, times: 1, last_at: r.created_at });
  }
  return Array.from(gaps.values()).sort((a, b) => b.times - a.times).slice(0, 8);
}
