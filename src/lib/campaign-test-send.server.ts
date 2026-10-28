/**
 * Batch 35: "Send a test" from the campaign wizard, before launch.
 *
 * The campaign's exact template, variables (resolved for each test number as
 * the campaign would resolve them for that contact), header file, cards,
 * coupon and offer end go to 1–5 numbers the merchant typed — through the one
 * sender every template uses (sendCampaignTemplate), so the inbox shows each
 * test as a normal outbound message and the existing messages billing trigger
 * charges it at the template category's price, like any send.
 *
 * A test never touches the campaign: there is no campaign row yet (the wizard
 * only creates one at launch), messages.campaign_id stays null (so no hold,
 * no campaign charge, no revenue credit, no campaign-button flow trigger, no
 * counter), no campaign_recipients row is made and no callback data is sent.
 * The link to the draft is metadata.test_campaign_ref; metadata.test = true
 * labels it "Test" in the inbox.
 *
 * Every refusal (permission, plan, numbers, template, opt-out, the 20-a-campaign
 * limit, credits) happens before Meta is called.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthContext } from "@/lib/whatsapp-api.server";
import {
  MAX_TESTS_PER_CAMPAIGN,
  parseTestNumbers,
  resolveAllVariables,
  sanitizeSendSettings,
  sendContextFromSettings,
  type SampleContact,
  type VariableMappings,
} from "@/lib/campaigns";
import type { TemplatePriceQuote } from "@/lib/message-price.server";

export type TestSendInput = {
  action: "quote" | "send";
  /** A uuid the wizard makes when it opens: the campaign-to-be the 20-test limit counts against. */
  testRef: string;
  numbers: string;
  templateName: string;
  whatsappAccountId: string | null;
  mappings: VariableMappings;
  sendSettings: unknown;
};

export type TestSendAnswer =
  | {
      ok: true;
      quote: TemplatePriceQuote;
      /** Test sends this campaign has used, and how many are left. */
      used: number;
      remaining: number;
      results?: Array<{ phone: string; sent: boolean; error: string | null }>;
    }
  | { ok: false; status: number; error: string; quote?: TemplatePriceQuote };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A wizard lives minutes, not weeks: the count only looks this far back. */
const TEST_REF_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function parseTestSendBody(payload: Record<string, unknown>): TestSendInput {
  return {
    action: payload["action"] === "send" ? "send" : "quote",
    testRef: String(payload["test_ref"] ?? "").trim(),
    numbers: String(payload["numbers"] ?? ""),
    templateName: String(payload["template_name"] ?? "").trim(),
    whatsappAccountId: (payload["whatsapp_account_id"] as string | null) || null,
    mappings: (payload["variable_mappings"] ?? {}) as VariableMappings,
    sendSettings: payload["send_settings"] ?? {},
  };
}

/** How many test sends this campaign-to-be already used (sent or failed). */
export async function testSendsUsed(
  supabase: SupabaseClient,
  organizationId: string,
  testRef: string,
): Promise<{ used: number; error: string | null }> {
  const { count, error } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("metadata->>test_campaign_ref", testRef)
    .gte("created_at", new Date(Date.now() - TEST_REF_WINDOW_MS).toISOString());
  return { used: count ?? 0, error: error ? error.message : null };
}

export async function campaignTestSend(
  auth: AuthContext,
  input: TestSendInput,
): Promise<TestSendAnswer> {
  const { supabase, organizationId, userId } = auth;

  const { requirePermission } = await import("@/lib/whatsapp-api.server");
  // Whoever can build a campaign can test it.
  const denied = await requirePermission(auth, "campaigns.create", "send a campaign test");
  if (denied) {
    const body = (await denied.json().catch(() => ({}))) as { error?: string };
    return {
      ok: false,
      status: 403,
      error: body.error ?? "You don't have permission to send a campaign test.",
    };
  }

  // A locked or paused workspace spends nothing until a plan is chosen (as launch).
  const { data: orgRow } = await supabase
    .from("organizations")
    .select("plan_status")
    .eq("id", organizationId)
    .maybeSingle();
  const planStatus = (orgRow as { plan_status?: string | null } | null)?.plan_status ?? null;
  if (planStatus === "locked" || planStatus === "paused") {
    return {
      ok: false,
      status: 402,
      error: "This workspace is locked — choose a plan to continue.",
    };
  }

  if (!UUID.test(input.testRef)) return { ok: false, status: 400, error: "Invalid request." };
  if (!input.templateName)
    return { ok: false, status: 400, error: "Pick an approved template first." };
  const parsed = parseTestNumbers(input.numbers);
  if (parsed.error) return { ok: false, status: 400, error: parsed.error };
  const numbers = parsed.numbers;

  const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
  const { connection, error: connectionError } = await getWhatsAppConnection(
    supabase,
    organizationId,
    input.whatsappAccountId,
  );
  if (!connection) {
    return {
      ok: false,
      status: 400,
      error: connectionError ?? "Connect a number before sending a test.",
    };
  }

  const { data: templateRow } = await supabase
    .from("message_templates")
    .select("name, language, components, category, status")
    .eq("organization_id", organizationId)
    .eq("waba_id", connection.wabaId)
    .eq("name", input.templateName)
    .eq("status", "APPROVED")
    .limit(1)
    .maybeSingle();
  const template = templateRow as {
    name: string;
    language: string | null;
    components: import("@/lib/templates").TemplateComponent[] | null;
    category: string | null;
  } | null;
  if (!template) {
    return {
      ok: false,
      status: 400,
      error:
        "That template isn't approved on the number you picked. Choose another template or another number.",
    };
  }

  const usage = await testSendsUsed(supabase, organizationId, input.testRef);
  if (usage.error)
    return {
      ok: false,
      status: 503,
      error: "We couldn't check how many tests you've sent. Try again.",
    };
  const remaining = Math.max(0, MAX_TESTS_PER_CAMPAIGN - usage.used);

  const { billingCategoryOf, quoteTemplateMessages } = await import("@/lib/message-price.server");
  const category = billingCategoryOf(template.category);
  const quote = await quoteTemplateMessages(supabase, organizationId, category, numbers);

  if (input.action === "quote") return { ok: true, quote, used: usage.used, remaining };

  if (numbers.length > remaining) {
    return {
      ok: false,
      status: 429,
      quote,
      error:
        remaining === 0
          ? `You've sent ${MAX_TESTS_PER_CAMPAIGN} tests for this campaign — that's the limit.`
          : `You have ${remaining} test send${remaining === 1 ? "" : "s"} left for this campaign. Remove some numbers.`,
    };
  }

  // Opted-out numbers never get a test: refused by name, nothing is sent.
  const { contactOptedOut } = await import("@/lib/opt-out.server");
  const optedOut: string[] = [];
  for (const phone of numbers) {
    const check = await contactOptedOut(supabase, organizationId, { phone });
    if (check.error)
      return {
        ok: false,
        status: 503,
        error: "We couldn't confirm these numbers' opt-in. Try again.",
      };
    if (check.optedOut) optedOut.push(phone);
  }
  if (optedOut.length) {
    return {
      ok: false,
      status: 422,
      quote,
      error: `${optedOut.join(", ")} opted out of your messages, so we won't send a test there. Remove ${optedOut.length === 1 ? "it" : "them"} and try again.`,
    };
  }

  if (quote.enabled && !quote.covers) {
    return {
      ok: false,
      status: 402,
      quote,
      error: `This test costs about ${quote.total.toFixed(2)} and you have ${quote.available.toFixed(2)} in credits. Add credits and try again.`,
    };
  }

  const { extractVariables, templateBodyText } = await import("@/lib/templates");
  const { sendCampaignTemplate } = await import("@/lib/campaigns.server");
  const variableOrder = extractVariables(templateBodyText(template.components));
  const fromSettings = sendContextFromSettings(sanitizeSendSettings(input.sendSettings));
  const sender = {
    accountId: connection.accountId,
    wabaId: connection.wabaId,
    phoneNumberId: connection.phoneNumberId,
    accessToken: connection.accessToken,
  };

  const results: Array<{ phone: string; sent: boolean; error: string | null }> = [];
  for (const phone of numbers) {
    // The variables this number would get in the campaign: its own contact
    // row when it has one, else the same fallbacks a contact without details gets.
    const { data: contactRow } = await supabase
      .from("contacts")
      .select("id, name, phone, attributes")
      .eq("organization_id", organizationId)
      .eq("phone", phone)
      .maybeSingle();
    const contact = contactRow as {
      id: string;
      name: string | null;
      phone: string;
      attributes: Record<string, unknown> | null;
    } | null;
    const sample: SampleContact = {
      name: contact?.name ?? null,
      phone,
      attributes: contact?.attributes ?? {},
    };
    const outcome = await sendCampaignTemplate(
      supabase,
      organizationId,
      sender,
      {
        contactId: contact?.id ?? null,
        phone,
        variables: resolveAllVariables(variableOrder, input.mappings, sample),
      },
      {
        name: template.name,
        language: template.language ?? "en_US",
        variableOrder,
        components: template.components,
      },
      {
        campaignId: null,
        category,
        ...fromSettings,
        messageMetadata: {
          test: true,
          test_campaign_ref: input.testRef,
          source: "campaign_test",
          test_sent_by: userId,
        },
      },
    );
    results.push({ phone, sent: !outcome.error, error: outcome.error });
  }

  const { logServerActivity } = await import("@/lib/whatsapp-api.server");
  await logServerActivity(supabase, organizationId, userId, "campaign_test_sent", {
    template_name: template.name,
    test_ref: input.testRef,
    numbers: numbers.length,
    sent: results.filter((r) => r.sent).length,
    whatsapp_account_id: connection.accountId,
  });

  const used = usage.used + numbers.length;
  return { ok: true, quote, used, remaining: Math.max(0, MAX_TESTS_PER_CAMPAIGN - used), results };
}
