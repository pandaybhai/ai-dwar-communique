import { createFileRoute } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { EmptyState, PageHeader, PageSkeleton } from "@/components/empty-state";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { useOrg } from "@/lib/org-context";
import { CampaignsView } from "@/components/campaigns/campaigns-view";

export const Route = createFileRoute("/app/campaigns/")({
  head: () => ({
    meta: [
      { title: "Campaigns — AiDwar" },
      {
        name: "description",
        content: "Create, schedule and track AI-powered broadcast campaigns.",
      },
      { property: "og:title", content: "Campaigns — AiDwar" },
      {
        property: "og:description",
        content: "Create, schedule and track AI-powered broadcast campaigns.",
      },
    ],
  }),
  component: CampaignsPage,
});

function CampaignsPage() {
  const { enabled, loading } = useFeatureFlag("campaigns");
  const { active, loading: orgLoading } = useOrg();

  if (loading || orgLoading) return <PageSkeleton />;

  if (!enabled) {
    return (
      <>
        <PageHeader
          title="Campaigns"
          description="Reach every opted-in customer with one message."
        />
        <EmptyState
          icon={Lock}
          title="Campaigns are turned off"
          description="This feature isn't enabled for your workspace yet. Reach out to your administrator to switch it on."
        />
      </>
    );
  }

  if (!active) return <PageSkeleton />;

  return (
    <>
      <PageHeader
        title="Campaigns"
        description="Pick a segment, choose an approved template, and watch delivery, reads and replies roll in."
      />
      <CampaignsView
        organizationId={active.organization.id}
        timezone={active.organization.timezone}
        role={active.role}
      />
    </>
  );
}
