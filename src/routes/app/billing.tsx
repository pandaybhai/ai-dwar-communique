import { createFileRoute } from "@tanstack/react-router";
import { Lock, Wallet } from "lucide-react";
import { BillingView } from "@/components/billing/billing-view";
import { PlanChooser } from "@/components/billing/plan-chooser";
import { EmptyState, PageHeader, PageSkeleton } from "@/components/empty-state";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { usePermissions } from "@/hooks/use-permissions";
import { useOrg } from "@/lib/org-context";

const DESCRIPTION =
  "Your credits, what each message costs, payments and invoices — all in one place.";

export const Route = createFileRoute("/app/billing")({
  head: () => ({
    meta: [
      { title: "Billing — AiDwar" },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: "Billing — AiDwar" },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: BillingPage,
});

function BillingPage() {
  const { active, loading, reload } = useOrg();
  const { can, loading: permsLoading } = usePermissions();
  const { enabled, loading: flagLoading } = useFeatureFlag("billing");

  const org = active?.organization;
  const noPlan = Boolean(org) && !org?.plan_version_id;
  const locked = org?.plan_status === "locked";

  return (
    <>
      <PageHeader title="Billing" description={DESCRIPTION} />
      {loading || permsLoading || flagLoading ? (
        <PageSkeleton />
      ) : !active || !org ? (
        <EmptyState
          icon={Wallet}
          title="No workspace selected"
          description="Pick a workspace from the switcher to see its billing."
        />
      ) : noPlan || locked ? (
        // Trial and locked workspaces choose (or re-buy) a plan here. This
        // path runs before the billing flag, which the plan itself turns on.
        <div className="space-y-10">
          <PlanChooser
            organizationId={org.id}
            mode={locked ? "locked" : "trial"}
            onActivated={() => void reload()}
          />
          {enabled && can("billing.view") ? <BillingView organizationId={org.id} /> : null}
        </div>
      ) : !enabled ? (
        <EmptyState
          icon={Wallet}
          title="Billing isn't switched on"
          description="This workspace doesn't manage credits here yet. Talk to us if you'd like it turned on."
        />
      ) : !can("billing.view") ? (
        <EmptyState
          icon={Lock}
          title="Billing is restricted"
          description='You need the "View billing" permission for this workspace. Ask an owner or admin to grant it.'
        />
      ) : (
        <BillingView organizationId={org.id} />
      )}
    </>
  );
}
