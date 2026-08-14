import { createFileRoute } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/empty-state";
import { useOrg } from "@/lib/org-context";
import { CampaignDetail } from "@/components/campaigns/campaign-detail";

export const Route = createFileRoute("/app/campaigns/$id")({
  head: () => ({
    meta: [
      { title: "Campaign — AiDwar" },
      { name: "description", content: "Live delivery, read and reply performance for this broadcast." },
      { property: "og:title", content: "Campaign — AiDwar" },
      { property: "og:description", content: "Live delivery, read and reply performance for this broadcast." },
    ],
  }),
  component: CampaignDetailPage,
});

function CampaignDetailPage() {
  const { id } = Route.useParams();
  const { active, loading } = useOrg();
  if (loading || !active) return <PageSkeleton />;
  return (
    <CampaignDetail campaignId={id} organizationId={active.organization.id} role={active.role} />
  );
}
