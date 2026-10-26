/** The workspace's local day, as an instant. Pure: no client, no database. */

/**
 * Midnight that starts today in the workspace's timezone, as an instant — the
 * same day boundary Analytics uses (analytics_window: the local calendar day
 * of `localDate`). Batch 28: Home reads it too, so "today" means one thing.
 */
export function localDayStartIso(timezone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const localMidnightAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), 0, 0, 0);
  const localNowAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  const offsetMs = Math.round((now.getTime() - localNowAsUtc) / 1000) * 1000;
  return new Date(localMidnightAsUtc + offsetMs).toISOString();
}
