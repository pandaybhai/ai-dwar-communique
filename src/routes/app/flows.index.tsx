import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Lock, Workflow } from "lucide-react";
import { EmptyState, PageHeader, PageSkeleton } from "@/components/empty-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useOrg } from "@/lib/org-context";
import { usePermissions } from "@/hooks/use-permissions";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { FlowsView } from "@/components/flows/flows-view";
import { SendsLog } from "@/components/flows/sends-log";
import type { FlowRow } from "@/lib/flows";

export const Route = createFileRoute("/app/flows")({
  head: () => ({
    meta: [
      { title: "Flows — AiDwar" },
      {
        name: "description",
        content:
          "Scheduled messaging flows: abandoned checkout recovery and order lifecycle updates, with a full log of every send, skip and cancellation.",
      },
      { property: "og:title", content: "Flows — AiDwar" },
      {
        property: "og:description",
        content:
          "Scheduled messaging flows with delays, quiet hours, frequency caps and a full send log.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: FlowsPage,
});

function FlowsPage() {
  const { active, loading } = useOrg();
  const { can, loading: permsLoading } = usePermissions();
  const { enabled, loading: flagLoading } = useFeatureFlag("flows");
  const [flows, setFlows] = useState<FlowRow[]>([]);

  return (
    <>
      <PageHeader
        title="Flows"
        description="Turn store events into messages — a nudge when a checkout is abandoned, an update when an order ships."
      />
      {loading || permsLoading || flagLoading ? (
        <PageSkeleton />
      ) : !active ? (
        <EmptyState
          icon={Workflow}
          title="No workspace selected"
          description="Pick a workspace from the switcher to see its flows."
        />
      ) : !enabled ? (
        <EmptyState
          icon={Lock}
          title="Flows are turned off"
          description="This feature isn't enabled for your workspace yet. Ask your administrator to switch it on."
        />
      ) : !can("flows.view") ? (
        <EmptyState
          icon={Lock}
          title="Flows are restricted"
          description='You need the "View flows" permission for this workspace. Ask an owner or admin to grant it.'
        />
      ) : (
        <Tabs defaultValue="flows">
          <TabsList className="mb-6">
            <TabsTrigger value="flows">Flows</TabsTrigger>
            <TabsTrigger value="log">Sends log</TabsTrigger>
          </TabsList>
          <TabsContent value="flows">
            <FlowsView organizationId={active.organization.id} onLoaded={setFlows} />
          </TabsContent>
          <TabsContent value="log">
            <SendsLog
              organizationId={active.organization.id}
              flows={flows}
              timezone={active.organization.timezone || "Asia/Kolkata"}
            />
          </TabsContent>
        </Tabs>
      )}
    </>
  );
}
