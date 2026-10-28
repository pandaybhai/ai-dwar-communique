import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiCaller, ApiReply } from "@/lib/public-api.server";

/**
 * Batch 37 item 6: GET /api/v1/account/balance — the workspace's AiDwar
 * wallet and what one message costs, per category, for a country.
 *
 * Read only through what Billing already reads, never a second sum: the
 * wallet row (ensureWallet: balance and held move with every wallet_ledger
 * entry, in the same transaction, by wallet_apply), creditsCover for what can
 * be spent now (balance + overdraft − held, the sum a send checks), and
 * rateFor (client_rate_for) for the prices — the rates a message is debited
 * at. The country is ?country= (two letters), or the one of ?to= (the
 * rate card's dial codes, as the debit finds it), else India.
 */

const fail = (status: number, code: string, error: string): ApiReply => ({
  status,
  body: { error, code },
});

export async function accountBalance(
  supabase: SupabaseClient,
  caller: ApiCaller,
  query: URLSearchParams,
): Promise<ApiReply> {
  const orgId = caller.organizationId;
  let country = "IN";
  const askedCountry = query.get("country");
  const askedTo = query.get("to");
  if (askedCountry !== null) {
    if (!/^[A-Za-z]{2}$/.test(askedCountry))
      return fail(400, "invalid_filter", "`country` must be a two-letter country code, e.g. IN.");
    country = askedCountry.toUpperCase();
  } else if (askedTo !== null) {
    const { normalizePhone, toWaId } = await import("@/lib/phone");
    const digits = toWaId(normalizePhone(askedTo));
    if (digits.length < 8 || digits.length > 15)
      return fail(400, "invalid_to", "`to` must be a WhatsApp number with its country code.");
    const { countryForPhone } = await import("@/lib/public-api-send.server");
    country = await countryForPhone(supabase, digits);
  }

  const billing = await import("@/lib/billing.server");
  const { MESSAGE_CATEGORIES, round2, round4 } = await import("@/lib/billing");
  const [enabled, wallet, cover, rates] = await Promise.all([
    billing.billingEnabled(supabase, orgId),
    billing.ensureWallet(supabase, orgId),
    billing.creditsCover(supabase, orgId, 0),
    Promise.all(
      MESSAGE_CATEGORIES.map((category) => billing.rateFor(supabase, orgId, category, country)),
    ),
  ]);
  const currency = String(wallet["currency"] ?? "INR");
  return {
    status: 200,
    body: {
      balance: round2(Number(wallet["balance"] ?? 0)),
      held: round2(Number(wallet["held"] ?? 0)),
      available: cover.available,
      currency,
      billing_enabled: enabled,
      country,
      prices: MESSAGE_CATEGORIES.map((category, i) => ({
        category,
        price: round4(rates[i]!.rate),
        currency: rates[i]!.currency,
      })),
      as_of: new Date().toISOString(),
    },
    headers: { "cache-control": "no-store" },
  };
}
