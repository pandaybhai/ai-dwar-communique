import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Short links behind template URL buttons.
 *
 * A URL button that carries a variable must be given its value at send time,
 * and the value has to be short. We mint a random, non-guessable token per
 * send so one customer's link can never be walked to another's.
 */

const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TOKEN_LENGTH = 10;
export const SHORT_LINK_TTL_DAYS = 30;

/** Cryptographically random, URL-safe, never sequential. */
export function generateShortToken(length = TOKEN_LENGTH): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export type ShortLinkInput = {
  organizationId: string;
  targetUrl: string;
  scheduledSendId?: string | null;
  contactId?: string | null;
  ttlDays?: number;
};

/**
 * Creates one short link and returns its token. Retries on the (astronomically
 * unlikely) token collision rather than failing a send.
 */
export async function createShortLink(
  supabase: SupabaseClient,
  input: ShortLinkInput,
): Promise<{ token: string | null; error: string | null }> {
  const expiresAt = new Date(
    Date.now() + (input.ttlDays ?? SHORT_LINK_TTL_DAYS) * 86_400_000,
  ).toISOString();

  let lastError = "could not create a short link";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = generateShortToken();
    const { error } = await supabase.from("short_links").insert({
      organization_id: input.organizationId,
      token,
      target_url: input.targetUrl,
      scheduled_send_id: input.scheduledSendId ?? null,
      contact_id: input.contactId ?? null,
      expires_at: expiresAt,
    });
    if (!error) return { token, error: null };
    lastError = error.message;
    if (!error.message.toLowerCase().includes("duplicate")) break;
  }
  return { token: null, error: lastError };
}

export type ShortLinkRow = {
  id: string;
  organization_id: string;
  target_url: string;
  scheduled_send_id: string | null;
  contact_id: string | null;
  expires_at: string | null;
};

export async function resolveShortLink(
  supabase: SupabaseClient,
  token: string,
): Promise<ShortLinkRow | null> {
  const { data } = await supabase
    .from("short_links")
    .select("id, organization_id, target_url, scheduled_send_id, contact_id, expires_at")
    .eq("token", token)
    .maybeSingle();
  return (data as ShortLinkRow | null) ?? null;
}

/** Counts the click. Never allowed to hold up the redirect. */
export async function recordShortLinkClick(
  supabase: SupabaseClient,
  row: ShortLinkRow,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { data: current } = await supabase
    .from("short_links")
    .select("click_count, first_clicked_at")
    .eq("id", row.id)
    .maybeSingle();
  const count = Number((current as { click_count?: number } | null)?.click_count ?? 0) + 1;
  await supabase
    .from("short_links")
    .update({
      click_count: count,
      first_clicked_at:
        (current as { first_clicked_at?: string | null } | null)?.first_clicked_at ?? nowIso,
      last_clicked_at: nowIso,
    })
    .eq("id", row.id);
}

/** Where an unknown or expired link should land — the merchant's own shop. */
export async function fallbackShopUrl(
  supabase: SupabaseClient,
  organizationId: string | null,
): Promise<string> {
  if (organizationId) {
    const { data } = await supabase
      .from("integrations")
      .select("shop_domain")
      .eq("organization_id", organizationId)
      .eq("provider", "shopify")
      .not("shop_domain", "is", null)
      .limit(1)
      .maybeSingle();
    const domain = (data as { shop_domain?: string | null } | null)?.shop_domain;
    if (domain) return `https://${domain}`;
  }
  return "https://aidwar.in";
}
