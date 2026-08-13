import { createFileRoute } from "@tanstack/react-router";
import { LegalPage, Section, Bullets } from "@/components/legal-page";

const TITLE = "Privacy Policy — AiDwar";
const DESCRIPTION =
  "How AiDwar, a product of Meezoy Ventures Private Limited, collects, uses, shares and protects personal data, in compliance with India's DPDP Act 2023.";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
    ],
  }),
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" effectiveDate="August 13, 2026">
      <p>
        This Privacy Policy explains how Meezoy Ventures Private Limited ("Meezoy", "we", "us")
        handles personal data in connection with AiDwar (the "Service"), an AI-powered marketing
        platform built on the WhatsApp Business Platform. It applies to our website, our
        applications and all customers and users of the Service.
      </p>

      <Section heading="1. Information we collect">
        <Bullets
          items={[
            "Account details: name, business name, work email, phone number, billing contact, authentication data and preferences you provide when registering or requesting access.",
            "Business contact lists: contact records that our customers upload or sync into the Service, such as names, phone numbers, tags and custom attributes relating to their own customers.",
            "Message content and delivery metadata: messages, templates, media and conversation history sent or received through the WhatsApp Business Platform, together with delivery, read, failure and engagement metadata.",
            "Usage analytics: log data, device and browser information, IP address, feature usage, performance metrics and diagnostic information.",
            "Support communications: the content of your emails, tickets and other correspondence with us.",
          ]}
        />
        <p>
          Where our customers upload contact data or send messages, they act as the data fiduciary
          (controller) for that data and we act as their data processor.
        </p>
      </Section>

      <Section heading="2. How we use information">
        <Bullets
          items={[
            "Providing and operating the Service, including account creation, campaign delivery, inbox functionality and integrations.",
            "Powering AI features such as campaign generation, message suggestions, segmentation and the AI sales agent.",
            "Providing customer support, responding to queries and investigating incidents.",
            "Improving reliability, security and performance, and developing new features using aggregated or de-identified data.",
            "Billing, fraud prevention, enforcing our Terms of Service and complying with legal obligations.",
          ]}
        />
        <p>
          We do not sell personal data and we do not use our customers' contact lists or message
          content for our own advertising.
        </p>
      </Section>

      <Section heading="3. WhatsApp Business Platform">
        <p>
          Messages sent and received through the Service are transmitted and processed via Meta's
          WhatsApp Business Platform (Cloud API). That processing is subject to Meta's own terms and
          policies, including the WhatsApp Business Terms and the WhatsApp Business Messaging Policy.
          By using the Service you acknowledge that message data will be handled by Meta Platforms,
          Inc. and its affiliates in accordance with those terms. AiDwar is an independent platform
          and is not endorsed by or affiliated with Meta.
        </p>
      </Section>

      <Section heading="4. AI processing">
        <p>
          Some features rely on third-party AI providers. Where an AI feature is used, relevant
          inputs — such as campaign briefs, message drafts or conversation context — may be sent to
          those providers to generate a response. We work only with providers that are bound by
          confidentiality and data-protection commitments, that process data solely on our
          instructions, and that do not use your data to train their general-purpose models. We
          minimise the data shared with AI providers to what is necessary for the requested feature.
        </p>
      </Section>

      <Section heading="5. Sharing of information">
        <p>We share personal data only with:</p>
        <Bullets
          items={[
            "Cloud hosting, storage, database, email and monitoring providers that operate our infrastructure.",
            "Meta Platforms, Inc., for the delivery of WhatsApp messages through the WhatsApp Business Platform.",
            "Third-party AI providers, for the AI features described above.",
            "Payment processors, for billing when paid plans are introduced.",
            "Professional advisers, authorities or acquirers, where required by law, to protect our rights, or in connection with a merger, acquisition or restructuring.",
          ]}
        />
      </Section>

      <Section heading="6. Security">
        <p>
          We apply reasonable technical and organisational safeguards, including encryption of data
          in transit, encryption at rest for stored data, role-based access controls, least-privilege
          access for our personnel, audit logging, network protections and periodic review of our
          security practices. No system is completely secure, but we work to promptly detect,
          investigate and notify affected parties of any personal data breach as required by law.
        </p>
      </Section>

      <Section heading="7. Data retention">
        <p>
          We retain account data for as long as your account is active. Contact lists and message
          data are retained while you use the Service and for up to 90 days after account closure,
          after which they are deleted or irreversibly anonymised, unless a longer period is required
          for legal, tax, accounting or dispute-resolution purposes. You may request earlier deletion
          at any time.
        </p>
      </Section>

      <Section heading="8. Your rights">
        <p>
          Subject to applicable law, you may request access to the personal data we hold about you,
          correction or completion of inaccurate data, erasure of your data, and withdrawal of any
          consent you have given (without affecting processing carried out before withdrawal). You
          may also nominate another individual to exercise your rights in the event of death or
          incapacity. Write to{" "}
          <a href="mailto:support@aidwar.in" className="text-primary hover:underline">
            support@aidwar.in
          </a>{" "}
          and we will respond within the timelines prescribed by law. If you are an end contact of
          one of our customers, please direct your request to that business; we will assist them in
          responding.
        </p>
      </Section>

      <Section heading="9. Compliance with the DPDP Act, 2023">
        <p>
          We process personal data in accordance with India's Digital Personal Data Protection Act,
          2023. We collect data for lawful, specified purposes, rely on valid consent or legitimate
          uses, limit collection to what is necessary, maintain accuracy, implement reasonable
          security safeguards, and delete data when the purpose is served. Our customers are
          responsible for obtaining valid, verifiable consent from their contacts before uploading
          their data or messaging them through the Service.
        </p>
      </Section>

      <Section heading="10. Grievance contact">
        <p>
          Grievance Officer, Meezoy Ventures Private Limited, Hyderabad, Telangana, India. Email:{" "}
          <a href="mailto:support@aidwar.in" className="text-primary hover:underline">
            support@aidwar.in
          </a>
          . We acknowledge grievances promptly and aim to resolve them within the statutory period.
        </p>
      </Section>

      <Section heading="11. Updates to this policy">
        <p>
          We may update this Privacy Policy from time to time. When we do, we will revise the
          effective date above and, for material changes, notify you by email or through an in-app
          notice before the change takes effect. Continued use of the Service after the effective
          date constitutes acceptance of the updated policy.
        </p>
      </Section>
    </LegalPage>
  );
}
