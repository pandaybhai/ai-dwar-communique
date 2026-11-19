import { createFileRoute } from "@tanstack/react-router";
import { Page199 } from "@/components/p199/page-199";
import { getPage199Data } from "@/lib/page-199.functions";
import css199 from "../styles-199.css?inline";

const TITLE = "AiDwar Basic — ₹199 for your first month, set up for you";
const DESCRIPTION =
  "Your AI salesperson on WhatsApp. ₹199 for your first month of AiDwar — our team sets it up for you on a call. Pay Meta directly, zero markup. 7-day money-back. Nothing renews automatically.";

/**
 * Batch 82: the ₹199 paid-trial page — a copy of /999 (routes/999.tsx) with
 * its own page and checkout. Not indexed (noindex,follow) and not in the
 * sitemap, like /999. ?payment=<id> is Cashfree bringing a buyer back after a
 * redirect; ?admin_test_price=1 asks for the ₹1 live test (the server decides);
 * ?resume=1 is the emailed log-in link.
 */
export const Route = createFileRoute("/199")({
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
  loader: () => getPage199Data(),
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
    styles: [{ children: css199 }],
  }),
  component: Route199,
});

function Route199() {
  const { rates, aidenLink } = Route.useLoaderData();
  const { payment, admin_test_price, resume } = Route.useSearch();
  return (
    <Page199
      rates={rates}
      aidenLink={aidenLink}
      returningPaymentId={payment ?? null}
      adminTestPrice={admin_test_price ?? null}
      resume={resume === 1}
    />
  );
}
