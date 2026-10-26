import { createFileRoute, Link } from "@tanstack/react-router";
import { LegalPage, Section, Bullets } from "@/components/legal-page";
import { COMPANY } from "@/lib/company";

const TITLE = "Refunds & Cancellations — AiDwar";
const DESCRIPTION =
  "How cancelling an AiDwar plan works, when plan fees and message credits are refunded, and how to ask for a refund.";

export const Route = createFileRoute("/refunds")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
    ],
  }),
  component: RefundsPage,
});

export function RefundsPage() {
  const mail = (
    <a href={`mailto:${COMPANY.email}`} className="text-primary hover:underline">
      {COMPANY.email}
    </a>
  );
  return (
    <LegalPage title="Refunds & Cancellations" effectiveDate="October 26, 2026">
      <p>
        This policy explains how cancellations and refunds work for {COMPANY.brand}, a service of{" "}
        {COMPANY.legalName}. Prices and plans are listed on our{" "}
        <Link to="/pricing" className="text-primary hover:underline">
          pricing page
        </Link>
        .
      </p>

      <Section heading="1. Plan fee (monthly or yearly)">
        <Bullets
          items={[
            "You can cancel your plan at any time from Billing in your workspace.",
            "After you cancel, the plan stays active until the end of the period you have already paid for. It does not renew after that.",
            "Fees for a billing period that has already started are not refunded.",
            "Exception: a yearly plan cancelled within 7 days of payment is refunded in full.",
          ]}
        />
      </Section>

      <Section heading="2. Message credits">
        <Bullets
          items={[
            "Message credits are prepaid and do not expire while your account is active.",
            "Unused credits are refunded when you close your account, if you ask for the refund within 30 days of closing. Payment-gateway charges are deducted from the refund.",
            "Credits used for messages already sent are not refundable, because Meta charges for those messages.",
          ]}
        />
      </Section>

      <Section heading="3. Failed, duplicate or excess payments">
        <p>
          If a payment failed but money left your account, or you were charged twice or more than
          the amount due, we refund it in full to the original payment method within 5-7 working
          days.
        </p>
      </Section>

      <Section heading="4. How to ask for a refund">
        <p>
          Email {mail} with your invoice number. We acknowledge every request within 2 working days.
          Approved refunds are processed within 5-7 working days to the original payment method.
        </p>
      </Section>

      <Section heading="5. Free trial">
        <p>The free trial is not charged, so there is nothing to refund.</p>
      </Section>

      <Section heading="6. Contact">
        <p>
          Questions about a payment or a refund: {mail}, or see{" "}
          <Link to="/contact" className="text-primary hover:underline">
            Contact Us
          </Link>
          .
        </p>
      </Section>
    </LegalPage>
  );
}
