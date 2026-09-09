import { createFileRoute } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { EmptyState, PageSkeleton } from "@/components/empty-state";
import { useOrg } from "@/lib/org-context";
import { usePermissions } from "@/hooks/use-permissions";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { CardsView } from "@/components/cards/cards-view";

export const Route = createFileRoute("/app/cards")({
  head: () => ({
    meta: [
      { title: "Cards — AiDwar" },
      {
        name: "description",
        content: "Branded picture cards for offers, products, order updates, receipts and appointments.",
      },
      { property: "og:title", content: "Cards — AiDwar" },
      {
        property: "og:description",
        content: "Branded picture cards for offers, products, order updates, receipts and appointments.",
      },
    ],
  }),
  component: CardsPage,
});

function CardsPage() {
  const { active, loading } = useOrg();
  const { can, loading: permsLoading } = usePermissions();
  const { enabled, loading: flagLoading } = useFeatureFlag("cards");

  if (loading || permsLoading || flagLoading) return <PageSkeleton />;
  if (!active) return <PageSkeleton />;
  if (!enabled || !can("cards.view")) {
    return (
      <EmptyState
        icon={Lock}
        title="You don’t have access to this"
        description="Picture cards are either switched off for your account, or you don't have permission to see them."
      />
    );
  }

  return <CardsView organizationId={active.organization.id} canManage={can("cards.manage")} />;
}
