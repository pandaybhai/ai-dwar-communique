/**
 * Offer outcomes.
 *
 * A campaign with a coupon has three numbers worth knowing: how many
 * customers received it, how many acted on the coupon, and how many actually
 * spent it. Meta doesn't tell us about a copy-code tap, so a tap is recorded
 * when the customer comes back with the code — typed, pasted, or as a button
 * reply on the campaign message. A redemption is recorded when a Shopify
 * order carries the same discount code.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type AnyRecord = Record<string, unknown>;

/** How long after a send an offer campaign can still claim credit. */
const ATTRIBUTION_DAYS = 30;

type Sent = {
  campaign_id: string;
  campaigns: { send_settings: AnyRecord | null } | null;
};

/** Offer campaigns this contact received recently, newest first. */
async function recentOfferCampaigns(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
): Promise<Array<{ campaignId: string; coupon: string }>> {
  const since = new Date(Date.now() - ATTRIBUTION_DAYS * 86400000).toISOString();
  const { data } = await supabase
    .from("campaign_recipients")
    .select("campaign_id, campaigns(send_settings)")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .in("status", ["sent", "delivered", "read", "replied"])
    .gte("updated_at", since)
    .order("updated_at", { ascending: false })
    .limit(20);

  const out: Array<{ campaignId: string; coupon: string }> = [];
  for (const row of (data ?? []) as unknown as Sent[]) {
    const coupon = String(row.campaigns?.send_settings?.["coupon_code"] ?? "").trim();
    if (coupon) out.push({ campaignId: row.campaign_id, coupon });
  }
  return out;
}

async function record(
  supabase: SupabaseClient,
  row: {
    organizationId: string;
    campaignId: string;
    contactId: string;
    event: "tapped" | "redeemed";
    coupon: string;
    detail?: AnyRecord;
  },
): Promise<void> {
  await supabase
    .from("campaign_offer_events")
    .upsert(
      {
        organization_id: row.organizationId,
        campaign_id: row.campaignId,
        contact_id: row.contactId,
        event: row.event,
        coupon_code: row.coupon,
        detail: row.detail ?? {},
      },
      { onConflict: "campaign_id,contact_id,event", ignoreDuplicates: true },
    );
}

const normalise = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * An inbound message that carries a live coupon code counts as a tap.
 * Never throws — analytics must not be able to break message handling.
 */
export async function recordOfferTap(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    contactId: string;
    body: string | null;
    payload?: string | null;
  },
): Promise<void> {
  const text = normalise(`${args.body ?? ""} ${args.payload ?? ""}`);
  if (!text) return;
  try {
    const campaigns = await recentOfferCampaigns(
      supabase,
      args.organizationId,
      args.contactId,
    );
    for (const c of campaigns) {
      const code = normalise(c.coupon);
      if (!code || !text.includes(code)) continue;
      await record(supabase, {
        organizationId: args.organizationId,
        campaignId: c.campaignId,
        contactId: args.contactId,
        event: "tapped",
        coupon: c.coupon,
        detail: { via: "inbound_message" },
      });
      return;
    }
  } catch {
    // Analytics is best-effort; the conversation always comes first.
  }
}

/** Discount codes on a Shopify order payload. */
function orderDiscountCodes(order: AnyRecord): string[] {
  const list = Array.isArray(order["discount_codes"])
    ? (order["discount_codes"] as AnyRecord[])
    : [];
  const codes = list
    .map((d) => String(d["code"] ?? "").trim())
    .filter((c) => c.length > 0);
  const single = String(order["discount_code"] ?? "").trim();
  if (single) codes.push(single);
  return codes;
}

/**
 * An order that used the campaign's coupon counts as a redemption — and as a
 * tap too, because you can't spend a code you never took.
 */
export async function recordOfferRedemption(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    contactId: string | null;
    orderId: string | null;
    order: AnyRecord;
  },
): Promise<void> {
  if (!args.contactId) return;
  const codes = orderDiscountCodes(args.order).map(normalise);
  if (codes.length === 0) return;
  try {
    const campaigns = await recentOfferCampaigns(
      supabase,
      args.organizationId,
      args.contactId,
    );
    for (const c of campaigns) {
      const code = normalise(c.coupon);
      if (!code || !codes.includes(code)) continue;
      for (const event of ["tapped", "redeemed"] as const) {
        await record(supabase, {
          organizationId: args.organizationId,
          campaignId: c.campaignId,
          contactId: args.contactId,
          event,
          coupon: c.coupon,
          detail: { via: "order", order_id: args.orderId },
        });
      }
      return;
    }
  } catch {
    // Best effort — an order must still save even if attribution fails.
  }
}

/** Received / tapped / redeemed for one campaign. */
export async function offerStats(
  supabase: SupabaseClient,
  campaignId: string,
): Promise<{ received: number; tapped: number; redeemed: number }> {
  const [received, tapped, redeemed] = await Promise.all([
    supabase
      .from("campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .in("status", ["sent", "delivered", "read", "replied"]),
    supabase
      .from("campaign_offer_events")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .eq("event", "tapped"),
    supabase
      .from("campaign_offer_events")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .eq("event", "redeemed"),
  ]);
  return {
    received: received.count ?? 0,
    tapped: tapped.count ?? 0,
    redeemed: redeemed.count ?? 0,
  };
}
