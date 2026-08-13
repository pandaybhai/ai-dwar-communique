import { createFileRoute } from "@tanstack/react-router";
import { Workflow, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/empty-state";

export const Route = createFileRoute("/app/automations")({
  head: () => ({
    meta: [
      { title: "Automations — AiDwar" },
      { name: "description", content: "Automated replies, follow-ups and AI sales flows that run around the clock." },
      { property: "og:title", content: "Automations — AiDwar" },
      { property: "og:description", content: "Automated replies, follow-ups and AI sales flows that run around the clock." },
    ],
  }),
  component: AutomationsPage,
});

function AutomationsPage() {
  return (
    <>
      <PageHeader
        title="Automations"
        description="Welcome messages, keyword replies, abandoned-cart nudges and AI agent handoffs — all on autopilot."
      />
      <EmptyState
        icon={Workflow}
        title="No automations yet"
        description="Build a flow that greets new customers, answers common questions and follows up while your team sleeps."
        action={
          <Button className="rounded-full" disabled>
            <Zap className="mr-2 h-4 w-4" />
            Create automation — coming soon
          </Button>
        }
      />
    </>
  );
}
