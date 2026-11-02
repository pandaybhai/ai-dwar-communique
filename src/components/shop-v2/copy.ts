/**
 * Batch 57: every word the new Shop screens (Catalogue overview, Collections)
 * show, in one place, so a later Hindi pass is one file. Plain objects and
 * functions only (plurals are functions); nothing here reads or writes.
 * Prices, counts and the classic components' own words do not change.
 */

const count = new Intl.NumberFormat("en-IN");

export const cataloguePage = {
  title: "Catalogue",
  description:
    "Everything you sell, with names, prices and photos. Read from your website or store, uploaded, or added by hand. Aiden uses this list to answer customers and show the right products.",
  notOn: {
    title: "The catalogue isn't on for your workspace yet",
    description: "Ask us or your admin to switch it on.",
  },
  noAccess: {
    title: "You don't have access to the catalogue",
    description: "Ask the shop owner or an admin to give you access.",
  },
} as const;

export const overviewCopy = {
  loading: "Loading your catalogue",
  heading: "Your catalogue",
  productsWord: (n: number) => (n === 1 ? "product" : "products"),
  lastChange: (when: string) => `Last change ${when}.`,
  nothingYet: "Nothing added yet.",
  usedBy: "Aiden, your campaigns and your WhatsApp shop all use this list.",
  refresh: "Refresh from website",
  reading: "Reading your website…",
  /** ProductsSummary's message after Refresh from website, unchanged. */
  refreshStarted:
    "Reading your website for changes. New products and photos show up here when it's done.",
  stats: {
    website: "From your website",
    store: "From your store",
    hidden: "Hidden from customers",
    noPhoto: "Without a photo",
  },
  collections: (n: number) =>
    `${count.format(n)} ${n === 1 ? "collection groups" : "collections group"} these for campaigns and flows. `,
  noCollections: "No collections yet. A collection is a group of products you can send in one go. ",
  seeCollections: "See collections",
  makeOne: "Make one",
  shopHeading: "WhatsApp shop",
  shopLine: "How your products look to a customer in WhatsApp.",
  shopLineEmpty: "Products with a photo show here as a customer sees them in WhatsApp.",
  phoneLabel: "Your products in a WhatsApp chat",
  phoneMessage: "Take a look at our shop. Tap a product to see it, or add it to your cart.",
  phoneButton: "View catalogue",
  priceOnRequest: "Price on request",
} as const;

export const collectionsPage = {
  title: "Collections",
  description:
    "Group products the way you talk about them, then reuse those groups in campaigns and flows.",
  shortDescription: "Groups of products you can reuse.",
  blocked: {
    title: "Collections aren't available to you",
    description:
      "Either the catalogue is switched off for this workspace, or you don't have access to it yet.",
  },
  loading: "Loading your collections",
  count: (n: number) => `${count.format(n)} ${n === 1 ? "product" : "products"}`,
  manage: "Manage collections",
} as const;
