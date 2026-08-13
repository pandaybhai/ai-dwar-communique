import { createFileRoute } from "@tanstack/react-router";
import { MessageSquareText, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/empty-state";

export const Route = createFileRoute("/app/templates")({
  head: () => ({
    meta: [
      { title: "Templates — AiDwar" },
      { name: "description", content: "Create and manage approved message templates for your business." },
      { property: "og:title", content: "Templates — AiDwar" },
      { property: "og:description", content: "Create and manage approved message templates for your business." },
    ],
  }),
  component: TemplatesPage,
});

function TemplatesPage() {
  return (
    <>
      <PageHeader
        title="Templates"
        description="Reusable message templates with variables, buttons and media — submitted for approval and ready to broadcast."
      />
      <EmptyState
        icon={MessageSquareText}
        title="No templates yet"
        description="Draft a template with AI, submit it for approval, and reuse it across every campaign and automation."
        action={
          <Button className="rounded-full" disabled>
            <Plus className="mr-2 h-4 w-4" />
            New template — coming soon
          </Button>
        }
      />
    </>
  );
}
