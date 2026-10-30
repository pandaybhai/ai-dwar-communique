import { createFileRoute } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { EmptyState, PageHeader, PageSkeleton } from "@/components/empty-state";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { useOrg } from "@/lib/org-context";
import { CampaignsView } from "@/components/campaigns/campaigns-view";
import { useNewDesign } from "@/lib/new-design";
import { CampaignsOff, NewCampaigns } from "@/components/campaigns-v2/new-campaigns";

type CampaignsSearch = { segment?: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/app/campaigns/")({
  // Batch 51: ?segment=<id> (Customers → Send campaign) opens the new design's
  // wizard with that segment chosen. The classic page ignores it.
  validateSearch: (search: Record<string, unknown>): CampaignsSearch =>
    typeof search["segment"] === "string" && UUID_RE.test(search["segment"])
      ? { segment: search["segment"] }
      : {},
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
  component: CampaignsRoute,
});

/**
 * Batch 47: the new design's Campaigns (src/components/campaigns-v2) when the
 * workspace has new_design on; otherwise the Batch 41 page below, unchanged.
 */
function CampaignsRoute() {
  return useNewDesign() ? <NewCampaignsPage /> : <CampaignsPage />;
}

function NewCampaignsPage() {
  const { enabled, loading } = useFeatureFlag("campaigns");
  const { active, loading: orgLoading } = useOrg();
  const { segment } = Route.useSearch();
  if (loading || orgLoading || !active) return <PageSkeleton />;
  if (!enabled) return <CampaignsOff />;
  return (
    <NewCampaigns
      organizationId={active.organization.id}
      timezone={active.organization.timezone}
      initialSegmentId={segment}
    />
  );
}

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
