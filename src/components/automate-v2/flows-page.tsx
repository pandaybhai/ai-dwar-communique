import { useState } from "react";
import { Lock, Workflow } from "lucide-react";
import { StickyAction } from "@/components/design-v2";
import { EmptyState, PageHeader, PageSkeleton } from "@/components/empty-state";
import { FlowsView } from "@/components/flows/flows-view";
import { SendsLog } from "@/components/flows/sends-log";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { usePermissions } from "@/hooks/use-permissions";
import type { FlowRow } from "@/lib/flows";
import { useOrg } from "@/lib/org-context";
import { ChatFlowsV2, NewChatFlowButton } from "./chat-flows-v2";
import { flowsPage as t } from "./copy";

/**
 * Batch 49: Automate > Flows in the new design. The classic page's gates
 * (the flows flag, flows.view), its three parts and their components: chat
 * flows (Flows v2, drawn as cards with a mini map, trigger, runs and a run
 * history), store flows (FlowsView, unchanged) and what was sent (SendsLog,
 * unchanged). Chat flows come first when Flows v2 is on.
 */
export function NewFlowsPage() {
  const { active, loading } = useOrg();
  const { can, loading: permsLoading } = usePermissions();
  const { enabled, loading: flagLoading } = useFeatureFlag("flows");
  const { enabled: v2 } = useFeatureFlag("flows_v2");
  const [flows, setFlows] = useState<FlowRow[]>([]);
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<string | null>(null);
  const current = tab ?? (v2 ? "chat" : "flows");
  const canCreate = v2 && can("flows_v2.edit") && current === "chat";

  return (
    <>
      <PageHeader
        title={t.title}
        description={t.description}
        {...(canCreate && enabled && can("flows.view")
          ? {
              actions: (
                <StickyAction>
                  <NewChatFlowButton onClick={() => setCreating(true)} />
                </StickyAction>
              ),
            }
          : {})}
      />
      {loading || permsLoading || flagLoading ? (
        <PageSkeleton />
      ) : !active ? (
        <EmptyState icon={Workflow} title={t.noShop.title} description={t.noShop.description} />
      ) : !enabled ? (
        <EmptyState icon={Lock} title={t.notOn.title} description={t.notOn.description} />
      ) : !can("flows.view") ? (
        <EmptyState icon={Lock} title={t.noAccess.title} description={t.noAccess.description} />
      ) : (
        <Tabs value={current} onValueChange={setTab}>
          <TabsList className="mb-6">
            {v2 ? <TabsTrigger value="chat">{t.tabs.chat}</TabsTrigger> : null}
            <TabsTrigger value="flows">{t.tabs.store}</TabsTrigger>
            <TabsTrigger value="log">{t.tabs.log}</TabsTrigger>
          </TabsList>
          {v2 ? (
            <TabsContent value="chat">
              <ChatFlowsV2
                organizationId={active.organization.id}
                createOpen={creating}
                onCreateOpenChange={setCreating}
              />
            </TabsContent>
          ) : null}
          {/* Kept mounted (hidden) so What was sent knows the store flows' names, as on the classic page where this tab opens first. */}
          <TabsContent value="flows" forceMount className="data-[state=inactive]:hidden">
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
      {/* Batch 57: room under the page for the pinned New chat flow button on a phone. */}
      {canCreate && enabled && can("flows.view") ? (
        <div aria-hidden="true" className="hidden h-16 phone:block" />
      ) : null}
    </>
  );
}
