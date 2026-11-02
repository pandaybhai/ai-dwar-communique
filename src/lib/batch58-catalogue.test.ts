import { describe, expect, it } from "vitest";
import { memoryDb } from "@/lib/test-support/memory-db";
import {
  extractProduct,
  isInfoPageUrl,
  isNonProductPage,
  saveCrawledProducts,
  structuredProduct,
  type ProductDraft,
} from "@/lib/product-extract.server";

/**
 * Batch 58 item 4: legal / policy / help pages never become products. Real
 * shapes of Shopify and WooCommerce pages, each with a price in its text or
 * product-like markup — the very thing that made "7. Limitation of
 * liability ₹5,000" a product off aidwar.in/terms.
 */

const ORG = "org-b58";
const pad = " ".repeat(300);
const shopify = (title: string, h1: string, body: string, extraHead = "") =>
  `<!doctype html><html><head><title>${title}</title>${extraHead}</head><body><header><nav>Shop · Rings · Contact</nav></header><main><h1>${h1}</h1>${body}</main><footer>© Zoori</footer>${pad}</body></html>`;

const productLd = (name: string, price: number) =>
  `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name,
    image: "https://cdn.shopify.com/s/files/gift-card.jpg",
    offers: { "@type": "Offer", price, priceCurrency: "INR", availability: "https://schema.org/InStock" },
  })}</script>`;

const NOT_PRODUCTS: Array<[string, string]> = [
  // Shopify information pages, with prices and pictures in their text.
  [
    "https://zoori.in/pages/contact",
    shopify("Contact – Zoori", "Contact us", '<p>Free shipping on orders above ₹999.</p><img src="https://cdn.shopify.com/s/files/store.jpg"><form>…</form>'),
  ],
  [
    "https://zoori.in/pages/about-us",
    shopify("About us | Zoori", "Our story", '<p>Started in 2019 with ₹50,000 and a single ring.</p><img src="https://cdn.shopify.com/s/files/founders.jpg">'),
  ],
  [
    "https://zoori.in/pages/faq",
    shopify("FAQ – Zoori", "Frequently asked questions", "<h3>1. How much is delivery?</h3><p>₹99 below ₹999, free above.</p>"),
  ],
  [
    "https://zoori.in/pages/cancellation-policy",
    shopify("Cancellation policy – Zoori", "Cancellation policy", "<h3>3. Fees</h3><p>A ₹250 fee applies after dispatch.</p>"),
  ],
  [
    "https://zoori.in/blogs/news/diwali-gift-guide",
    shopify("Diwali gift guide – Zoori", "Diwali gift guide", '<p>Our pick under ₹5,000.</p><img src="https://cdn.shopify.com/s/files/guide.jpg">', productLd("Diwali gift guide", 4999)),
  ],
  [
    "https://zoori.in/careers",
    shopify("Careers – Zoori", "Work with us", "<p>Stipend ₹15,000 a month.</p>"),
  ],
  // WooCommerce-style addresses at the site root.
  ["https://shop.example.in/contact-us/", shopify("Contact Us - Example Store", "Get in touch", "<p>COD charges ₹49.</p>")],
  ["https://shop.example.in/help-center/", shopify("Help Center - Example Store", "Help", "<p>Refunds over ₹2,000 take 5 days.</p>")],
  ["https://shop.example.in/about/", shopify("About - Example Store", "About", "<p>₹10 of every order goes to charity.</p>")],
  // Legal pages (kept from Batch 11): terms with the live clause, refund, shipping, privacy.
  [
    "https://aidwar.in/terms",
    shopify("Terms of Service — AiDwar", "Terms of Service", "<h2>7. Limitation of liability</h2><p>Our total liability is limited to ₹5,000 or the fees paid.</p>"),
  ],
  ["https://zoori.in/policies/refund-policy", shopify("Refund policy – Zoori", "Refund policy", "<p>Refunds above ₹1,000 by bank transfer.</p>")],
  ["https://zoori.in/policies/shipping-policy", shopify("Shipping policy – Zoori", "Shipping", "<p>₹99 shipping.</p>")],
  ["https://zoori.in/policies/privacy-policy", shopify("Privacy policy – Zoori", "Privacy", "<p>₹0.</p>")],
  // An information page at an address that doesn't say so: the title does.
  ["https://shop.example.in/p/12/", shopify("Frequently Asked Questions | Example Store", "FAQs", "<p>Delivery ₹49.</p>")],
];

describe("legal, policy and information pages never give a product", () => {
  it.each(NOT_PRODUCTS)("%s", (url, html) => {
    expect(isNonProductPage(url, html)).toBe(true);
    expect(extractProduct(html, url)).toBeNull();
    expect(structuredProduct(html, url)).toBeNull();
  });

  it("real product pages still read — including names and shelves that contain those words", () => {
    const cases: Array<[string, string, string, number]> = [
      ["https://zoori.in/products/golden-petal-ring", "Golden Petal Ring – Zoori", "Golden Petal Ring", 12499],
      ["https://desk.example.in/products/help-desk-bell", "Help Desk Bell – Desk Co", "Help Desk Bell", 349],
      ["https://belts.example.in/collections/support/products/back-support-belt", "Back Support Belt – Belts", "Back Support Belt", 899],
      ["https://glow.example.in/products/about-face-serum", "About Face Serum – Glow", "About Face Serum", 1299],
      ["https://news.example.in/products/news-flash-earrings", "News Flash Earrings – Studio", "News Flash Earrings", 799],
      ["https://kitchen.example.in/press-machine/", "Press – Hydraulic Oil Press – Kitchen", "Hydraulic Oil Press", 15999],
    ];
    for (const [url, title, h1, price] of cases) {
      const html = shopify(
        title,
        h1,
        `<div class="price">₹${price.toLocaleString("en-IN")}</div><img src="https://cdn.example.in/${h1.replace(/\s+/g, "-")}.jpg" class="product-image">`,
      );
      expect(isNonProductPage(url, html), url).toBe(false);
      const draft = extractProduct(html, url);
      expect(draft?.title, url).toBe(h1);
      expect(draft?.price, url).toBe(price);
    }
  });

  it("address rules: only the first segment, or the one after pages/page/info", () => {
    for (const u of ["https://x.in/contact", "https://x.in/pages/contact-us", "https://x.in/page/faqs", "https://x.in/info/about-us", "https://x.in/blogs/news/a", "https://x.in/blog/a", "https://x.in/jobs", "https://x.in/pages/cancellations"])
      expect(isInfoPageUrl(u), u).toBe(true);
    for (const u of ["https://x.in/products/contact-lens-case", "https://x.in/collections/blog-favourites", "https://x.in/collections/support/products/belt", "https://x.in/products/faq-card", "https://x.in/", "not a url"])
      expect(isInfoPageUrl(u), u).toBe(false);
  });
});

describe("saveCrawledProducts is the last check on every crawler path", () => {
  const draft = (over: Partial<ProductDraft>): ProductDraft => ({
    externalId: "https://zoori.in/products/ring",
    title: "Ring",
    price: 100,
    currency: "INR",
    imageUrl: null,
    productUrl: "https://zoori.in/products/ring",
    category: null,
    gender: null,
    availability: "in_stock",
    sku: null,
    brand: null,
    ...over,
  });

  it("never writes a product from a policy/information address or with a clause title; a real one is saved", async () => {
    const db = memoryDb({ products: [] });
    const saved = await saveCrawledProducts(db.supabase, ORG, [
      draft({ externalId: "https://aidwar.in/terms", productUrl: "https://aidwar.in/terms", title: "7. Limitation of liability", price: 5000 }),
      draft({ externalId: "https://aidwar.in/p/9", productUrl: "https://aidwar.in/p/9", title: "4. Payment terms" }),
      draft({ externalId: "https://zoori.in/pages/contact", productUrl: "https://zoori.in/pages/contact", title: "Visit our store" }),
      draft({ externalId: "https://zoori.in/blogs/news/gift-guide", productUrl: "https://zoori.in/blogs/news/gift-guide", title: "Gift guide" }),
      draft({}),
    ]);
    expect(saved).toBe(1);
    expect(db.rows("products").map((p) => p["title"])).toEqual(["Ring"]);
  });

  it("an existing row at such an address is left exactly as it is (no live data deleted by code)", async () => {
    const db = memoryDb({
      products: [{ id: "p-terms", organization_id: ORG, source: "crawl", external_id: "https://aidwar.in/terms", title: "7. Limitation of liability", price: 5000, is_visible: true }],
    });
    await saveCrawledProducts(db.supabase, ORG, [
      draft({ externalId: "https://aidwar.in/terms", productUrl: "https://aidwar.in/terms", title: "7. Limitation of liability", price: 6000 }),
    ]);
    expect(db.rows("products")).toEqual([
      expect.objectContaining({ id: "p-terms", price: 5000, is_visible: true }),
    ]);
  });
});
