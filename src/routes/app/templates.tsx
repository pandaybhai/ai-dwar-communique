import { createFileRoute } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { EmptyState, PageHeader, PageSkeleton } from "@/components/empty-state";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { TemplatesView } from "@/components/templates/templates-view";

export const Route = createFileRoute("/app/templates")({
  head: () => ({
    meta: [
      { title: "Templates — AiDwar" },
      {
        name: "description",
        content: "Create, submit and manage approved message templates for your business.",
      },
      { property: "og:title", content: "Templates — AiDwar" },
      {
        property: "og:description",
        content: "Create, submit and manage approved message templates for your business.",
      },
    ],
  }),
  component: TemplatesPage,
});

function TemplatesPage() {
  const { enabled, loading } = useFeatureFlag("templates");

  if (loading) return <PageSkeleton />;

  if (!enabled) {
    return (
      <>
        <PageHeader
          title="Templates"
          description="Reusable, pre-approved messages you can send at any time."
        />
        <EmptyState
          icon={Lock}
          title="Templates are turned off"
          description="This feature isn't enabled for your workspace yet. Reach out to your administrator to switch it on."
        />
      </>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">Templates</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pre-approved messages you can send any time — including outside the 24-hour window.
        </p>
      </div>
      <TemplatesView />
    </div>
  );
}
