/** Built-in opt-out / opt-in keywords. Organizations can add their own. */
export const DEFAULT_OPT_OUT_KEYWORDS = [
  "STOP",
  "UNSUBSCRIBE",
  "OPT OUT",
  "OPTOUT",
  "band karo",
  "mat bhejo",
];

export const DEFAULT_OPT_IN_KEYWORDS = ["START", "RESUBSCRIBE", "shuru karo"];

export const OPT_OUT_CONFIRMATION =
  "You've been unsubscribed and won't receive further messages. Reply START to resubscribe.";

export const OPT_IN_CONFIRMATION =
  "You're subscribed again and will receive our updates. Reply STOP anytime to unsubscribe.";

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.!,;:"'()\-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Matches an inbound message against opt-out / opt-in keywords. Case-insensitive,
 * trimmed and whitespace-collapsed, and the WHOLE message must equal the keyword —
 * "please don't stop sending" never opts anyone out.
 */
export function matchKeyword(
  body: string | null | undefined,
  keywords: string[],
): string | null {
  const text = normalize(body ?? "");
  if (!text) return null;
  for (const raw of keywords) {
    const k = normalize(raw);
    if (!k) continue;
    if (text === k) return raw;
  }
  return null;
}


/** Quality ratings we treat as healthy. */
export function qualityIsHealthy(rating: string | null | undefined): boolean {
  const r = (rating ?? "").toUpperCase();
  return r === "GREEN" || r === "HIGH" || r === "" || r === "UNKNOWN";
}

export function qualityLabel(rating: string | null | undefined): string {
  const r = (rating ?? "UNKNOWN").toUpperCase();
  if (r === "HIGH") return "GREEN";
  if (r === "MEDIUM") return "YELLOW";
  if (r === "LOW") return "RED";
  return r;
}

export function qualityClass(rating: string | null | undefined): string {
  const r = qualityLabel(rating);
  if (r === "GREEN") return "border-primary/25 bg-primary/10 text-primary";
  if (r === "YELLOW") return "border-amber-500/25 bg-amber-500/10 text-amber-600";
  if (r === "RED") return "border-destructive/25 bg-destructive/10 text-destructive";
  return "border-border bg-muted text-muted-foreground";
}
