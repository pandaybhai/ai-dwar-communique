/**
 * When may a read forget pages (or hide products) it didn't see this time?
 *
 * Only after a COMPLETED FULL read, and only for items that are gone (404/410)
 * or absent from the full site map. Partial reads (quick read, "Read changes
 * now", weekly refresh, on-demand, one pass of a multi-pass read) never forget
 * anything. A run that would forget more than `maxShare` of what we have is
 * skipped with an alert — that shape is almost always a broken read, not a
 * shrinking site.
 */
export type ForgetInput = {
  existing: string[];
  fullReadComplete: boolean;
  siteMap: Iterable<string>;
  gone: Iterable<string>;
  maxShare?: number;
};

export type ForgetPlan = {
  remove: string[];
  skipped: "partial_read" | "over_cap" | null;
  candidates: number;
};

export function normalizeRef(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${u.protocol}//${u.host.toLowerCase().replace(/^www\./, "")}${path}${u.search}`;
  } catch {
    return url.trim().replace(/\/+$/, "");
  }
}

export function planForget(input: ForgetInput): ForgetPlan {
  if (!input.fullReadComplete) return { remove: [], skipped: "partial_read", candidates: 0 };
  const map = new Set(Array.from(input.siteMap, normalizeRef));
  const gone = new Set(Array.from(input.gone, normalizeRef));
  const candidates = input.existing.filter((ref) => {
    const n = normalizeRef(ref);
    return gone.has(n) || !map.has(n);
  });
  const cap = Math.floor(input.existing.length * (input.maxShare ?? 0.2));
  if (candidates.length > cap) return { remove: [], skipped: "over_cap", candidates: candidates.length };
  return { remove: candidates, skipped: null, candidates: candidates.length };
}
