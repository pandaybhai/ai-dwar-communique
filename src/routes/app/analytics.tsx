import { createFileRoute } from "@tanstack/react-router";
import { BarChart3, Lock } from "lucide-react";
import { AnalyticsView } from "@/components/analytics/analytics-view";
import { EmptyState, PageHeader, PageSkeleton } from "@/components/empty-state";
import { useOrg } from "@/lib/org-context";
import { usePermissions } from "@/hooks/use-permissions";

export const Route = createFileRoute("/app/analytics")({
  head: () => ({
    meta: [
      { title: "Analytics — AiDwar" },
      {
        name: "description",
        content:
          "Delivery, read and reply rates, campaign performance, response times and audience growth for your workspace.",
      },
      { property: "og:title", content: "Analytics — AiDwar" },
      {
        property: "og:description",
        content:
          "Delivery, read and reply rates, campaign performance, response times and audience growth for your workspace.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AnalyticsPage,
});

function AnalyticsPage() {
  const { active, loading } = useOrg();
  const { can, loading: permsLoading } = usePermissions();

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Delivery, read and reply rates, campaign performance, response times and how your audience is growing."
      />
      {loading || permsLoading ? (
        <PageSkeleton />
      ) : !active ? (
        <EmptyState
          icon={BarChart3}
          title="No workspace selected"
          description="Pick a workspace from the switcher to see its analytics."
        />
      ) : !can("analytics.view") ? (
        <EmptyState
          icon={Lock}
          title="Analytics are restricted"
          description='You need the "Analytics" permission for this workspace. Ask an owner or admin to grant it.'
        />
      ) : (
        <AnalyticsView
          organizationId={active.organization.id}
          timezone={active.organization.timezone || "Asia/Kolkata"}
        />
      )}
    </>
  );
}
