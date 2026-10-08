import type { SupabaseClient } from "@supabase/supabase-js";
import { money } from "@/lib/billing";
import { isEmailAddress, sendEmail, type EmailMessage, type EmailResult } from "@/lib/email.server";

/**
 * Delivery for billing notices queued with channel 'email' (today: the
 * invoice copy for a workspace's billing email, from deliverInvoice).
 *
 * The WhatsApp drain (drainBillingNotifications) never reads these rows;
 * this one sends them. Same rules: claim before sending (two drains never
 * send one notice twice), every outcome is written on the row, a failed
 * notice is retried a few times, and the loop never throws.
 *
 * Without RESEND_API_KEY it does nothing, exactly as before email existed:
 * the rows stay queued. A notice older than 48 hours is never sent (it is
 * marked skipped, "expired") — a backlog from before the key was added, or
 * from an outage, must not reach people days late.
 */

export const EMAIL_NOTICE_MAX_AGE_MS = 48 * 3600_000;
const MAX_ATTEMPTS = 3;
/** A drain's claim on a notice; older than this, the drain died. */
const NOTICE_CLAIM_MS = 10 * 60_000;
/** The invoice link in the email outlives the 10-minute in-app link. */
const INVOICE_LINK_SECONDS = 7 * 86_400;

export type EmailNoticeCounts = { sent: number; failed: number; skipped: number; expired: number };

type Content = Pick<EmailMessage, "subject" | "body" | "attachmentUrl" | "attachmentName">;

export async function drainEmailNotices(
  supabase: SupabaseClient,
  limit = 20,
  deps: { send?: (message: EmailMessage) => Promise<EmailResult>; now?: () => number } = {},
): Promise<EmailNoticeCounts> {
  const counts: EmailNoticeCounts = { sent: 0, failed: 0, skipped: 0, expired: 0 };
  if (!process.env["RESEND_API_KEY"]?.trim()) return counts;
  const send = deps.send ?? sendEmail;
  const now = deps.now ?? Date.now;

  try {
    const { data: rows } = await supabase
      .from("billing_notifications")
      .select(
        "id, organization_id, audience, kind, channel, recipient, payload, status, sent_at, created_at",
      )
      .eq("channel", "email")
      .in("status", ["queued", "failed"])
      .order("created_at", { ascending: true })
      .limit(Math.min(Math.max(limit, 1), 50));

    for (const row of (rows ?? []) as Record<string, unknown>[]) {
      try {
        const payload = (row["payload"] ?? {}) as Record<string, unknown>;
        if (row["status"] === "failed" && Number(payload["attempts"] ?? 0) >= MAX_ATTEMPTS)
          continue;

        // Claim it first (compare-and-set on sent_at, which every outcome writes).
        const claimedAt = (row["sent_at"] as string | null) ?? null;
        if (claimedAt && now() - Date.parse(claimedAt) < NOTICE_CLAIM_MS) {
          counts.skipped += 1;
          continue;
        }
        const claim = supabase
          .from("billing_notifications")
          .update({ sent_at: new Date(now()).toISOString() })
          .eq("id", row["id"] as string)
          .eq("status", row["status"] as string);
        const { data: claimed, error: claimError } = await (
          claimedAt ? claim.eq("sent_at", claimedAt) : claim.is("sent_at", null)
        ).select("id");
        if (claimError || !claimed?.length) {
          counts.skipped += 1;
          continue;
        }

        const mark = async (
          status: "sent" | "failed" | "skipped",
          error: string | null,
          extra: Record<string, unknown> = {},
        ) => {
          const patch: Record<string, unknown> = {
            status,
            error: error ? error.slice(0, 500) : null,
            sent_at: new Date(now()).toISOString(),
          };
          if (status === "failed")
            patch["payload"] = {
              ...payload,
              ...extra,
              attempts: Number(payload["attempts"] ?? 0) + 1,
            };
          else if (Object.keys(extra).length) patch["payload"] = { ...payload, ...extra };
          await supabase
            .from("billing_notifications")
            .update(patch)
            .eq("id", row["id"] as string);
        };

        const createdAt = Date.parse(String(row["created_at"] ?? ""));
        if (!Number.isFinite(createdAt) || now() - createdAt > EMAIL_NOTICE_MAX_AGE_MS) {
          await mark("skipped", "expired_48h");
          counts.expired += 1;
          continue;
        }

        const to = String(row["recipient"] ?? "").trim();
        if (!isEmailAddress(to)) {
          await mark("failed", "no_recipient");
          counts.failed += 1;
          continue;
        }

        const content = await emailNoticeContent(supabase, row);
        if (!content) {
          await mark("skipped", "no_email_text_for_kind");
          counts.skipped += 1;
          continue;
        }

        const result = await send({
          to,
          ...content,
          idempotencyKey: `billing-notice-${String(row["id"])}`,
        });
        const extra = { email_id: result.id ?? null, attachment: result.attachment ?? null };
        if (result.ok) {
          await mark("sent", null, extra);
          counts.sent += 1;
        } else {
          await mark("failed", result.error ?? "email_failed", extra);
          counts.failed += 1;
        }
      } catch (error) {
        console.warn(
          "[email-notices] notice failed",
          error instanceof Error ? error.message : String(error),
        );
        counts.failed += 1;
      }
    }
  } catch (error) {
    console.warn(
      "[email-notices] drain failed",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (counts.sent || counts.failed || counts.expired)
    console.log("[email-notices]", JSON.stringify(counts));
  return counts;
}

/** Subject and body for one notice, or null when the kind has no email wording. */
export async function emailNoticeContent(
  supabase: SupabaseClient,
  row: Record<string, unknown>,
): Promise<Content | null> {
  const payload = (row["payload"] ?? {}) as Record<string, unknown>;
  const kind = String(row["kind"] ?? "");
  if (kind !== "invoice_issued") return null;

  const { data: org } = row["organization_id"]
    ? await supabase
        .from("organizations")
        .select("name")
        .eq("id", row["organization_id"] as string)
        .maybeSingle()
    : { data: null };
  const orgName =
    String((org as { name?: string | null } | null)?.name ?? "").trim() || "your workspace";

  let number = String(payload["invoice_number"] ?? "").trim();
  let amount = Number(payload["amount"] ?? 0);
  let pdfPath = (payload["pdf_path"] as string | null) ?? null;
  if (payload["invoice_id"]) {
    // The invoice as it stands now: its PDF may have been made after the notice was queued.
    const { data: invoice } = await supabase
      .from("invoices")
      .select("invoice_number, total, pdf_path")
      .eq("id", payload["invoice_id"] as string)
      .maybeSingle();
    const inv = (invoice ?? {}) as Record<string, unknown>;
    number = String(inv["invoice_number"] ?? number).trim();
    if (inv["total"] != null) amount = Number(inv["total"]);
    pdfPath = (inv["pdf_path"] as string | null) ?? pdfPath;
  }

  let attachmentUrl: string | null = null;
  if (pdfPath) {
    const { data } = await supabase.storage
      .from("invoices")
      .createSignedUrl(pdfPath, INVOICE_LINK_SECONDS);
    attachmentUrl = (data as { signedUrl?: string } | null)?.signedUrl ?? null;
  }

  const label = number ? `invoice ${number}` : "invoice";
  return {
    subject: `Your AiDwar ${label} for ${orgName}`,
    body:
      `Hello — here is your ${label} for ${money(amount)} for ${orgName}.` +
      (attachmentUrl ? " The PDF is attached." : "") +
      `\n\nYou can see all your invoices at https://aidwar.in/app/billing.\n\nThank you.`,
    attachmentUrl,
    attachmentName: number ? `${number.replace(/[^\w.-]+/g, "-")}.pdf` : "invoice.pdf",
  };
}
