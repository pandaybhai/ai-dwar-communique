import { createFileRoute } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { EmptyState, PageHeader, PageSkeleton } from "@/components/empty-state";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { usePermissions } from "@/hooks/use-permissions";
import { useOrg } from "@/lib/org-context";
import { CatalogView } from "@/components/catalog/catalog-view";
import { ProductsSummary } from "@/components/catalog/products-summary";
import { WhatsAppShopCard } from "@/components/catalog/whatsapp-shop-card";
import { CategoryWordsCard } from "@/components/catalog/category-words-card";

// Wording only: the route stays /app/catalog and the flag/permission keys stay "catalog".
const PRODUCTS_DESCRIPTION =
  "Everything your AI employee knows you sell: names, prices, photos and details. We collect them from your website or store automatically, and Aiden uses them to answer customers and show the right pieces.";

export const Route = createFileRoute("/app/catalog/")({
  head: () => ({
    meta: [
      { title: "Products — AiDwar" },
      {
        name: "description",
        content: "Everything you sell: read from your website or store, uploaded, or added by hand.",
      },
      { property: "og:title", content: "Products — AiDwar" },
      {
        property: "og:description",
        content: "Everything you sell: read from your website or store, uploaded, or added by hand.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: CatalogPage,
});

function CatalogPage() {
  const { enabled, loading } = useFeatureFlag("catalogs");
  const { can, loading: permissionsLoading } = usePermissions();
  const { active } = useOrg();
  const organizationId = active?.organization.id ?? null;

  if (loading || permissionsLoading || !organizationId) return <PageSkeleton />;

  if (!enabled) {
    return (
      <>
        <PageHeader title="Products" description={PRODUCTS_DESCRIPTION} />
        <EmptyState
          icon={Lock}
          title="Products are turned off"
          description="This feature isn't enabled for your workspace yet. Reach out to your administrator to switch it on."
        />
      </>
    );
  }

  if (!can("catalog.view")) {
    return (
      <>
        <PageHeader title="Products" description={PRODUCTS_DESCRIPTION} />
        <EmptyState
          icon={Lock}
          title="You don't have access to Products"
          description="Ask an owner or admin of this workspace to give you access to Products."
        />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Products" description={PRODUCTS_DESCRIPTION} />
      <ProductsSummary organizationId={organizationId} />
      <WhatsAppShopCard organizationId={organizationId} />
      <CategoryWordsCard organizationId={organizationId} />
      <CatalogView organizationId={organizationId} />
    </>
  );
}
