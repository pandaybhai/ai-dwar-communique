import { toWaId, typedPhone } from "@/lib/phone";

/**
 * Batch 66: the number Add contact saves — the one phone rule with the
 * workspace's default country code (9908109123 → +919908109123), or why not.
 * Since Batch 69 the wording comes from typedPhone, shared by every form.
 */
export function addContactPhone(
  typed: string,
  defaultCountryCode: string | null,
  codeError: string | null = null,
): { phone: string; waId: string } | { error: string } {
  const out = typedPhone(typed, defaultCountryCode, codeError);
  if ("error" in out) return out;
  return { phone: out.phone, waId: toWaId(out.phone) };
}
