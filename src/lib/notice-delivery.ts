import {
  BILLING_TEMPLATES,
  CODE_TEMPLATE_NAME,
  FINISH_SIGNUP_TEMPLATE_NAME,
  RESUME_LINK_TEMPLATE_NAME,
  RESUME_TEMPLATE_NAME,
} from "@/lib/platform-notice-templates";

/**
 * Batch 81: AiDwar's own messages to a customer about billing or onboarding
 * (invoice, receipt, welcome/setup, sign-up reminder), sent from the platform
 * number. Each send carries a tag on its messages row (metadata.customer_notice)
 * so a later "failed" status can find whose it was; rows sent before the tag
 * existed are known by their template name.
 *
 * Live case: invoice AD/2026-27/00031 went out with client_invoice_issued, Meta
 * answered 131026 "Message undeliverable" at 05:03, and the invoice still read
 * whatsapp_at with no error — it looked delivered.
 */

export type NoticeKind = "invoice" | "receipt" | "welcome" | "signup" | "billing";

export type CustomerNoticeTag = {
  kind: NoticeKind;
  /** The customer's workspace (null for a lead that has none yet). */
  organization_id: string | null;
  invoice_id?: string | null;
  invoice_number?: string | null;
  notification_id?: string | null;
  session_id?: string | null;
  lead_id?: string | null;
};

const CLIENT_KIND: Record<string, NoticeKind> = {
  client_invoice_issued: "invoice",
  client_invoice_overdue: "invoice",
  client_credit_purchased: "receipt",
};

/** Every platform template that goes to a customer (never to our staff), and what it is. */
export const CUSTOMER_NOTICE_TEMPLATES: ReadonlyMap<string, NoticeKind> = new Map<
  string,
  NoticeKind
>([
  ...BILLING_TEMPLATES.filter((t) => t.name.startsWith("client_")).map(
    (t) => [t.name, CLIENT_KIND[t.name] ?? "billing"] as [string, NoticeKind],
  ),
  [CODE_TEMPLATE_NAME, "welcome"],
  [RESUME_TEMPLATE_NAME, "welcome"],
  [RESUME_LINK_TEMPLATE_NAME, "welcome"],
  [FINISH_SIGNUP_TEMPLATE_NAME, "signup"],
]);

/** A billing notice kind (billing_notifications.kind) → what it is to the customer. */
export function noticeKindForBillingKind(kind: string): NoticeKind {
  if (kind === "invoice_issued" || kind === "invoice_overdue") return "invoice";
  if (kind === "credit_purchased") return "receipt";
  return "billing";
}

/** The metadata a customer notice's messages row carries. */
export function noticeTag(tag: CustomerNoticeTag): { customer_notice: CustomerNoticeTag } {
  return { customer_notice: tag };
}

export function readNoticeTag(metadata: unknown): CustomerNoticeTag | null {
  const t = (metadata as Record<string, unknown> | null | undefined)?.["customer_notice"];
  if (!t || typeof t !== "object") return null;
  const kind = (t as Record<string, unknown>)["kind"];
  return typeof kind === "string" &&
    ["invoice", "receipt", "welcome", "signup", "billing"].includes(kind)
    ? (t as CustomerNoticeTag)
    : null;
}

/** What this messages row is to the customer, or null when it isn't a customer notice. */
export function customerNoticeKind(row: {
  metadata?: unknown;
  template_name?: string | null;
}): NoticeKind | null {
  return (
    readNoticeTag(row.metadata)?.kind ??
    (row.template_name ? (CUSTOMER_NOTICE_TEMPLATES.get(row.template_name) ?? null) : null)
  );
}

export const NOTICE_LABEL: Record<NoticeKind, string> = {
  invoice: "Invoice",
  receipt: "Receipt",
  welcome: "Welcome/setup message",
  signup: "Sign-up reminder",
  billing: "Billing notice",
};

/** "+919812345670" → "+91…5670" (enough to recognise; the full number is in Admin). */
export function maskedPhone(phone: string | null | undefined): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.length < 4) return "(no number)";
  const last4 = digits.slice(-4);
  return digits.length === 12 && digits.startsWith("91") ? `+91…${last4}` : `…${last4}`;
}

/** Meta's error on a failed status → "Message undeliverable (131026)". */
export function metaErrorTitle(errors: unknown): { title: string; code: string | null } {
  const first = (Array.isArray(errors) ? errors[0] : null) as Record<string, unknown> | null;
  const code = first?.["code"] != null ? String(first["code"]) : null;
  const raw =
    (first?.["title"] as string | undefined) ??
    (first?.["message"] as string | undefined) ??
    ((first?.["error_data"] as Record<string, unknown> | undefined)?.["details"] as
      string | undefined) ??
    "Not delivered";
  const title = String(raw).replace(/\s+/g, " ").trim().slice(0, 160) || "Not delivered";
  return { title: code ? `${title} (${code})` : title, code };
}

/** The staff alert, exactly: "⚠️ Invoice not delivered to Asha Rao +91…5670 (Asha Jewellers): Message undeliverable (131026). Call them." */
export function undeliveredAlertText(input: {
  kind: NoticeKind;
  name: string;
  phone: string | null;
  org: string | null;
  error: string;
}): string {
  const org = input.org ? ` (${input.org})` : "";
  return `⚠️ ${NOTICE_LABEL[input.kind]} not delivered to ${input.name} ${maskedPhone(input.phone)}${org}: ${input.error}. Call them.`;
}

/** What Admin shows on a workspace whose last customer notice didn't reach them. */
export type UndeliveredBadge = {
  at: string;
  kind: NoticeKind;
  error: string;
  invoice_number: string | null;
};
