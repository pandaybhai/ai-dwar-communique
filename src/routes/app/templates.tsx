import { createFileRoute } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { EmptyState, PageHeader, PageSkeleton } from "@/components/empty-state";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { TemplatesView } from "@/components/templates/templates-view";
import { useNewDesign } from "@/lib/new-design";
import { NewTemplates } from "@/components/templates-v2/new-templates";

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
  component: TemplatesRoute,
});

/**
 * Batch 47: the new design's Templates gallery (src/components/templates-v2)
 * when the workspace has new_design on; otherwise the Batch 41 page below,
 * unchanged.
 */
function TemplatesRoute() {
  return useNewDesign() ? <NewTemplatesPage /> : <TemplatesPage />;
}

function NewTemplatesPage() {
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
  return <NewTemplates />;
}

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
    <>
      <PageHeader
        title="Templates"
        description="Pre-approved messages you can send any time — including outside the 24-hour window."
      />
      <TemplatesView />
    </>
  );
}
