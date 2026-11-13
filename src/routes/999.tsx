import { createFileRoute } from "@tanstack/react-router";
import { Page999 } from "@/components/p999/page-999";
import { getPage999Data } from "@/lib/page-999.functions";

const TITLE = "AiDwar Basic — your AI salesperson on WhatsApp for ₹999/month";
const DESCRIPTION =
  "Aiden replies to your customers on WhatsApp 24×7. ₹999/month — pay Meta directly, zero markup on messages. 7-day money-back. Live in 10 minutes.";

/**
 * Batch 80: the ₹999 Basic plan's ad landing page. Not indexed
 * (noindex,follow) and not in the sitemap, like /start. ?payment=<id> is
 * Cashfree bringing a buyer back after a redirect: the checkout reopens and
 * confirms that payment.
 */
export const Route = createFileRoute("/999")({
  validateSearch: (search: Record<string, unknown>): { payment?: string } => {
    const v = search["payment"];
    return typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? { payment: v } : {};
  },
  loader: () => getPage999Data(),
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { name: "robots", content: "noindex,follow" },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { name: "theme-color", content: "#04100b" },
    ],
    links: [{ rel: "preconnect", href: "https://sdk.cashfree.com" }],
  }),
  component: Route999,
});

function Route999() {
  const { rates, aidenLink } = Route.useLoaderData();
  const { payment } = Route.useSearch();
  return <Page999 rates={rates} aidenLink={aidenLink} returningPaymentId={payment ?? null} />;
}
