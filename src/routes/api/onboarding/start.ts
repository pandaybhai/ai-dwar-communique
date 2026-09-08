import { createFileRoute } from "@tanstack/react-router";

/**
 * Hands the owner a code and a link that opens a chat with Aiden on the
 * platform's onboarding number. One session per workspace: asking again
 * returns the same code, so a refreshed page can't strand a code.
 */

/** No 0/O/1/I — this gets read off a screen and typed on a phone. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `AD-${out}`;
}

export const Route = createFileRoute("/api/onboarding/start")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireOrgMember, isResponse, jsonError } = await import(
          "@/lib/whatsapp-api.server"
        );
        const { normalizePhone, toWaId } = await import("@/lib/phone");

        let payload: Record<string, unknown> = {};
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          payload = {};
        }

        const auth = await requireOrgMember(request, (payload["organization_id"] as string) ?? null);
        if (isResponse(auth)) return auth;

        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const supabaseAdmin = getServiceClient();

        // The number the owner gave us at sign-up is where Aiden expects them
        // to write from.
        const { data: profile } = await supabaseAdmin
          .from("profiles")
          .select("phone")
          .eq("id", auth.userId)
          .maybeSingle();
        const bodyPhone = normalizePhone(String(payload["phone"] ?? ""));
        const phone = normalizePhone((profile as { phone?: string } | null)?.phone ?? "") || bodyPhone;
        if (!phone) {
          return jsonError("We don't have your WhatsApp number yet. Add it in Settings and try again.");
        }
        if (bodyPhone && bodyPhone !== phone) {
          await supabaseAdmin.from("profiles").update({ phone: bodyPhone }).eq("id", auth.userId);
        }

        // The onboarding number lives in settings — never hardcoded here.
        const { data: settings } = await supabaseAdmin
          .from("platform_settings")
          .select("onboarding_whatsapp_account_id")
          .maybeSingle();
        const accountId =
          (settings as { onboarding_whatsapp_account_id?: string | null } | null)
            ?.onboarding_whatsapp_account_id ?? null;
        if (!accountId) {
          return jsonError("Aiden's number isn't set up yet. Please continue to your workspace.", 503);
        }
        const { data: account } = await supabaseAdmin
          .from("whatsapp_accounts")
          .select("display_phone_number")
          .eq("id", accountId)
          .maybeSingle();
        const aidenNumber = toWaId((account as { display_phone_number?: string } | null)?.display_phone_number);
        if (!aidenNumber) {
          return jsonError("Aiden's number isn't set up yet. Please continue to your workspace.", 503);
        }

        const { data: existing } = await supabaseAdmin
          .from("onboarding_sessions")
          .select("id, code, status")
          .eq("organization_id", auth.organizationId)
          .not("status", "in", '("completed","expired")')
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        // Where this signup came from. Intent only — it never assigns a plan.
        const ATTRIBUTION_KEYS = ["plan", "utm_source", "utm_medium", "utm_campaign", "ref"];
        const rawAttribution = payload["attribution"];
        const attribution: Record<string, string> = {};
        if (rawAttribution && typeof rawAttribution === "object") {
          for (const key of ATTRIBUTION_KEYS) {
            const value = (rawAttribution as Record<string, unknown>)[key];
            if (typeof value === "string" && value.trim()) {
              attribution[key] = value.trim().slice(0, 120);
            }
          }
        }
        const hasAttribution = Object.keys(attribution).length > 0;

        let code = (existing as unknown as { code?: string } | null)?.code ?? null;
        if (!code) {
          // A collision on the unique code is possible but rare; try a few.
          for (let attempt = 0; attempt < 5 && !code; attempt += 1) {
            const candidate = newCode();
            const { error } = await supabaseAdmin.from("onboarding_sessions").insert({
              organization_id: auth.organizationId,
              user_id: auth.userId,
              phone,
              code: candidate,
              status: "pending",
              attribution,
            });
            if (!error) code = candidate;
          }
        } else {
          await supabaseAdmin
            .from("onboarding_sessions")
            .update({
              phone,
              updated_at: new Date().toISOString(),
              ...(hasAttribution ? { attribution } : {}),
            })
            .eq("id", (existing as unknown as { id: string }).id);
        }

        if (!code) return jsonError("We couldn't start your setup. Please try again.");

        const text = encodeURIComponent(`Hi Aiden, my code is ${code}`);
        return Response.json({ code, wa_link: `https://wa.me/${aidenNumber}?text=${text}` });
      },
    },
  },
});
