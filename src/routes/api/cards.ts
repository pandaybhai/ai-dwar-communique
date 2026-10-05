import { createFileRoute } from "@tanstack/react-router";

/**
 * Cards API — brand paint and previews for customer picture cards.
 *
 * POST { action: "save_branding", organization_id, branding }
 * POST { action: "preview", organization_id, kind, vars? }
 * POST { action: "save_usage", organization_id, product_cards }
 * POST { action: "send", organization_id, conversation_id, kind, vars, caption? }
 *
 * "send" is the inbox's Send card: the same permission and 24-hour rule as a
 * typed reply. If the card can't be drawn, its words go as a plain message
 * (a Product card's photo with the words as caption) — never nothing.
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

          // The merchant's own values when given (live preview), else samples.
          const given = payload["vars"] && typeof payload["vars"] === "object" ? (payload["vars"] as Record<string, unknown>) : null;
          const samples: Record<string, string> = {};
          for (const v of meta.vars) {
            const own = given ? String(given[v] ?? "").trim().slice(0, 300) : "";
            samples[v] = given ? own : sampleValue(v);
          }
          if (samples["image_url"] && !/^https:\/\//i.test(samples["image_url"])) samples["image_url"] = "";
          const url = await renderCustomerCard(supabase, {
            organizationId,
            kind,
            vars: samples,
            meter: false,
          });
          if (!url) return jsonError("The card couldn't be drawn just now — try again in a moment.");
          return Response.json({ url });
        }

        if (action === "save_usage") {
          const denied = await requirePermission(auth, "cards.manage", "change where cards are used");
          if (denied) return denied;
          if (typeof payload["product_cards"] !== "boolean") return jsonError("Invalid request.");
          const { PRODUCT_CARDS_SETTING } = await import("@/lib/customer-cards");
          const { data: org } = await supabase
            .from("organizations")
            .select("branding")
            .eq("id", organizationId)
            .maybeSingle();
          const existing = ((org as { branding?: Record<string, unknown> | null } | null)?.branding ??
            {}) as Record<string, unknown>;
          const { error } = await supabase
            .from("organizations")
            .update({ branding: { ...existing, [PRODUCT_CARDS_SETTING]: payload["product_cards"] } })
            .eq("id", organizationId);
          if (error) return jsonError("We couldn't save that — please try again.");
          const { logServerActivity } = await import("@/lib/whatsapp-api.server");
          await logServerActivity(supabase, organizationId, auth.userId, "card_usage_updated", {
            product_cards: payload["product_cards"],
          });
          return Response.json({ ok: true });
        }

        if (action === "send") {
          // Same permission as typing a reply in the inbox.
          const denied = await requirePermission(auth, "inbox.reply", "reply to conversations");
          if (denied) return denied;
          return sendFromInbox(auth, payload);
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

type Auth = { supabase: import("@supabase/supabase-js").SupabaseClient; organizationId: string; userId: string };

/** The inbox's Send card: one card into one open conversation. */
async function sendFromInbox(auth: Auth, payload: Record<string, unknown>): Promise<Response> {
  const { jsonError, logServerActivity, toWaId } = await import("@/lib/whatsapp-api.server");
  const { isServiceWindowOpen, SERVICE_WINDOW_CLOSED_MESSAGE } = await import("@/lib/service-window");
  const { isCardKind, cleanCardVars, cardFallbackText, cardDesign } = await import("@/lib/customer-cards");
  const { supabase, organizationId, userId } = auth;

  const kind = payload["kind"];
  if (!isCardKind(kind)) return jsonError("Pick a card design.");
  const vars = cleanCardVars(kind, payload["vars"]);
  if (!Object.entries(vars).some(([k, v]) => k !== "image_url" && v)) return jsonError("Fill in at least one detail on the card.");
  if (vars["image_url"] && !/^https:\/\/\S+$/i.test(vars["image_url"])) {
    return jsonError("The picture needs a full link starting with https://");
  }
  const caption = String(payload["caption"] ?? "").trim().slice(0, 1024);

  // A locked or paused workspace spends nothing until a plan is chosen.
  const { data: orgRow } = await supabase.from("organizations").select("plan_status").eq("id", organizationId).maybeSingle();
  const planStatus = (orgRow as { plan_status?: string | null } | null)?.plan_status ?? null;
  if (planStatus === "locked" || planStatus === "paused") {
    return jsonError("This workspace is locked — choose a plan to continue.", 402);
  }

  const conversationId = String(payload["conversation_id"] ?? "");
  if (!conversationId) return jsonError("Pick a conversation.");
  const { data: conv } = await supabase
    .from("conversations")
    .select("id, contact_id, whatsapp_account_id, last_customer_message_at")
    .eq("id", conversationId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const conversation = conv as {
    id: string;
    contact_id: string | null;
    whatsapp_account_id: string | null;
    last_customer_message_at: string | null;
  } | null;
  if (!conversation) return jsonError("Conversation not found.", 404);
  if (!isServiceWindowOpen(conversation)) return jsonError(SERVICE_WINDOW_CLOSED_MESSAGE, 422);
  if (!conversation.contact_id) return jsonError("This conversation has no contact to send to.");

  const { data: contact } = await supabase
    .from("contacts")
    .select("phone, wa_id")
    .eq("id", conversation.contact_id)
    .maybeSingle();
  const c = contact as { phone?: string | null; wa_id?: string | null } | null;
  const to = toWaId(c?.wa_id || c?.phone || "");
  if (!to || to.length < 8) return jsonError("This contact has no valid WhatsApp number.");

  const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
  const { connection, error: connectionError } = await getWhatsAppConnection(
    supabase,
    organizationId,
    conversation.whatsapp_account_id,
  );
  if (!connection) return jsonError(connectionError ?? "No connected number.", 400);

  const { sendCardOrFallback } = await import("@/lib/customer-cards.server");
  // Words first, then the card's own details, so the fallback says everything the card would.
  const fallback = [caption, cardFallbackText(kind, vars)].filter(Boolean).join("\n\n");
  const res = await sendCardOrFallback(supabase, {
    organizationId,
    contactId: conversation.contact_id,
    conversationId: conversation.id,
    phone: to,
    sender: { phoneNumberId: connection.phoneNumberId, accessToken: connection.accessToken },
    kind,
    vars,
    caption,
    fallback,
    // The route already returned 403 when cards are off.
    cardsOn: true,
    windowOpen: true,
    metadata: { kind: "card", source: "inbox" },
    sentBy: userId,
  });

  if (!res.card && !res.fallback) {
    return jsonError(
      res.reason && res.reason.startsWith("Outside") ? res.reason : "The card couldn't be sent — please try again.",
      res.reason && res.reason.startsWith("Outside") ? 422 : 502,
    );
  }
  await logServerActivity(supabase, organizationId, userId, "card_sent_inbox", {
    kind,
    design: cardDesign(kind)?.title ?? kind,
    fallback: res.fallback,
  });
  return Response.json({ ok: true, sent: res.card ? "card" : "fallback", message_id: res.messageId ?? null });
}
