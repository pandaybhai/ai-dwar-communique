/**
 * Single source of truth for phone formatting.
 * `normalizePhone` returns E.164 with a leading `+` (digits only otherwise).
 * `toWaId` returns the digits-only form Meta expects in API calls / wa_id.
 */
export function normalizePhone(input: string | null | undefined): string {
  const digits = String(input ?? "").replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

export function toWaId(input: string | null | undefined): string {
  return String(input ?? "").replace(/\D/g, "");
}
