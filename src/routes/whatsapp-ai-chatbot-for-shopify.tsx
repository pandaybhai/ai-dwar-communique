import { createFileRoute } from "@tanstack/react-router";
import { ProductPage } from "@/components/marketing/product-page";
import { productPageHead } from "@/lib/marketing-seo";

const content = {
  title: "WhatsApp AI Chatbot for Shopify Stores in India | AiDwar",
  heading: "An AI employee for your Shopify store’s WhatsApp.",
  description:
    "Connect Shopify with AiDwar for catalogue-led WhatsApp replies, Hindi and Hinglish conversations, commerce follow-ups and a shared inbox. Available from Growth.",
  intro:
    "AiDwar helps Shopify merchants combine product enquiries and WhatsApp marketing in one workspace. Connect your store catalogue, teach the AI your business answers, and choose whether replies need review or can be sent automatically.",
  sections: [
    [
      "What the Shopify integration handles",
      "The integration includes catalogue sync and commerce data used by order and checkout workflows. Your connection, permissions and successful sync determine which data is available. Check the catalogue after connecting before relying on it for customer replies.",
    ],
    [
      "Product questions in Hindi and Hinglish",
      "Customers can ask questions in their own language. For example, a jewellery customer might ask for a ring within a budget. AiDwar needs suitable product information to help; missing prices or policies should be reviewed by the owner.",
    ],
    [
      "Keep prices and availability trustworthy",
      "Store information can change between syncs. Do not treat a catalogue answer as a guaranteed stock reservation or final checkout price. Keep product data current and use owner review for questions that need confirmation.",
    ],
    [
      "Marketing after the first enquiry",
      "Use campaigns and customer segments alongside commerce flows for abandoned carts, cash-on-delivery workflows and order updates. Follow customer consent and applicable WhatsApp template requirements.",
    ],
    [
      "Which plan do I need?",
      "Shopify sync, commerce flows, revenue attribution and automatic AI replies are listed in Growth. Starter offers AI drafts for review. Check current prices, AI answer allowances, taxes and message credit charges before choosing a plan.",
    ],
    [
      "How to get started",
      "Create an AiDwar account, connect your WhatsApp business number and Shopify integration, and check your synced catalogue. Teach missing business answers, test common questions in draft mode, and then choose the reply settings that suit your team.",
    ],
  ],
};

export const Route = createFileRoute("/whatsapp-ai-chatbot-for-shopify")({
  head: () => productPageHead("/whatsapp-ai-chatbot-for-shopify", content),
  component: () => <ProductPage path="/whatsapp-ai-chatbot-for-shopify" content={content} />,
});
