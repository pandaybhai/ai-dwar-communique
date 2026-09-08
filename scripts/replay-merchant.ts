/**
 * Replay a sequence of owner messages through the merchant pipeline exactly as
 * the webhook would. Verification only — not imported by the app.
 */
import { createClient } from "@supabase/supabase-js";
import { handleMerchantInbound } from "@/lib/merchant-channel.server";
import { getWhatsAppConnection } from "@/lib/whatsapp-numbers.server";

const WA_ID = "917981223192";

const supabase = createClient(
  process.env["AIDWAR_SUPABASE_URL"]!,
  process.env["AIDWAR_SUPABASE_SERVICE_ROLE_KEY"]!,
  { auth: { persistSession: false } },
);

const { data: setting } = await supabase
  .from("platform_settings")
  .select("onboarding_whatsapp_account_id")
  .maybeSingle();
const accountId = (setting as { onboarding_whatsapp_account_id: string }).onboarding_whatsapp_account_id;

const { data: account } = await supabase
  .from("whatsapp_accounts")
  .select("id, organization_id, phone_number_id")
  .eq("id", accountId)
  .maybeSingle();
const acct = account as { id: string; organization_id: string; phone_number_id: string };

const { connection } = await getWhatsAppConnection(supabase, acct.organization_id, acct.id);

const { data: contact } = await supabase
  .from("contacts")
  .select("id")
  .eq("organization_id", acct.organization_id)
  .eq("phone", `+${WA_ID}`)
  .maybeSingle();
const { data: conversation } = await supabase
  .from("conversations")
  .select("id")
  .eq("organization_id", acct.organization_id)
  .eq("contact_id", (contact as { id: string }).id)
  .eq("whatsapp_account_id", acct.id)
  .order("last_message_at", { ascending: false })
  .limit(1)
  .maybeSingle();

const steps: Array<{ body: string; interactiveId?: string | null }> = JSON.parse(
  process.argv[2] ?? "[]",
);

for (const step of steps) {
  console.log("\n=== IN:", JSON.stringify(step));
  const before = new Date().toISOString();
  await handleMerchantInbound(supabase, {
    organizationId: acct.organization_id,
    accountId: acct.id,
    phoneNumberId: acct.phone_number_id,
    accessToken: connection!.accessToken!,
    waId: WA_ID,
    conversationId: (conversation as { id: string }).id,
    contactId: (contact as { id: string }).id,
    body: step.body,
    interactiveId: step.interactiveId ?? null,
  });
  const { data: out } = await supabase
    .from("messages")
    .select("body, created_at")
    .eq("conversation_id", (conversation as { id: string }).id)
    .eq("direction", "outbound")
    .gte("created_at", before)
    .order("created_at", { ascending: true });
  for (const m of (out ?? []) as Array<{ body: string }>) console.log("OUT:", m.body?.slice(0, 300));
}
