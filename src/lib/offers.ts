/**
 * Offer timing helpers.
 *
 * A merchant picks the moment an offer ends as wall-clock time in their own
 * workspace timezone — not the timezone of the laptop they happen to be using.
 * Everything here converts between the two and explains, in plain language,
 * when the chosen moment doesn't make sense.
 */

/** How far the given timezone sits from UTC, in minutes, at that instant. */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return (asUtc - instant.getTime()) / 60000;
}

/**
 * "2026-09-10" + "18:30" read in the workspace timezone, returned as a UTC
 * instant. Two passes so the answer stays right across a DST change.
 */
export function zonedToUtcIso(
  date: string,
  time: string,
  timeZone: string,
): string | null {
  if (!date) return null;
  const [h, m] = (time || "23:59").split(":");
  const naive = Date.parse(
    `${date}T${String(h ?? "23").padStart(2, "0")}:${String(m ?? "59").padStart(2, "0")}:00Z`,
  );
  if (Number.isNaN(naive)) return null;
  let instant = naive;
  for (let i = 0; i < 2; i += 1) {
    const offset = zoneOffsetMinutes(new Date(instant), timeZone);
    instant = naive - offset * 60000;
  }
  return new Date(instant).toISOString();
}

/** Wall-clock rendering of an instant in the workspace timezone. */
export function formatInZone(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

/** "2d 04:11:07" — the countdown WhatsApp shows on a limited-time offer. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return "Offer ended";
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const clock = [hours, minutes, seconds]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
  return days > 0 ? `${days}d ${clock}` : clock;
}

export type OfferTimingIssue = {
  level: "error" | "warning";
  message: string;
};

/** How much runway an offer needs after it lands to be worth sending. */
const MIN_RUNWAY_MINUTES = 60;

/**
 * Plain-language check on the chosen end time. `sendAt` is null when the
 * campaign sends immediately.
 */
export function offerTimingIssue(args: {
  expiresAt: string | null;
  sendAt: string | null;
  timeZone: string;
  now?: Date;
}): OfferTimingIssue | null {
  const { expiresAt, sendAt, timeZone } = args;
  if (!expiresAt) return null;
  const end = new Date(expiresAt).getTime();
  if (Number.isNaN(end)) {
    return { level: "error", message: "That end time isn't a real date and time." };
  }
  const now = (args.now ?? new Date()).getTime();
  const send = sendAt ? new Date(sendAt).getTime() : now;

  if (end <= now) {
    return {
      level: "error",
      message: `That moment has already passed in ${timeZone.replace("_", " ")}. Pick a time in the future.`,
    };
  }
  if (end <= send) {
    return {
      level: "error",
      message:
        "The offer would already be over when this campaign sends. Move the end time after the send time.",
    };
  }
  const runway = (end - send) / 60000;
  if (runway < MIN_RUNWAY_MINUTES) {
    return {
      level: "warning",
      message: `Customers get only ${Math.max(1, Math.round(runway))} minute${
        Math.round(runway) === 1 ? "" : "s"
      } to use this. Give them at least an hour so the countdown is worth tapping.`,
    };
  }
  return null;
}
