import { createFileRoute } from "@tanstack/react-router";
import { Megaphone, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/empty-state";

export const Route = createFileRoute("/app/campaigns")({
  head: () => ({
    meta: [
      { title: "Campaigns — AiDwar" },
      { name: "description", content: "Create, schedule and track AI-powered broadcast campaigns." },
      { property: "og:title", content: "Campaigns — AiDwar" },
      { property: "og:description", content: "Create, schedule and track AI-powered broadcast campaigns." },
    ],
  }),
  component: CampaignsPage,
});

function CampaignsPage() {
  return (
    <>
      <PageHeader
        title="Campaigns"
        description="Write with AI, pick a segment, schedule it — then watch delivery, reads and replies roll in."
      />
      <EmptyState
        icon={Megaphone}
        title="No campaigns yet"
        description="Your broadcasts will live here. Add contacts and an approved message template to launch your first campaign."
        action={
          <Button className="rounded-full" disabled>
            <Sparkles className="mr-2 h-4 w-4" />
            Create campaign — coming soon
          </Button>
        }
      />
    </>
  );
}
