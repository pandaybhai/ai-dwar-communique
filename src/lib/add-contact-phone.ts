import { enteredPhone, phoneProblemText, toWaId } from "@/lib/phone";

/**
 * Batch 66: the number Add contact saves — the one phone rule with the
 * workspace's default country code (9908109123 → +919908109123), or why not.
 */
export function addContactPhone(
  typed: string,
  defaultCountryCode: string | null,
  codeError: string | null = null,
): { phone: string; waId: string } | { error: string } {
  const entered = enteredPhone(typed, defaultCountryCode);
  if (entered.ok) return { phone: entered.phone, waId: toWaId(entered.phone) };
  if (entered.problem === "needs_country")
    return { error: codeError ?? "Add the country code, e.g. +91 98765 43210." };
  return {
    error: `${phoneProblemText(entered.problem)}. Enter it with the country code, e.g. +91 98765 43210.`,
  };
}
