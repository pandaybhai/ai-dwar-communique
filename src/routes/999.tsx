import { createFileRoute } from "@tanstack/react-router";
import { Page999 } from "@/components/p999/page-999";
import { getPage999Data } from "@/lib/page-999.functions";
import css999 from "../styles-999.css?inline";

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
  validateSearch: (
    search: Record<string, unknown>,
  ): { payment?: string; admin_test_price?: 1; resume?: 1 } => {
    const v = search["payment"];
    // Batch 80b: ?admin_test_price=1 asks for the ₹1 live test; only the
    // server decides (Super Admin), the page just passes it on.
    const admin = String(search["admin_test_price"] ?? "") === "1";
    return {
      ...(typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? { payment: v } : {}),
      ...(admin ? { admin_test_price: 1 as const } : {}),
      // Batch 81: back from the emailed one-time log-in link.
      ...(String(search["resume"] ?? "") === "1" ? { resume: 1 as const } : {}),
    };
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
    // Batch 81: first-paint CSS for this page (see styles-999.css).
    styles: [{ children: css999 }],
  }),
  component: Route999,
});

function Route999() {
  const { rates, aidenLink } = Route.useLoaderData();
  const { payment, admin_test_price, resume } = Route.useSearch();
  return (
    <Page999
      rates={rates}
      aidenLink={aidenLink}
      returningPaymentId={payment ?? null}
      adminTestPrice={admin_test_price ?? null}
      resume={resume === 1}
    />
  );
}
