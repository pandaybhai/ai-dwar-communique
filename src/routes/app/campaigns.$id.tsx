import { createFileRoute } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/empty-state";
import { useOrg } from "@/lib/org-context";
import { CampaignDetail } from "@/components/campaigns/campaign-detail";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { useNewDesign } from "@/lib/new-design";
import { CampaignsOff, NewCampaigns } from "@/components/campaigns-v2/new-campaigns";

export const Route = createFileRoute("/app/campaigns/$id")({
  head: () => ({
    meta: [
      { title: "Campaign — AiDwar" },
      {
        name: "description",
        content: "Live delivery, read and reply performance for this broadcast.",
      },
      { property: "og:title", content: "Campaign — AiDwar" },
      {
        property: "og:description",
        content: "Live delivery, read and reply performance for this broadcast.",
      },
    ],
  }),
  component: CampaignDetailRoute,
});

/**
 * Batch 47: with new_design on a campaign opens inside the new Campaigns
 * screen (list, results, phone); otherwise the Batch 41 results page below.
 */
function CampaignDetailRoute() {
  return useNewDesign() ? <NewCampaignDetailPage /> : <CampaignDetailPage />;
}

function NewCampaignDetailPage() {
  const { id } = Route.useParams();
  const { enabled, loading: flagLoading } = useFeatureFlag("campaigns");
  const { active, loading } = useOrg();
  if (loading || flagLoading || !active) return <PageSkeleton />;
  if (!enabled) return <CampaignsOff />;
  return (
    <NewCampaigns
      organizationId={active.organization.id}
      timezone={active.organization.timezone}
      selectedId={id}
    />
  );
}

function CampaignDetailPage() {
  const { id } = Route.useParams();
  const { active, loading } = useOrg();
  if (loading || !active) return <PageSkeleton />;
  return (
    <CampaignDetail
      campaignId={id}
      organizationId={active.organization.id}
      role={active.role}
      timezone={active.organization.timezone}
    />
  );
}
