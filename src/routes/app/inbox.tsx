import { createFileRoute } from "@tanstack/react-router";
import { Inbox, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/empty-state";

export const Route = createFileRoute("/app/inbox")({
  head: () => ({
    meta: [
      { title: "Inbox — AiDwar" },
      { name: "description", content: "Your shared team inbox for business messaging conversations." },
      { property: "og:title", content: "Inbox — AiDwar" },
      { property: "og:description", content: "Your shared team inbox for business messaging conversations." },
    ],
  }),
  component: InboxPage,
});

function InboxPage() {
  return (
    <>
      <PageHeader
        title="Inbox"
        description="One shared place for your whole team to reply to customer conversations, assign chats and close deals."
      />
      <EmptyState
        icon={Inbox}
        title="No conversations yet"
        description="Connect your WhatsApp Business account to start receiving conversations in your shared team inbox."
        action={
          <Button className="rounded-full" disabled>
            <Plug className="mr-2 h-4 w-4" />
            Connect — coming soon
          </Button>
        }
      />
    </>
  );
}
