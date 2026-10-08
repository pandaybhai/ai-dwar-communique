import { createFileRoute } from "@tanstack/react-router";
import { ProductPage } from "@/components/marketing/product-page";
import { productPageHead } from "@/lib/marketing-seo";

const content = {
  title: "WhatsApp AI Employee for Your Business | AiDwar",
  heading: "Your AI employee in your WhatsApp.",
  description:
    "AiDwar uses your website, catalogue and taught answers to help answer WhatsApp customer questions, with Hindi and Hinglish support and owner review.",
  intro:
    "AiDwar is an AI employee for customer conversations on WhatsApp. It uses the business information you provide to help answer product and service questions, while your team stays in control of what it can send.",
  sections: [
    [
      "Answers from your business information",
      "Give AiDwar your website, catalogue and answers to common questions. Keep those sources accurate and current: an AI answer is only as useful as the information available to it.",
    ],
    [
      "Hindi, Hinglish and customer language",
      "AiDwar is designed to reply in the language of the customer’s message, including Hindi and Hinglish. Test the languages and product vocabulary your customers actually use before enabling automatic replies.",
    ],
    [
      "Start with drafts, then choose automatic replies",
      "In Draft only mode, AiDwar prepares a reply for a person to review and send. Growth includes automatic AI replying. You can keep owner review in your workflow and switch the AI off when needed.",
    ],
    [
      "What happens when information is missing?",
      "AiDwar is designed to flag missing information and bring in the owner rather than invent a price or policy. This is a safeguard, not a promise that AI can never make an error. Review the recorded answer and handoff examples on our demo page.",
    ],
    [
      "AI replies and marketing in one workspace",
      "Use customer replies alongside campaigns, approved templates, contact segments and a shared inbox. Reply assistance and outbound marketing serve different jobs, and the available features depend on your plan.",
    ],
  ],
};

export const Route = createFileRoute("/whatsapp-ai-employee")({
  head: () => productPageHead("/whatsapp-ai-employee", content),
  component: () => <ProductPage path="/whatsapp-ai-employee" content={content} />,
});
