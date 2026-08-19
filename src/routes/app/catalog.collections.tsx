import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft, Lock } from "lucide-react";
import { EmptyState, PageHeader, PageSkeleton } from "@/components/empty-state";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { usePermissions } from "@/hooks/use-permissions";
import { useOrg } from "@/lib/org-context";
import { CollectionsView } from "@/components/catalog/collections-view";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/app/catalog/collections")({
  head: () => ({
    meta: [
      { title: "Collections — AiDwar" },
      {
        name: "description",
        content: "Group your products into collections you can reuse in campaigns and flows.",
      },
      { property: "og:title", content: "Collections — AiDwar" },
      {
        property: "og:description",
        content: "Group your products into collections you can reuse in campaigns and flows.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: CollectionsPage,
});

function CollectionsPage() {
  const { enabled, loading } = useFeatureFlag("catalogs");
  const { can, loading: permissionsLoading } = usePermissions();
  const { active } = useOrg();
  const organizationId = active?.organization.id ?? null;

  if (loading || permissionsLoading || !organizationId) return <PageSkeleton />;

  if (!enabled || !can("catalog.view")) {
    return (
      <>
        <PageHeader title="Collections" description="Groups of products you can reuse." />
        <EmptyState
          icon={Lock}
          title="Collections aren't available to you"
          description="Either the catalogue is switched off for this workspace, or you don't have access to it yet."
        />
      </>
    );
  }

  return (
    <>
      <Button variant="ghost" size="sm" className="mb-4 -ml-2" asChild>
        <Link to="/app/catalog">
          <ChevronLeft className="mr-1 h-4 w-4" /> Back to catalogue
        </Link>
      </Button>
      <PageHeader
        title="Collections"
        description="Group products the way you talk about them, then reuse those groups in campaigns and flows."
      />
      <CollectionsView organizationId={organizationId} />
    </>
  );
}
