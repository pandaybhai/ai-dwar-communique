import { createFileRoute } from "@tanstack/react-router";
import { ProductPage } from "@/components/marketing/product-page";
import { productPageHead } from "@/lib/marketing-seo";

const content = {
  title: "AiDwar FAQ | WhatsApp AI, Marketing, Shopify & Pricing",
  heading: "Straight answers about AiDwar.",
  description:
    "Answers about AiDwar’s WhatsApp AI employee, marketing campaigns, Shopify integration, languages, owner review, plans and message credits.",
  intro:
    "AiDwar brings an AI employee and WhatsApp marketing tools into one workspace. These answers explain how the product fits your business and what to check before you enable it.",
  sections: [
    [
      "What is AiDwar?",
      "AiDwar is an AI employee in your WhatsApp and a WhatsApp marketing platform. It combines customer reply assistance with campaigns, customer segments, follow-ups and a shared inbox on the official WhatsApp Business Platform.",
    ],
    [
      "Where does the AI get its answers?",
      "It uses the website, catalogue and answers your business provides. Keep this information up to date and test representative questions before allowing automatic replies.",
    ],
    [
      "Does AiDwar support Hindi and Hinglish?",
      "It is designed to reply in the customer’s language, including Hindi and Hinglish. Test the languages and vocabulary relevant to your business during setup.",
    ],
    [
      "Can I approve replies before they are sent?",
      "Yes. Draft only mode prepares replies for a person to review and send. Automatic AI replies are listed in Growth. You can turn the AI off and keep your team in control.",
    ],
    [
      "What if the AI does not know a price or policy?",
      "It is designed to flag missing information and ask for owner input. No AI system should be treated as incapable of mistakes. Supply accurate sources and review sensitive or uncertain answers.",
    ],
    [
      "Does it connect to Shopify?",
      "Yes. Shopify sync and catalogue features are listed in Growth, along with commerce flows and revenue attribution. Confirm the connection and synced data during setup.",
    ],
    [
      "Can I send WhatsApp marketing campaigns?",
      "Yes. AiDwar supports campaigns, approved templates, contacts and segments. Send marketing only with the customer’s consent and follow applicable WhatsApp requirements.",
    ],
    [
      "Are WhatsApp messages included in the subscription?",
      "Message credits are topped up separately from the platform subscription. The billing page shows applicable rates, and campaigns provide an estimate before sending. See pricing for GST and plan-specific limits.",
    ],
    [
      "Is the trial free, and do I need a card?",
      "The pricing page offers a free start with no card required. Confirm the trial duration and available features shown during your account setup; ongoing usage depends on your plan and message credits.",
    ],
    [
      "Can I see the product before signing up?",
      "Yes. The demo page includes recorded tests with fictional business information, showing an answer and an owner handoff. You can also request a personalised walkthrough.",
    ],
    [
      "Who operates AiDwar?",
      "AiDwar is a product of Meezoy Ventures Private Limited, Hyderabad, India. Contact support@aidwar.in for questions. AiDwar is an independent platform built on the WhatsApp Business Platform.",
    ],
  ],
};

export const Route = createFileRoute("/faq")({
  head: () => productPageHead("/faq", content),
  component: () => <ProductPage path="/faq" content={content} />,
});
