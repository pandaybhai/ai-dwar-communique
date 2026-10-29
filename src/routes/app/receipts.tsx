import { createFileRoute } from "@tanstack/react-router";
import { Lock, Receipt } from "lucide-react";
import { EmptyState, PageHeader, PageSkeleton } from "@/components/empty-state";
import { ReceiptsView } from "@/components/receipts/receipts-view";
import { useOrg } from "@/lib/org-context";
import { usePermissions } from "@/hooks/use-permissions";
import { NewReceiptsView } from "@/components/customers-v2/new-receipts-view";
import { useNewDesign } from "@/lib/new-design";

const DESCRIPTION =
  "Which messages made you money — and what they cost. Sales, delivery, clicks and message charges for every campaign and flow.";

export const Route = createFileRoute("/app/receipts")({
  head: () => ({
    meta: [
      { title: "Receipts — AiDwar" },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: "Receipts — AiDwar" },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ReceiptsPage,
});

function ReceiptsPage() {
  const { active, loading } = useOrg();
  const { can, loading: permsLoading } = usePermissions();
  const newDesign = useNewDesign();

  return (
    <>
      <PageHeader
        title="Receipts"
        description="Which messages made you money — and what they cost."
      />
      {loading || permsLoading ? (
        <PageSkeleton />
      ) : !active ? (
        <EmptyState
          icon={Receipt}
          title="No workspace selected"
          description="Pick a workspace from the switcher to see its receipts."
        />
      ) : !can("revenue.view") ? (
        <EmptyState
          icon={Lock}
          title="Receipts are restricted"
          description='You need the "View sales from messages" permission for this workspace. Ask an owner or admin to grant it.'
        />
      ) : newDesign ? (
        // Batch 48: Customers → Sales from chats in the new design, the same data.
        <NewReceiptsView
          organizationId={active.organization.id}
          timezone={active.organization.timezone || "Asia/Kolkata"}
        />
      ) : (
        <ReceiptsView
          organizationId={active.organization.id}
          timezone={active.organization.timezone || "Asia/Kolkata"}
        />
      )}
    </>
  );
}
