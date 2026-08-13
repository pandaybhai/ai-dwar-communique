import { createFileRoute } from "@tanstack/react-router";
import { LegalPage, Section, Bullets } from "@/components/legal-page";

const TITLE = "Terms of Service — AiDwar";
const DESCRIPTION =
  "The terms governing use of AiDwar, the AI-powered WhatsApp marketing platform from Meezoy Ventures Private Limited, Hyderabad, India.";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
    ],
  }),
  component: TermsPage,
});

function TermsPage() {
  return (
    <LegalPage title="Terms of Service" effectiveDate="August 13, 2026">
      <p>
        These Terms of Service ("Terms") form a binding agreement between Meezoy Ventures Private
        Limited ("Meezoy", "we", "us") and the person or entity using AiDwar (the "Service", "you").
        By creating an account, requesting access or using the Service, you accept these Terms.
      </p>

      <Section heading="1. The Service">
        <p>
          AiDwar is an AI-powered marketing platform that lets businesses run campaigns, broadcasts,
          automations and conversations on WhatsApp through the official WhatsApp Business Platform
          (Cloud API). Features include AI campaign creation, scheduling, a shared team inbox, an AI
          sales agent, contact segmentation and analytics. We may add, modify or discontinue features
          from time to time. AiDwar is independent of Meta Platforms, Inc.; WhatsApp is a trademark
          of Meta Platforms, Inc.
        </p>
      </Section>

      <Section heading="2. Account registration and responsibility">
        <p>
          You must provide accurate, complete registration information and keep it current. You must
          be at least 18 years old and authorised to bind the business you represent. You are
          responsible for all activity under your account, for maintaining the confidentiality of
          credentials, for the conduct of your team members and for notifying us immediately of any
          unauthorised access.
        </p>
      </Section>

      <Section heading="3. Acceptable use">
        <Bullets
          items={[
            "You must obtain valid, documented opt-in consent from every contact before messaging them through the Service, and honour opt-out requests promptly.",
            "You must not send spam, bulk unsolicited messages, or purchase, scrape or rent contact lists.",
            "You must not send prohibited content, including unlawful, deceptive, defamatory, obscene, hateful, harassing or infringing material, or content promoting goods and services restricted by Meta's policies.",
            "You must comply with the WhatsApp Business Messaging Policy, the WhatsApp Business Terms, Meta's Commerce Policy and all applicable laws, including India's DPDP Act 2023 and consumer-protection and telemarketing rules.",
            "You must not attempt to reverse engineer, resell, overload, probe or circumvent the Service, its rate limits or its security controls.",
            "You must not use AI features to generate misleading, impersonating or unlawful content.",
          ]}
        />
        <p>
          We may investigate suspected violations and may suspend, throttle or terminate accounts
          that violate these Terms or platform policies, with or without notice where the violation
          poses legal, security or platform risk.
        </p>
      </Section>

      <Section heading="4. Your data and contacts">
        <p>
          You retain ownership of the contact data and content you upload. You are solely responsible
          for the accuracy, quality and legality of that data, for having a lawful basis and consent
          to process it, and for the content of the messages you send. You grant us a limited licence
          to host, process and transmit your data solely to provide the Service. You will indemnify
          us against claims arising from your data or your messaging practices.
        </p>
      </Section>

      <Section heading="5. Fees and billing">
        <p>
          The Service is currently offered in early access. Paid plans and usage-based charges
          (including any per-conversation charges levied by Meta) will be introduced in the future,
          and these Terms will be updated with the applicable pricing, billing cycle, taxes and
          refund terms before any fees become payable. We will give notice before charging you.
        </p>
      </Section>

      <Section heading="6. Third-party services">
        <p>
          The Service depends on the WhatsApp Business Platform, cloud infrastructure and third-party
          AI providers. We are not responsible for outages, policy changes, template rejections,
          number bans or other actions taken by those providers, and your use of them is subject to
          their own terms.
        </p>
      </Section>

      <Section heading="7. Limitation of liability">
        <p>
          The Service is provided "as is" and "as available" without warranties of any kind, express
          or implied, including merchantability, fitness for a particular purpose and
          non-infringement. To the maximum extent permitted by law, Meezoy will not be liable for any
          indirect, incidental, special, consequential or punitive damages, or for lost profits,
          revenue, goodwill or data. Our total aggregate liability arising out of or relating to the
          Service will not exceed the amounts you paid to us in the three (3) months preceding the
          event giving rise to the claim, or INR 5,000 where no fees have been paid.
        </p>
      </Section>

      <Section heading="8. Termination">
        <p>
          You may stop using the Service and close your account at any time. We may suspend or
          terminate your access for breach of these Terms, non-payment, legal requirements or
          platform-policy violations. On termination, your right to use the Service ends immediately;
          you may export your data before closure, and we will delete or anonymise remaining data in
          line with our Privacy Policy. Sections relating to data responsibility, liability,
          indemnity and governing law survive termination.
        </p>
      </Section>

      <Section heading="9. Changes to these Terms">
        <p>
          We may update these Terms. Material changes will be notified by email or in-app notice
          before they take effect, and the effective date above will be revised. Continued use of the
          Service after the effective date constitutes acceptance.
        </p>
      </Section>

      <Section heading="10. Governing law and jurisdiction">
        <p>
          These Terms are governed by the laws of India. The courts at Hyderabad, Telangana, India
          have exclusive jurisdiction over any dispute arising out of or in connection with these
          Terms or the Service.
        </p>
      </Section>

      <Section heading="11. Contact">
        <p>
          Meezoy Ventures Private Limited, Hyderabad, Telangana, India ·{" "}
          <a href="mailto:support@aidwar.in" className="text-primary hover:underline">
            support@aidwar.in
          </a>
        </p>
      </Section>
    </LegalPage>
  );
}
