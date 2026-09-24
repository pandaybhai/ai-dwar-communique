import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "@/lib/phone";

/**
 * Send-health alerts. The database trigger (track_send_health) flips
 * whatsapp_accounts.health to 'needs_attention' after 3 auth/permission
 * failures in 10 minutes and back to 'ok' after 3 successful sends. This
 * drain sends the alert exactly once per incident: it claims the row by
 * setting health_notified_at before notifying anyone.
 */
export async function drainHealthNotifications(supabase: SupabaseClient): Promise<number> {
  const { data: rows } = await supabase
    .from("whatsapp_accounts")
    .select("id, organization_id, display_phone_number, verified_name, last_health_error")
    .eq("health", "needs_attention")
    .is("health_notified_at", null)
    .limit(20);

  const { data: setting } = await supabase
    .from("platform_settings")
    .select("onboarding_whatsapp_account_id")
    .maybeSingle();
  const onboardingAccountId =
    (setting as { onboarding_whatsapp_account_id?: string | null } | null)
      ?.onboarding_whatsapp_account_id ?? null;

  const { sendEmail } = await import("@/lib/email.server");
  const { logServerActivity } = await import("@/lib/whatsapp-api.server");
  let notified = 0;

  for (const row of (rows ?? []) as Array<{
    id: string;
    organization_id: string;
    display_phone_number: string | null;
    verified_name: string | null;
    last_health_error: string | null;
  }>) {
    // Claim first: a concurrent drain cannot notify the same incident twice.
    const { data: claimed } = await supabase
      .from("whatsapp_accounts")
      .update({ health_notified_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("health", "needs_attention")
      .is("health_notified_at", null)
      .select("id");
    if (!claimed || claimed.length === 0) continue;

    const label = row.display_phone_number || row.verified_name || "your number";
    const text =
      `Messages from ${label} are failing because Meta is refusing the connection's access. ` +
      `Customers aren't receiving replies or campaigns from this number right now. ` +
      `Open Settings → WhatsApp in AiDwar and reconnect the number to fix it.`;

    const isOnboarding = row.id === onboardingAccountId;
    const recipients: Array<{ email: string | null; phone: string | null }> = [];

    if (isOnboarding) {
      const { data: admins } = await supabase
        .from("profiles")
        .select("email")
        .eq("is_super_admin", true);
      for (const a of (admins ?? []) as Array<{ email: string | null }>) {
        recipients.push({ email: a.email, phone: null });
      }
    } else {
      const { data: owners } = await supabase
        .from("organization_members")
        .select("user_id")
        .eq("organization_id", row.organization_id)
        .eq("role", "owner");
      const ids = ((owners ?? []) as Array<{ user_id: string }>).map((o) => o.user_id);
      if (ids.length) {
        const { data: profiles } = await supabase
          .from("profiles")
          .select("email, phone")
          .in("id", ids);
        for (const p of (profiles ?? []) as Array<{ email: string | null; phone: string | null }>) {
          recipients.push({ email: p.email, phone: p.phone });
        }
      }
    }

    for (const r of recipients) {
      if (r.email) {
        await sendEmail({ to: r.email, subject: `Action needed: ${label} can't send messages`, body: text });
      }
      if (r.phone && onboardingAccountId) {
        await notifyOverOnboardingNumber(supabase, onboardingAccountId, r.phone, text);
      }
    }

    await logServerActivity(supabase, row.organization_id, null, "whatsapp_health_needs_attention", {
      whatsapp_account_id: row.id,
      onboarding_number: isOnboarding,
      recipients: recipients.length,
    });
    notified += 1;
  }
  return notified;
}

/** Best effort: the owner's chat with the AiDwar onboarding number. */
async function notifyOverOnboardingNumber(
  supabase: SupabaseClient,
  onboardingAccountId: string,
  phone: string,
  text: string,
): Promise<void> {
  try {
    const { data: account } = await supabase
      .from("whatsapp_accounts")
      .select("id, organization_id, phone_number_id")
      .eq("id", onboardingAccountId)
      .maybeSingle();
    const acc = account as { id: string; organization_id: string; phone_number_id: string } | null;
    if (!acc) return;

    const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
    const { connection } = await getWhatsAppConnection(supabase, acc.organization_id, acc.id);
    if (!connection?.accessToken) return;

    const { data: contact } = await supabase
      .from("contacts")
      .select("id")
      .eq("organization_id", acc.organization_id)
      .eq("phone", normalizePhone(phone))
      .maybeSingle();
    if (!contact) return;

    const { data: conversation } = await supabase
      .from("conversations")
      .select("id")
      .eq("organization_id", acc.organization_id)
      .eq("contact_id", (contact as { id: string }).id)
      .eq("whatsapp_account_id", acc.id)
      .order("last_message_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!conversation) return;

    const { sendServiceText } = await import("@/lib/service-text.server");
    await sendServiceText(supabase, {
      organizationId: acc.organization_id,
      phoneNumberId: acc.phone_number_id,
      accessToken: connection.accessToken,
      conversationId: (conversation as { id: string }).id,
      to: normalizePhone(phone).replace(/\D/g, ""),
      body: text,
    });
  } catch {
    // an alert must never break the drain
  }
}
