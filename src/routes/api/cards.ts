import { createFileRoute } from "@tanstack/react-router";

/**
 * Cards API — brand paint and previews for customer picture cards.
 *
 * POST { action: "save_branding", organization_id, branding }
 * POST { action: "preview", organization_id, kind }
 *
 * Branding lives on organizations.branding (white-label column). Preview
 * renders go through the same render-card backend and cache as live sends;
 * a preview is unmetered — merchants shouldn't pay to look at their own card.
 */

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export const Route = createFileRoute("/api/cards")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireOrgMember, isResponse, jsonError, requirePermission } = await import(
          "@/lib/whatsapp-api.server"
        );

        let payload: Record<string, unknown>;
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          return jsonError("Invalid request.");
        }

        const auth = await requireOrgMember(request, (payload["organization_id"] as string) ?? null);
        if (isResponse(auth)) return auth;
        const { supabase, organizationId } = auth;

        const { cardsEnabled } = await import("@/lib/customer-cards.server");
        if (!(await cardsEnabled(supabase, organizationId))) {
          return jsonError("Cards aren't switched on for this workspace.", 403);
        }

        const action = String(payload["action"] ?? "");

        if (action === "save_branding") {
          const denied = await requirePermission(auth, "cards.manage", "change card branding");
          if (denied) return denied;

          const input = (payload["branding"] ?? {}) as Record<string, unknown>;
          const clean: Record<string, string> = {};

          const logoUrl = String(input["brand_logo_url"] ?? "").trim();
          if (logoUrl && !/^https:\/\//i.test(logoUrl)) {
            return jsonError("The logo link must start with https:// — WhatsApp needs a secure public image.");
          }
          if (logoUrl.length > 500) return jsonError("That logo link is too long.");
          clean["brand_logo_url"] = logoUrl;

          const brandName = String(input["brand_name"] ?? "").trim().slice(0, 60);
          clean["brand_name"] = brandName;

          for (const key of ["brand_primary", "brand_accent"] as const) {
            const value = String(input[key] ?? "").trim();
            if (value && !HEX.test(value)) {
              return jsonError("Colours need to be hex codes like #10B981.");
            }
            clean[key] = value;
          }

          // Merge over whatever else branding already holds (white-label keys).
          const { data: org } = await supabase
            .from("organizations")
            .select("branding")
            .eq("id", organizationId)
            .maybeSingle();
          const existing = ((org as { branding?: Record<string, unknown> | null } | null)?.branding ??
            {}) as Record<string, unknown>;

          const { error } = await supabase
            .from("organizations")
            .update({ branding: { ...existing, ...clean } })
            .eq("id", organizationId);
          if (error) return jsonError("We couldn't save that — please try again.");
          return Response.json({ ok: true });
        }

        if (action === "preview") {
          const denied = await requirePermission(auth, "cards.view", "preview cards");
          if (denied) return denied;

          const kind = String(payload["kind"] ?? "");
          const { CUSTOMER_CARD_META, renderCustomerCard } = await import(
            "@/lib/customer-cards.server"
          );
          const meta = CUSTOMER_CARD_META[kind as keyof typeof CUSTOMER_CARD_META];
          if (!meta) return jsonError("Unknown card kind.", 404);

          const samples: Record<string, string> = {};
          for (const v of meta.vars) samples[v] = sampleValue(v);
          const url = await renderCustomerCard(supabase, {
            organizationId,
            kind,
            vars: samples,
            meter: false,
          });
          if (!url) return jsonError("The card couldn't be drawn just now — try again in a moment.");
          return Response.json({ url });
        }

        return jsonError("Unknown action.");
      },
    },
  },
});

function sampleValue(key: string): string {
  const samples: Record<string, string> = {
    headline: "This weekend only",
    offer: "20% off everything",
    validity: "Till Sunday",
    code: "FEST20",
    name: "Cold Brew Concentrate",
    price: "₹499",
    image_url: "",
    one_liner: "Makes 8 glasses of smooth cold brew",
    order_no: "1042",
    status: "Out for delivery",
    eta: "Arriving today by 7 pm",
    item_1: "Cold Brew Concentrate — ₹499",
    item_2: "Tote Bag — ₹199",
    item_3: "",
    item_4: "",
    total: "₹698",
    date: "Saturday, 12 July",
    time: "4:00 pm",
    place: "Bandra studio",
  };
  return samples[key] ?? "";
}
