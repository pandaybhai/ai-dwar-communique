import { createFileRoute, Link } from "@tanstack/react-router";
import { LegalPage, Section, Bullets } from "@/components/legal-page";

const TITLE = "Data Deletion — AiDwar";
const DESCRIPTION =
  "How to delete your AiDwar workspace data, or ask us to remove your personal data if a business messaged you through AiDwar.";

export const Route = createFileRoute("/data-deletion")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DataDeletionPage,
});

function DataDeletionPage() {
  return (
    <LegalPage title="Data Deletion" effectiveDate="August 17, 2026">
      <p>
        This page explains how to get data deleted from AiDwar. There are two kinds of people who
        land here, and the steps are different for each. Pick the one that describes you.
      </p>

      <Section heading="1. You are a business using AiDwar">
        <p>
          You signed up for AiDwar, connected a WhatsApp Business Account and uploaded your
          contacts. You can ask us to delete your workspace and everything inside it:
        </p>
        <Bullets
          items={[
            "Contacts, tags, segments and imported files",
            "Conversations and every message sent or received",
            "Campaigns and their delivery records",
            "Message templates and automations",
            "Team members, invitations and permissions",
            "Stored WhatsApp Business Account details, access tokens and the two-step PIN",
          ]}
        />
        <p className="font-medium text-foreground">Two ways to do it:</p>
        <Bullets
          items={[
            "Self-serve: sign in, go to Settings → General → Delete workspace. The workspace owner confirms by typing the workspace name. We start the deletion straight away and email you when it is finished.",
            "By email: write to privacy@aidwar.in from your registered email address with the subject \"Delete my workspace\". Include your registered email, your workspace name, and the WhatsApp number connected to the account.",
          ]}
        />
      </Section>

      <Section heading="2. A business messaged you through AiDwar">
        <p>
          If you received a WhatsApp message from a business that uses AiDwar, your phone number and
          chat history sit inside <em>that business&apos;s</em> workspace. That business decides what
          data it collects and keeps — it is the controller. We only store and process it on their
          instructions, as their processor. So:
        </p>
        <Bullets
          items={[
            "Fastest fix: reply STOP to any message from that business. Every future message from them stops immediately, automatically, with no waiting.",
            "To have your data deleted: contact the business that messaged you and ask them to delete your record. They can do it in seconds from their AiDwar workspace.",
            "Can't reach them? Email privacy@aidwar.in with the phone number that received the message and the name of the business (or a screenshot). We forward your request to that business, follow it up, and confirm to you in writing once it has been actioned.",
          ]}
        />
      </Section>

      <Section heading="3. Controller and processor roles">
        <p>
          AiDwar is operated by Meezoy Ventures Private Limited. For data uploaded by client
          businesses — such as contact lists, messages, templates and campaign records — AiDwar acts
          as a processor and processes that data only on the client business&apos;s instructions. For
          account data, authentication data, billing records and Meta Platform Data (access tokens,
          WhatsApp Business Account details and related identifiers), AiDwar is the controller.
        </p>
      </Section>

      <Section heading="4. What we commit to">
        <Bullets
          items={[
            "We acknowledge every request within 7 days.",
            "We complete every request within 30 days.",
            "We confirm in writing, by email, once the deletion is done.",
            "On deletion we remove the workspace data listed above, and immediately revoke the stored Meta access token with Meta and delete the token and the two-step PIN from our systems.",
          ]}
        />
      </Section>

      <Section heading="5. What we keep, and why">
        <Bullets
          items={[
            "Billing and tax records — invoices, payment references and GST records. Indian tax law requires us to keep these for 8 years from the end of the relevant financial year. They contain company and payment details, not your contacts or messages.",
            "Minimal audit logs — a record of who did what and when (for example \"workspace deleted\"), kept for 12 months for security and dispute resolution. These never contain message contents, contact lists or credentials.",
          ]}
        />
        <p>Nothing else is retained after a deletion is completed.</p>
      </Section>

      <Section heading="6. Meta Platform Data">
        <p>
          Access tokens, WhatsApp Business Account IDs, phone number IDs and related details we
          receive from Meta are deleted as soon as a WhatsApp number is disconnected or a workspace
          is deleted. They are never retained after that point, never shared with anyone else, and
          never used for any purpose other than sending and receiving messages on your behalf while
          the connection is active.
        </p>
      </Section>

      <Section heading="7. Shopify store data">
        <p>
          When a merchant connects a Shopify store to AiDwar, we receive customer name, email
          address, phone number and order data from that store. We use it for one purpose only: to
          deliver WhatsApp messages on the merchant&apos;s behalf. We never sell it, never share it
          with third parties, and never use it to build profiles or train models.
        </p>
        <Bullets
          items={[
            "The merchant who owns the Shopify store is the controller of that data. AiDwar is the processor and acts only on their instructions.",
            "Uninstalling the AiDwar app from a Shopify store triggers deletion of all data synced from that store — products, orders, order line items, abandoned checkouts, sync records and the stored access token — within 30 days, and usually within 48 hours.",
            "Shopify's data request and redaction webhooks are honoured automatically. A customers/data_request is recorded and answered within 30 days; a customers/redact permanently deletes that shopper's records from the merchant's workspace; a shop/redact removes everything synced from that store.",
            "Shoppers should contact the merchant they bought from, who can action the request directly. If you cannot reach them, email privacy@aidwar.in and we will forward and follow it up.",
          ]}
        />
      </Section>


      <Section heading="7. Who to contact">
        <p className="font-medium text-foreground">Registered entity</p>
        <p className="mb-4">
          Meezoy Ventures Private Limited
          <br />
          Hyderabad, Telangana, India
        </p>
        <Bullets
          items={[
            "Deletion and privacy requests: privacy@aidwar.in (monitored on working days)",
            "General support: support@aidwar.in",
          ]}
        />
        <p>
          More detail on what we collect and why is in our{" "}
          <Link to="/privacy" className="text-primary hover:underline">
            Privacy Policy
          </Link>
          .
        </p>
      </Section>
    </LegalPage>
  );
}
