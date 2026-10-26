import { createFileRoute, Link } from "@tanstack/react-router";
import { LegalPage, Section, Bullets } from "@/components/legal-page";
import { COMPANY } from "@/lib/company";

const TITLE = "Shipping & Delivery — AiDwar";
const DESCRIPTION =
  "AiDwar is a software service delivered online: plans are activated and credits added immediately after payment. No physical goods are shipped.";

export const Route = createFileRoute("/shipping")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
    ],
  }),
  component: ShippingPage,
});

export function ShippingPage() {
  return (
    <LegalPage title="Shipping & Delivery" effectiveDate="October 26, 2026">
      <p>
        {COMPANY.brand} is a software service from {COMPANY.legalName}, delivered online through
        your web browser. There is nothing to ship.
      </p>

      <Section heading="1. How the service is delivered">
        <Bullets
          items={[
            "Plans: access to your plan is activated immediately after a successful payment.",
            "Message credits: credits appear in your wallet immediately after a successful payment.",
            "No physical goods are shipped, and there are no shipping charges.",
          ]}
        />
      </Section>

      <Section heading="2. If access is not activated">
        <p>
          If your plan or credits are not active within 24 hours of a successful payment, contact us
          at{" "}
          <a href={`mailto:${COMPANY.email}`} className="text-primary hover:underline">
            {COMPANY.email}
          </a>{" "}
          with your invoice number, or see{" "}
          <Link to="/contact" className="text-primary hover:underline">
            Contact Us
          </Link>
          . Payments that went through but could not be activated are covered by our{" "}
          <Link to="/refunds" className="text-primary hover:underline">
            Refunds &amp; Cancellations
          </Link>{" "}
          policy.
        </p>
      </Section>
    </LegalPage>
  );
}
