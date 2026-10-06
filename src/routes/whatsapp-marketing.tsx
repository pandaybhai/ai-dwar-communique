import { createFileRoute } from "@tanstack/react-router";
import { ProductPage } from "@/components/marketing/product-page";
import { productPageHead } from "@/lib/marketing-seo";

const content = {
  title: "WhatsApp Marketing Platform for Indian Businesses | AiDwar",
  heading: "WhatsApp marketing, with an AI employee ready to reply.",
  description:
    "Run WhatsApp campaigns, organise customer segments and automate follow-ups with AiDwar. Bring marketing and customer replies into one shared workspace.",
  intro:
    "AiDwar combines WhatsApp marketing tools with an AI employee for customer replies. Your team can organise contacts, send campaigns using approved templates, and manage the conversations that follow on the official WhatsApp Business Platform.",
  sections: [
    [
      "Campaigns and customer segments",
      "Organise contacts into relevant segments and select the audience for each campaign. Use approved message templates and send only to customers who have agreed to receive your messages.",
    ],
    [
      "Follow-ups for your commerce workflow",
      "Growth includes commerce flows for abandoned carts, cash-on-delivery workflows and order updates. Scale adds the visual flow builder. Choose the workflow and plan that match how your business operates.",
    ],
    [
      "A shared inbox for the replies",
      "Keep customer conversations in the same workspace as your campaigns. Your team can work with AI drafts or automatic replies according to the plan and settings you choose.",
    ],
    [
      "Understand plan fees and message credits",
      "The platform subscription and message credits are separate. Credits are prepaid, and your billing page shows the applicable message rate. Review the campaign estimate before sending; taxes and usage limits are shown on the pricing page.",
    ],
    [
      "Measure results without overclaiming",
      "Growth includes revenue attribution. Attribution helps connect recorded activity with orders; it does not by itself prove that a campaign caused every attributed sale. Compare results with your store’s order records.",
    ],
  ],
};

export const Route = createFileRoute("/whatsapp-marketing")({
  head: () => productPageHead("/whatsapp-marketing", content),
  component: () => <ProductPage path="/whatsapp-marketing" content={content} />,
});
