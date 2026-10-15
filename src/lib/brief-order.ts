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
