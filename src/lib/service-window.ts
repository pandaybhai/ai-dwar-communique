export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The plain-language reason we give when free-form text isn't allowed. */
export const SERVICE_WINDOW_CLOSED_MESSAGE =
  "This contact hasn't messaged you in the last 24 hours, so free-form text isn't allowed. Send an approved template instead.";

/**
 * WhatsApp only allows free-form (non-template) messages within 24 hours of the
 * customer's last message. One rule, used by every send path, so a reply from
 * the inbox, an automation and the AI employee all behave the same way.
 */
export function isServiceWindowOpen(
  conversation: { last_customer_message_at?: string | null } | null | undefined,
  now: number = Date.now(),
): boolean {
  const last = conversation?.last_customer_message_at;
  if (!last) return false;
  const at = new Date(last).getTime();
  if (Number.isNaN(at)) return false;
  return now - at <= SERVICE_WINDOW_MS;
}
