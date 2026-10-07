/**
 * Constant-time compare for shared secrets (the cron secret on
 * /api/internal/*, OAuth binding nonces): the time taken never depends on
 * how many leading characters a guess got right.
 */
export function secretEquals(provided: string | null | undefined, expected: string | null | undefined): boolean {
  if (!provided || !expected || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
