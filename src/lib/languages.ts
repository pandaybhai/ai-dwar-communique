/**
 * The languages the AI employee can work in, and a cheap way to tell which one
 * a customer just wrote in. Detection is script- and word-based on purpose:
 * it runs on every inbound message, so it must cost nothing.
 */

export type LanguageCode = "en" | "hi" | "mr" | "gu" | "ta" | "bn" | "te" | "kn";

export const LANGUAGES: { code: LanguageCode; name: string; native: string }[] = [
  { code: "en", name: "English", native: "English" },
  { code: "hi", name: "Hindi", native: "हिन्दी" },
  { code: "mr", name: "Marathi", native: "मराठी" },
  { code: "gu", name: "Gujarati", native: "ગુજરાતી" },
  { code: "ta", name: "Tamil", native: "தமிழ்" },
  { code: "bn", name: "Bengali", native: "বাংলা" },
  { code: "te", name: "Telugu", native: "తెలుగు" },
  { code: "kn", name: "Kannada", native: "ಕನ್ನಡ" },
];

export const DEFAULT_LANGUAGES: LanguageCode[] = ["en", "hi"];

export function languageName(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.name ?? code;
}

export function languageLabel(code: string): string {
  const found = LANGUAGES.find((l) => l.code === code);
  return found ? (found.code === "en" ? found.name : `${found.name} (${found.native})`) : code;
}

/** Words that give away Hinglish written in Latin script. */
const HINGLISH = [
  "hai", "haan", "nahi", "nhi", "kya", "kaise", "kitna", "kitne", "kab", "kahan",
  "chahiye", "bhai", "kar", "karna", "karo", "mera", "mujhe", "aap", "apka",
  "milega", "bhej", "bhejo", "dena", "acha", "accha", "theek", "thik", "paisa",
  "order", "wala", "wali", "abhi", "please bhej",
];

const SCRIPTS: { code: LanguageCode; re: RegExp }[] = [
  { code: "ta", re: /[\u0B80-\u0BFF]/ },
  { code: "te", re: /[\u0C00-\u0C7F]/ },
  { code: "kn", re: /[\u0C80-\u0CFF]/ },
  { code: "gu", re: /[\u0A80-\u0AFF]/ },
  { code: "bn", re: /[\u0980-\u09FF]/ },
  // Devanagari covers both Hindi and Marathi; a few Marathi-only markers split them.
  { code: "hi", re: /[\u0900-\u097F]/ },
];

const MARATHI_MARKERS = /(आहे|नाही|काय|तुम्ही|मला|कसे|किती|पाहिजे)/;

/**
 * A best guess at the language of one message. Returns a language code, or
 * "hi-Latn" for Hinglish, or null when there is nothing to go on.
 */
export function detectLanguage(text: string | null | undefined): string | null {
  const body = (text ?? "").trim();
  if (body.length < 2) return null;

  for (const s of SCRIPTS) {
    if (s.re.test(body)) {
      if (s.code === "hi" && MARATHI_MARKERS.test(body)) return "mr";
      return s.code;
    }
  }

  if (/[A-Za-z]/.test(body)) {
    const words = body.toLowerCase().split(/[^a-z]+/).filter(Boolean);
    const hits = words.filter((w) => HINGLISH.includes(w)).length;
    if (hits >= 1 && words.length <= 25 && hits / words.length >= 0.12) return "hi-Latn";
    return "en";
  }

  return null;
}

/** Language names mentioned inside free-text instructions, as codes. */
export function languagesMentioned(text: string): LanguageCode[] {
  const lower = (text ?? "").toLowerCase();
  return LANGUAGES.filter(
    (l) => new RegExp(`\\b${l.name.toLowerCase()}\\b`).test(lower) || lower.includes(l.native),
  ).map((l) => l.code);
}
