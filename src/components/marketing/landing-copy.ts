import {
  BookOpenCheck,
  HandHelping,
  Link2,
  MessageCircleQuestion,
  MessagesSquare,
  SlidersHorizontal,
  Sparkles,
  Store,
  UsersRound,
} from "lucide-react";
import type { ProofAudience } from "@/components/marketing/product-proof";

/**
 * The landing page's words (moved here unchanged in Batch 50), so the current
 * landing and the new one (switch new_site) say exactly the same things.
 */

export const CAPABILITIES = [
  {
    icon: BookOpenCheck,
    title: "Understands",
    body: "It reads your website, catalogue and the answers you teach it, so replies are grounded in your own material.",
  },
  {
    icon: MessagesSquare,
    title: "Replies",
    body: "Customers get an answer in the language they wrote in, at 11 at night or during a festival rush.",
  },
  {
    icon: HandHelping,
    title: "Asks you",
    body: "When it has no answer in what it knows, it is designed to stop, say so plainly and bring you in.",
  },
];

export const AUDIENCE_BENEFITS: Record<ProofAudience, { icon: typeof Store; title: string; points: string[] }> = {
  retail: {
    icon: Store,
    title: "Retail & D2C",
    points: [
      "Size, price and stock questions answered from your own product pages",
      "Product links sent in the chat instead of screenshots",
      "Designed to ask you rather than state a price it cannot find in your catalogue",
    ],
  },
  services: {
    icon: MessageCircleQuestion,
    title: "Services & appointments",
    points: [
      "Enquiries qualified before they reach your team",
      "Details collected in one thread, not across five chats",
      "Anyone asking for a person is handed over straight away",
    ],
  },
  growing: {
    icon: UsersRound,
    title: "Growing teams",
    points: [
      "One shared inbox, so your team can see who is handling which chat",
      "Draft only mode while your team builds trust in it",
      "A work history showing what was answered and what was handed over",
    ],
  },
};

export const STEPS = [
  {
    icon: Link2,
    title: "Connect your number",
    body: "Connect your business number through the official WhatsApp Business Platform. Your number, your account.",
  },
  {
    icon: BookOpenCheck,
    title: "It reads your business",
    body: "Point it at your website or store and it builds its knowledge from your pages, products and policies.",
  },
  {
    icon: Sparkles,
    title: "You teach the gaps",
    body: "Whenever it doesn't know something, it asks you. Your answer becomes part of what it knows.",
  },
  {
    icon: SlidersHorizontal,
    title: "You choose how far it goes",
    body: "Off, Draft only, or Replying. Change it whenever you like, from your phone.",
  },
];

export const FAQS = [
  {
    q: "Will it make things up about my products?",
    a: "It is built to answer from what it has read or been taught. When it has no source for something, it is designed to say so and ask you, rather than state a price or a promise. You can also review its replies before they go out.",
  },
  {
    q: "Do I have to let it reply straight away?",
    a: "No. You can start in Draft only, where it writes the reply and a person presses send. You can switch it off entirely at any time.",
  },
  {
    q: "Is this the official WhatsApp Business Platform?",
    a: "Yes. Your business number is connected through the official platform, and message templates go through the usual approval process.",
  },
  {
    q: "Which languages does it handle?",
    a: "It is built to reply in the language the customer wrote in, including Hinglish and several Indian languages alongside English.",
  },
  {
    q: "What happens to my data?",
    a: "Your catalogue, chats and customer list stay yours, inside your own workspace. Read the privacy policy for the detail.",
  },
];
