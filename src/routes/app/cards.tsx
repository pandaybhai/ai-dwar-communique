import { createFileRoute } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { EmptyState, PageSkeleton } from "@/components/empty-state";
import { useOrg } from "@/lib/org-context";
import { usePermissions } from "@/hooks/use-permissions";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { CardsView } from "@/components/cards/cards-view";
import { useNewDesign } from "@/lib/new-design";
import { NewCards } from "@/components/cards-v2/new-cards";

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
  component: CardsRoute,
});

/**
 * Batch 47: the new design's Cards (src/components/cards-v2) when the
 * workspace has new_design on; otherwise the Batch 41 page below, unchanged.
 */
function CardsRoute() {
  return useNewDesign() ? <NewCardsPage /> : <CardsPage />;
}

/** The same flag and permission checks as the Batch 41 page. */
function NewCardsPage() {
  const { active, loading } = useOrg();
  const { can, loading: permsLoading } = usePermissions();
  const { enabled, loading: flagLoading } = useFeatureFlag("cards");

  if (loading || permsLoading || flagLoading || !active) return <PageSkeleton />;
  if (!enabled || !can("cards.view")) {
    return (
      <EmptyState
        icon={Lock}
        title="You don’t have access to this"
        description="Picture cards are either switched off for your account, or you don't have permission to see them."
      />
    );
  }
  return <NewCards organizationId={active.organization.id} canManage={can("cards.manage")} />;
}

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
