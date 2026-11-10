/**
 * AiDwar's own notice templates — the ones the platform workspace sends to
 * merchants and to our staff: billing notices (admin_*, client_*), the staff
 * hand-off alert (staff_handoff_alert) and the onboarding nudges
 * (aidwar_onboarding_*). Moved here unchanged in Batch 58 from
 * billing-notify.server.ts, handoff-alerts.server.ts and
 * onboarding-nudges.server.ts (which re-export them), so client code can use
 * the same list: they are never offered for a marketing campaign (the
 * campaign wizard's template picker, MCP list_templates and
 * create_campaign_draft leave them out).
 */

export const CODE_TEMPLATE_NAME = "aidwar_onboarding_start";
export const RESUME_TEMPLATE_NAME = "aidwar_onboarding_resume";
export const RESUME_LINK_TEMPLATE_NAME = "aidwar_onboarding_resume_link";

/**
 * Batch 21: the staff alert as an approved UTILITY template, for a staff
 * number outside WhatsApp's 24-hour window with the platform number (free
 * text only arrives inside it). Same shape as the platform's notice
 * templates (billing-notify BILLING_TEMPLATES): Meta rejects a body that
 * starts or ends with a variable, so it is wrapped in words. Never customer
 * reply text: it goes to staff.
 */
export const STAFF_HANDOFF_TEMPLATE = {
  name: "staff_handoff_alert",
  body: "AiDwar alert for {{1}}: {{2}} is waiting for a person in the Inbox because {{3}}. Open the Inbox here: {{4}} — Aiden has stepped back on this chat until your team replies.",
  examples: [
    "Sharma Textiles",
    "Asha (+91 98765 43210)",
    "a customer asked to talk to a person",
    "https://aidwar.in/app/inbox",
  ],
};

export type BillingTemplateSpec = {
  name: string;
  body: string;
  examples: string[];
  /** Only the invoice notice carries a PDF header. */
  headerFormat?: "DOCUMENT";
};

/**
 * The notices, all UTILITY, all with the same three variables so one
 * parameter builder covers every kind: who/what, an amount, and a link or
 * balance.
 */
export const BILLING_TEMPLATES: BillingTemplateSpec[] = [
  // Meta rejects a message that begins or ends with a variable, so every body
  // is wrapped in words.
  {
    name: "admin_credit_purchased",
    body: "Workspace {{1}} just bought {{2}} of credits. Their balance is now {{3}} — no action needed.",
    examples: ["Sharma Textiles", "₹5,000", "₹6,200"],
  },
  {
    name: "client_credit_purchased",
    body: "We've added {{2}} of credits to {{1}}. Your balance is now {{3}} — thank you.",
    examples: ["Sharma Textiles", "₹5,000", "₹6,200"],
  },
  {
    name: "client_topup_requested",
    body: "Hello {{1}} — a teammate has asked for more credits ({{2}}). You can add them here: {{3}} — thank you.",
    examples: ["Sharma Textiles", "₹2,000", "https://aidwar.in/app/billing"],
  },
  {
    name: "client_low_credits",
    body: "Workspace {{1}} is running low on credits — {{2}} left. Top up here: {{3}} — thank you.",
    examples: ["Sharma Textiles", "₹350", "https://aidwar.in/app/billing"],
  },
  {
    name: "admin_float_low",
    body: "The Meta float for {{1}} is down to {{2}}. The target is {{3}} — please top it up.",
    examples: ["Sharma Textiles", "₹800", "₹5,000"],
  },
  {
    name: "client_campaign_approval",
    body: "A campaign on {{1}} is waiting for your approval. It will cost about {{2}}. Review it here: {{3}} — thank you.",
    examples: ["Sharma Textiles", "₹4,500", "https://aidwar.in/app/campaigns"],
  },
  {
    name: "admin_topup_due",
    body: "Workspace {{1}} needs a Meta float top-up of {{2}}. Credits sold: {{3}} — please top it up.",
    examples: ["Sharma Textiles", "₹4,200", "₹5,000"],
  },
  {
    name: "admin_settle_failed",
    body: "A payment for {{1}} of {{2}} could not be credited automatically. Please check it here: {{3}} — thank you.",
    examples: ["Sharma Textiles", "₹2,000", "https://aidwar.in/admin/billing"],
  },
  {
    name: "client_invoice_issued",
    body: "Hello {{1}} — your invoice for {{2}} is ready. You can view and download it here: {{3}} — thank you.",
    examples: ["Sharma Textiles", "₹2,950", "https://aidwar.in/app/billing"],
    headerFormat: "DOCUMENT",
  },
  {
    name: "client_invoice_overdue",
    body: "Hello {{1}} — an invoice for {{2}} is still unpaid. Please settle it here to keep everything running: {{3}} — thank you.",
    examples: ["Sharma Textiles", "₹2,950", "https://aidwar.in/app/billing"],
  },
  {
    name: "client_payment_failed",
    body: "Hello {{1}} — your auto-pay of {{2}} didn't go through. You can pay it here: {{3}} — thank you.",
    examples: ["Sharma Textiles", "₹2,950", "https://aidwar.in/app/billing"],
  },
  {
    name: "client_trial_ending",
    body: "Your AiDwar trial for {{1}} ends in {{2}} days. Choose a plan at {{3}} to keep Aiden working — nothing is deleted.",
    examples: ["Sharma Textiles", "3", "aidwar.in/app/billing"],
  },
  {
    // AI provider trouble (credit/quota/outage, or the backup answering).
    // Raised at most once an hour by ai-fallback.server.ts.
    name: "admin_ai_provider_alert",
    body: "AiDwar AI alert: {{1}}. Right now {{2}}. Details are here: {{3}} — please check.",
    examples: [
      "Lovable AI gateway is out of credit or quota",
      "Aiden is answering on the anthropic backup",
      "https://aidwar.in/admin/ai",
    ],
  },
  // Batch 21: staff hand-off alert outside the 24-hour window (sent by handoff-alerts.server.ts).
  STAFF_HANDOFF_TEMPLATE,
  {
    // Batch 67: the daily failure summary's WhatsApp copy to the workspace
    // owner (send-failure-digest.server.ts), only once Meta has APPROVED it.
    // {{3}} is always https://aidwar.in/app/templates (no token in it). "Thank
    // you." follows it because Meta (and validateDraft) refuse a body that ends
    // with a variable.
    name: "client_send_failures",
    body: "Hello {{1}}, {{2}} WhatsApp messages from your account couldn't be sent or delivered yesterday. See them here: {{3}} Thank you.",
    examples: ["Sharma Textiles", "3", "https://aidwar.in/app/templates"],
  },
];

/** Every AiDwar notice template name, exactly (never a prefix match). */
export const PLATFORM_NOTICE_TEMPLATE_NAMES: ReadonlySet<string> = new Set([
  ...BILLING_TEMPLATES.map((t) => t.name),
  CODE_TEMPLATE_NAME,
  RESUME_TEMPLATE_NAME,
  RESUME_LINK_TEMPLATE_NAME,
]);

export function isPlatformNoticeTemplate(name: unknown): boolean {
  return typeof name === "string" && PLATFORM_NOTICE_TEMPLATE_NAMES.has(name);
}

/** The templates a campaign may use: AiDwar's own notices left out. */
export function withoutPlatformNoticeTemplates<T extends { name?: unknown }>(templates: T[]): T[] {
  return templates.filter((t) => !isPlatformNoticeTemplate(t.name));
}
