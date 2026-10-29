import { createFileRoute } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { EmptyState, PageHeader, PageSkeleton } from "@/components/empty-state";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { InboxView } from "@/components/inbox/inbox-view";
import { NewInboxView } from "@/components/inbox/v2/new-inbox-view";
import { useNewDesign } from "@/lib/new-design";
import { InboxTour } from "@/components/onboarding/inbox-tour";

export const Route = createFileRoute("/app/inbox")({
  head: () => ({
    meta: [
      { title: "Inbox — AiDwar" },
      {
        name: "description",
        content: "Your shared team inbox for business messaging conversations.",
      },
      { property: "og:title", content: "Inbox — AiDwar" },
      {
        property: "og:description",
        content: "Your shared team inbox for business messaging conversations.",
      },
    ],
  }),
  component: InboxPage,
});

function InboxPage() {
  const { enabled, loading } = useFeatureFlag("inbox");
  const newDesign = useNewDesign();

  if (loading) {
    return (
      <div className="px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
        <PageSkeleton />
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
        <PageHeader
          title="Inbox"
          description="One shared place for your whole team to reply to customer conversations."
        />
        <EmptyState
          icon={Lock}
          title="Inbox is turned off"
          description="This feature isn't enabled for your workspace yet. Reach out to your administrator to switch it on."
        />
      </div>
    );
  }

  // Batch 39: the Inbox fills the work area (the shell gives it the full
  // height); its title sits on top of the conversation list. Batch 40: the
  // first-day tips float above it, out of the layout. Batch 46: with the
  // new_design flag on, the new Inbox (docs/design/preview.html #inbox).
  return (
    <>
      {newDesign ? <NewInboxView /> : <InboxView />}
      <InboxTour />
    </>
  );
}
