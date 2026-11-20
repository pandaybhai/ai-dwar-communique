/**
 * Constant-time compare for shared secrets (the cron secret on
 * /api/internal/*, OAuth binding nonces): the time taken never depends on
 * how many leading characters a guess got right.
 */
export function secretEquals(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!provided || !expected || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1)
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/**
 * The cron secret check for every /api/internal/* route: the header must
 * equal CRON_SECRET, or — only while a rotation is under way —
 * CRON_SECRET_PREVIOUS. Rotation without a missed cron run: set CRON_SECRET
 * to the new value and CRON_SECRET_PREVIOUS to the old one, change the Vault
 * secret 'aidwar_cron_secret' the jobs send, then remove
 * CRON_SECRET_PREVIOUS (the old value stops working). Unset or empty values
 * never match.
 */
export function cronSecretAccepted(
  provided: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const current = env["CRON_SECRET"]?.trim() || null;
  const previous = env["CRON_SECRET_PREVIOUS"]?.trim() || null;
  // Both compared every time (constant time, whichever matches).
  const a = secretEquals(provided, current);
  const b = secretEquals(provided, previous);
  return a || b;
}
