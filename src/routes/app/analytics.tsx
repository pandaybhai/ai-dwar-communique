import { createFileRoute } from "@tanstack/react-router";
import { BarChart3, Lock } from "lucide-react";
import { AnalyticsView } from "@/components/analytics/analytics-view";
import { EmptyState, PageHeader, PageSkeleton } from "@/components/empty-state";
import { useOrg } from "@/lib/org-context";
import { usePermissions } from "@/hooks/use-permissions";
import { useShellSection } from "@/components/shell/section-tabs";

/** Batch 57: Aiden Workspace's words for this page (Classic keeps its own below). */
const ND = {
  title: "Your numbers",
  description:
    "How your messages are doing: how many arrived, were read and got a reply, how campaigns went, how fast your team answers and how your customer list grows.",
  noWorkspaceTitle: "Pick a workspace to see its numbers",
  noWorkspaceBody: "Choose one of your shops from the switcher in your profile menu.",
  restrictedTitle: "You can't see these numbers yet",
  restrictedBody:
    'Seeing them needs the "Analytics" permission for this workspace. Ask an owner or admin to give it to you.',
};

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
  // Batch 57: only the new shell provides a section, so Classic is exactly as before.
  const nd = useShellSection() !== null;

  return (
    <>
      <PageHeader
        title={nd ? ND.title : "Analytics"}
        description={
          nd
            ? ND.description
            : "Delivery, read and reply rates, campaign performance, response times and how your audience is growing."
        }
      />
      {loading || permsLoading ? (
        <PageSkeleton />
      ) : !active ? (
        <EmptyState
          icon={BarChart3}
          title={nd ? ND.noWorkspaceTitle : "No workspace selected"}
          description={
            nd ? ND.noWorkspaceBody : "Pick a workspace from the switcher to see its analytics."
          }
        />
      ) : !can("analytics.view") ? (
        <EmptyState
          icon={Lock}
          title={nd ? ND.restrictedTitle : "Analytics are restricted"}
          description={
            nd
              ? ND.restrictedBody
              : 'You need the "Analytics" permission for this workspace. Ask an owner or admin to grant it.'
          }
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
