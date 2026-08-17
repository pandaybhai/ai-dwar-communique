import { createFileRoute } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { EmptyState, PageSkeleton } from "@/components/empty-state";
import { useOrg } from "@/lib/org-context";
import { usePermissions } from "@/hooks/use-permissions";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { FlowDetail } from "@/components/flows/flow-detail";

export const Route = createFileRoute("/app/flows/$id")({
  head: () => ({
    meta: [
      { title: "Flow — AiDwar" },
      {
        name: "description",
        content: "Steps, templates, delays and the full send log for this messaging flow.",
      },
      { property: "og:title", content: "Flow — AiDwar" },
      {
        property: "og:description",
        content: "Steps, templates, delays and the full send log for this messaging flow.",
      },
    ],
  }),
  component: FlowDetailPage,
});

function FlowDetailPage() {
  const { id } = Route.useParams();
  const { active, loading } = useOrg();
  const { can, loading: permsLoading } = usePermissions();
  const { enabled, loading: flagLoading } = useFeatureFlag("flows");

  if (loading || permsLoading || flagLoading || !active) return <PageSkeleton />;
  if (!enabled || !can("flows.view")) {
    return (
      <EmptyState
        icon={Lock}
        title="You don\u2019t have access to this"
        description="Automatic messages are either switched off for your account, or you don't have permission to see them."
      />
    );
  }

  return (
    <FlowDetail
      flowId={id}
      organizationId={active.organization.id}
      timezone={active.organization.timezone || "Asia/Kolkata"}
    />
  );
}
