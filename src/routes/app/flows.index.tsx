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

export const Route = createFileRoute("/app/flows/")({
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
        title="Automatic messages"
        description="Let AiDwar message your customers on WhatsApp for you — a reminder when someone leaves items in their cart, an update when their order ships."
      />
      {loading || permsLoading || flagLoading ? (
        <PageSkeleton />
      ) : !active ? (
        <EmptyState
          icon={Workflow}
          title="Pick a shop first"
          description="Choose a shop at the top of the page to see its automatic messages."
        />
      ) : !enabled ? (
        <EmptyState
          icon={Lock}
          title="This isn\u2019t switched on for you yet"
          description="Automatic messages aren't available on your account yet. Ask us or your administrator to switch them on."
        />
      ) : !can("flows.view") ? (
        <EmptyState
          icon={Lock}
          title="You don\u2019t have access to this"
          description="Ask the shop owner to give you permission to see automatic messages."
        />
      ) : (
        <Tabs defaultValue="flows">
          <TabsList className="mb-6">
            <TabsTrigger value="flows">Your flows</TabsTrigger>
            <TabsTrigger value="log">What was sent</TabsTrigger>
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
