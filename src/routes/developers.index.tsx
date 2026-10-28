import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { getPublicRates } from "@/lib/public-rates.functions";
import { LEGACY_ANCHORS } from "@/lib/developer-portal";
import { docHeadFor } from "@/components/developers/doc-route";
import { OverviewPage } from "@/components/developers/overview-page";

/**
 * /developers — the API's overview (Batch 38 item 9). Message prices are
 * server-rendered from the same rates as /pricing. An old
 * /developers/api#anchor arrives here (the redirect keeps the #anchor) and
 * is sent on to its new page.
 */
export const Route = createFileRoute("/developers/")({
  loader: async () => {
    const [{ rates }, head] = await Promise.all([getPublicRates(), docHeadFor("/developers")]);
    return { rates, head };
  },
  head: ({ loaderData }) => loaderData?.head ?? {},
  component: Overview,
});

function Overview() {
  const { rates } = Route.useLoaderData();
  const navigate = useNavigate();
  useEffect(() => {
    const anchor = decodeURIComponent(window.location.hash.replace(/^#/, ""));
    const target = anchor ? LEGACY_ANCHORS[anchor] : undefined;
    if (!target) return;
    if (target.endsWith(".json")) window.location.replace(target);
    else void navigate({ to: target as never, replace: true });
  }, [navigate]);
  return <OverviewPage rates={rates} />;
}
