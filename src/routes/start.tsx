import { createFileRoute } from "@tanstack/react-router";
import { StartPage } from "@/components/start/start-page";
import { getPublicPlans } from "@/lib/public-plans.functions";

const TITLE = "AiDwar — WhatsApp marketing and AI replies for your business";
const DESCRIPTION =
  "Send offers that get opened, let AI reply to every customer 24×7, and win back buyers who went quiet — all from your own WhatsApp number. Free trial, no card needed.";

/**
 * Batch 72: the Meta-ads landing page. Not indexed (noindex,follow) and not
 * in the sitemap; prices come from the public plans, never hard-coded.
 */
export const Route = createFileRoute("/start")({
  loader: () => getPublicPlans(),
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { name: "robots", content: "noindex,follow" },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
    ],
  }),
  component: StartRoute,
});

function StartRoute() {
  const { plans, gst_registered } = Route.useLoaderData();
  return <StartPage plans={plans} gstRegistered={gst_registered === true} />;
}
