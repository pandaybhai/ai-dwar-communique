/**
 * Transactional email is a separate build. Until it lands, every email we
 * would have sent is still recorded as a queued billing_notifications row
 * with channel 'email', so nothing is lost — this stub only logs.
 */
export type EmailMessage = {
  to: string;
  subject: string;
  body: string;
  attachmentUrl?: string | null;
};

export async function sendEmail(message: EmailMessage): Promise<{ ok: boolean; error?: string }> {
  console.info("[email:stub] would send", {
    to: message.to,
    subject: message.subject,
    attachment: message.attachmentUrl ?? null,
  });
  return { ok: false, error: "email_not_configured" };
}
