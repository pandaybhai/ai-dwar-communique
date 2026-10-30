/**
 * Batch 57: Aiden Workspace's Home greets the person by first name at the
 * time of day in the workspace's timezone ("Good morning, Riya"). Words only;
 * nothing is read for it but the profile's own name.
 */

/** The hour (0 to 23) at `now` in `timezone`; the browser's own hour if the zone is unknown. */
export function hourIn(timezone: string, now: Date = new Date()): number {
  try {
    const h = new Intl.DateTimeFormat("en-GB", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone: timezone,
    }).format(now);
    const n = Number.parseInt(h, 10);
    return Number.isFinite(n) ? n % 24 : now.getHours();
  } catch {
    return now.getHours();
  }
}

/** "Good morning" before 12, "Good afternoon" before 17, then "Good evening". */
export function partOfDay(hour: number): string {
  if (hour >= 4 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  return "Good evening";
}

/** The first word of a person's name, or null when there is no usable name (an email is not a name). */
export function firstNameOf(fullName: string | null | undefined): string | null {
  const name = (fullName ?? "").trim();
  if (!name || name.includes("@")) return null;
  return name.split(/\s+/)[0] ?? null;
}

export function greetingFor(
  fullName: string | null | undefined,
  timezone: string,
  now: Date = new Date(),
): string {
  const part = partOfDay(hourIn(timezone, now));
  const first = firstNameOf(fullName);
  return first ? `${part}, ${first}` : part;
}
