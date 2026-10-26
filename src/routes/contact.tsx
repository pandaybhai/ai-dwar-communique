import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { LegalPage, Section } from "@/components/legal-page";
import { COMPANY, hasDetail, telHref, type Company } from "@/lib/company";

const TITLE = "Contact Us — AiDwar";
const DESCRIPTION =
  "How to reach AiDwar, a product of Meezoy Ventures Private Limited: email, phone, support hours and registered address.";

export const Route = createFileRoute("/contact")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
    ],
  }),
  component: ContactPage,
});

function ContactPage() {
  return (
    <LegalPage title="Contact Us" eyebrow="Support">
      <ContactDetails company={COMPANY} />
    </LegalPage>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[11rem_1fr] sm:gap-4">
      <dt className="font-medium text-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** The contact lines; a detail that isn't set is left out, never shown blank. */
export function ContactDetails({ company }: { company: Company }) {
  return (
    <>
      <p>
        Questions about your account, billing, a payment or a refund? Write to us
        {hasDetail(company.phone) ? " or call" : ""} — we reply within 2 working days.
      </p>
      <Section heading="Business details">
        <dl className="space-y-4">
          <Row label="Legal name">{company.legalName}</Row>
          <Row label="Brand">{company.brand}</Row>
          {hasDetail(company.registeredAddress) ? (
            <Row label="Registered address">{company.registeredAddress}</Row>
          ) : (
            <Row label="City">{company.city}</Row>
          )}
          <Row label="Email">
            <a href={`mailto:${company.email}`} className="text-primary hover:underline">
              {company.email}
            </a>
          </Row>
          {hasDetail(company.phone) ? (
            <Row label="Phone">
              <a href={telHref(company)} className="text-primary hover:underline">
                {company.phone}
              </a>
            </Row>
          ) : null}
          {hasDetail(company.supportHours) ? (
            <Row label="Support hours">{company.supportHours}</Row>
          ) : null}
          {hasDetail(company.gstin) ? <Row label="GSTIN">{company.gstin}</Row> : null}
        </dl>
      </Section>
      <Section heading="Response time">
        <p>We reply within 2 working days.</p>
      </Section>
    </>
  );
}
