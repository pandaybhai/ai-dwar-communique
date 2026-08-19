import { createFileRoute } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { EmptyState, PageHeader, PageSkeleton } from "@/components/empty-state";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { usePermissions } from "@/hooks/use-permissions";
import { useOrg } from "@/lib/org-context";
import { CatalogView } from "@/components/catalog/catalog-view";

export const Route = createFileRoute("/app/catalog/")({
  head: () => ({
    meta: [
      { title: "Catalogue — AiDwar" },
      {
        name: "description",
        content: "Your product catalogue: synced from your store, uploaded, or added by hand.",
      },
      { property: "og:title", content: "Catalogue — AiDwar" },
      {
        property: "og:description",
        content: "Your product catalogue: synced from your store, uploaded, or added by hand.",
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
        <PageHeader title="Catalogue" description="Every product you sell, in one place." />
        <EmptyState
          icon={Lock}
          title="The catalogue is turned off"
          description="This feature isn't enabled for your workspace yet. Reach out to your administrator to switch it on."
        />
      </>
    );
  }

  if (!can("catalog.view")) {
    return (
      <>
        <PageHeader title="Catalogue" description="Every product you sell, in one place." />
        <EmptyState
          icon={Lock}
          title="You don't have access to the catalogue"
          description="Ask an owner or admin of this workspace to give you catalogue access."
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Catalogue"
        description="Every product you sell, in one place — so campaigns, flows and your AI employee always quote the right price."
      />
      <CatalogView organizationId={organizationId} />
    </>
  );
}
