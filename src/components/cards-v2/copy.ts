/**
 * Batch 57: every word the new Cards screen shows, in one place. Cards keep
 * their name, with a one-line explanation where the page starts. The five
 * designs' own titles, blurbs and the places a card goes come from
 * src/lib/customer-cards.ts and stay as they are.
 */

export const cardsCopy = {
  page: {
    title: "Cards",
    // The one-line explanation of what a card is.
    description:
      "Cards are branded pictures that go out with your campaigns, flows and Aiden’s answers. Set your logo and colours once and every card uses them.",
  },
  loading: "Loading cards",
  designs: {
    heading: "The five cards",
    body: "Send any of them from the Inbox, a flow’s Send card step or a campaign. Aiden can use the Product card when it answers with a product.",
    notDrawn: "Tap Preview to see it",
    alt: (title: string) => `${title} card, as the renderer draws it`,
    fillsIn: (labels: string) => `Fills in: ${labels}`,
    preview: "Preview",
    drawAgain: "Draw again",
    drawFailed: "The card couldn’t be drawn just now. Try again in a moment.",
  },
  brand: {
    heading: "Your brand on every card",
    logo: "Logo picture link",
    logoHint: "A public https picture. Leave it blank and the cards show your name instead.",
    name: "Name on the card",
    namePlaceholder: "Your shop’s name",
    primary: "Main colour",
    accent: "Second colour",
    save: "Save branding",
    saved: "Card branding saved. Every new card uses it from here.",
    noPermission: "Ask the shop owner for permission to change these.",
  },
  uses: {
    heading: "Where cards are used",
    body: "A card goes out only where you add one. If a card can’t be drawn, the plain photo or text goes instead, so your message always arrives.",
    switchLabel: "Product cards in Aiden’s answers and Show products",
    switchHelp:
      "On: the first product goes as a branded Product card, the rest as photos. Off: every product goes as a plain photo with its name and price.",
    on: "Aiden and Show products will send the first product as a card.",
    off: "Aiden and Show products will send plain product photos.",
  },
} as const;
