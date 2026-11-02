/**
 * Batch 29: the order the brief's sections reach the model. Everything that
 * is the same for every customer of a workspace comes first; the customer's
 * language ("spoken") and the corrections count ("taught", it moves with
 * every correction) go last — so the long start of the prompt is identical
 * from one reply to the next and the provider can cache it. The sections'
 * own order (as /app shows them) is unchanged.
 */
const LAST = ["taught", "spoken"];

export function promptSections<T extends { key: string }>(sections: T[]): T[] {
  return [
    ...sections.filter((s) => !LAST.includes(s.key)),
    ...LAST.flatMap((k) => sections.filter((s) => s.key === k)),
  ];
}

/**
 * Batch 60: the shop's own instructions exactly as a brief carries them (the
 * Playground's unsaved wording when it gave one) — the policy check's first
 * material and the warm fallback's link (RunOptions.shopInstructions).
 */
export function shopInstructionsOf(brief: {
  sections: Array<{ key: string; text: string }>;
}): string {
  return (brief.sections.find((s) => s.key === "instructions")?.text ?? "").trim();
}
