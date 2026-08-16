import { createFileRoute } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { EmptyState, PageHeader, PageSkeleton } from "@/components/empty-state";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { useOrg } from "@/lib/org-context";
import { AutomationsView } from "@/components/automations/automations-view";
import { usePermissions } from "@/hooks/use-permissions";

const DESCRIPTION =
  "Welcome messages, keyword auto-replies and off-hours cover — one reply per message, always.";

export const Route = createFileRoute("/app/automations")({
  head: () => ({
    meta: [
      { title: "Automations — AiDwar" },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: "Automations — AiDwar" },
      { property: "og:description", content: DESCRIPTION },
    ],
  }),
  component: AutomationsPage,
});

function AutomationsPage() {
  const { enabled, loading } = useFeatureFlag("automations");
  const { active } = useOrg();
  const { can } = usePermissions();
  const canManage = can("automations.manage");
  const organizationId = active?.organization.id ?? null;

  if (loading || !active || !organizationId) return <PageSkeleton />;

  if (!enabled) {
    return (
      <>
        <PageHeader title="Automations" description={DESCRIPTION} />
        <EmptyState
          icon={Lock}
          title="Automations are turned off"
          description="This feature isn't enabled for your workspace yet. Reach out to your administrator to switch it on."
        />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Automations" description={DESCRIPTION} />
      <AutomationsView organizationId={organizationId} canManage={canManage} />
    </>
  );
}
