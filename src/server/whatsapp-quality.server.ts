import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The ONE place that reads a phone number's quality + sending tier from Meta
 * and stores it. Both the workspace-side refresh route and the platform
 * owner's admin sync go through here — never fetch these fields elsewhere.
 *
 * messaging_limit_tier is stored as Meta's raw string, or 'NOT_AVAILABLE'
 * when Meta omits the field (test numbers), so null keeps its meaning of
 * "never synced".
 */
export async function refreshPhoneNumberQuality(
  supabase: SupabaseClient,
  input: {
    whatsappAccountId: string;
    organizationId: string;
    phoneNumberId: string;
    accessToken: string;
  },
): Promise<{
  ok: boolean;
  error?: string;
  qualityRating?: string;
  messagingTier?: string;
  nameStatus?: string | null;
  displayPhoneNumber?: string | null;
  updatedAt?: string;
}> {
  const { graphFetch, graphErrorMessage } = await import("@/lib/whatsapp-api.server");

  const result = await graphFetch(input.phoneNumberId, input.accessToken, {
    query: { fields: "quality_rating,messaging_limit_tier,name_status,display_phone_number" },
  });
  if (!result.ok) return { ok: false, error: graphErrorMessage(result.body) };

  console.info("[refresh-quality]", JSON.stringify(result.body));

  const qualityRating = (result.body["quality_rating"] as string) ?? "UNKNOWN";
  const nameStatus = (result.body["name_status"] as string | null) ?? null;
  const displayPhoneNumber = (result.body["display_phone_number"] as string | null) ?? null;
  const messagingTier =
    (result.body["messaging_limit_tier"] as string | undefined) ?? "NOT_AVAILABLE";
  const nowIso = new Date().toISOString();

  const { error: updateErr } = await supabase
    .from("whatsapp_accounts")
    .update({
      quality_rating: qualityRating,
      quality_updated_at: nowIso,
      messaging_tier: messagingTier,
      messaging_tier_updated_at: nowIso,
    })
    .eq("id", input.whatsappAccountId);
  if (updateErr) return { ok: false, error: "We couldn't save the latest quality rating." };

  return {
    ok: true,
    qualityRating,
    messagingTier,
    nameStatus,
    displayPhoneNumber,
    updatedAt: nowIso,
  };
}
