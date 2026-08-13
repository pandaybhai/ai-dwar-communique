import { createFileRoute } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { EmptyState, PageHeader, PageSkeleton } from "@/components/empty-state";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { InboxView } from "@/components/inbox/inbox-view";

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

  if (loading) return <PageSkeleton />;

  if (!enabled) {
    return (
      <>
        <PageHeader
          title="Inbox"
          description="One shared place for your whole team to reply to customer conversations."
        />
        <EmptyState
          icon={Lock}
          title="Inbox is turned off"
          description="This feature isn't enabled for your workspace yet. Reach out to your administrator to switch it on."
        />
      </>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">Inbox</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          One shared place for your whole team to reply, assign and close conversations.
        </p>
      </div>
      <InboxView />
    </div>
  );
}
