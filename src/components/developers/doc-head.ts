import { API_ORIGIN } from "@/lib/public-api";
import type { Page } from "@/lib/developer-portal";

/** A search-result description: the page's own words, with what it is about when they are short; ≤ 160 characters. */
export function metaDescription(page: Page): string {
  let text = page.description;
  if (text.length < 90) {
    if (page.endpoint)
      text = `${text} ${page.endpoint.method} ${page.endpoint.path} — parameters, examples in cURL, Node.js, Python and PHP, responses and errors.`;
    else if (page.event)
      text = `The ${page.event.name} webhook event: ${text} Payload, example and signature check.`;
    else text = `${text} AiDwar WhatsApp API docs.`;
  }
  if (text.length <= 160) return text;
  const cut = text.slice(0, 157);
  return `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

/** Title, description, canonical and social tags for one docs page (Batch 38 item 9). */
export function docHead(page: Page) {
  const title =
    page.kind === "overview"
      ? "AiDwar API — WhatsApp from your own software"
      : `${page.title} · AiDwar API docs`;
  const description = metaDescription(page);
  const url = `${API_ORIGIN}${page.path}`;
  return {
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:type", content: "article" },
      { property: "og:url", content: url },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: url }],
  };
}
