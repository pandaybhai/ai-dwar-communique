import { createFileRoute } from "@tanstack/react-router";
import { Contact, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/empty-state";

export const Route = createFileRoute("/app/contacts")({
  head: () => ({
    meta: [
      { title: "Contacts — AiDwar" },
      { name: "description", content: "Manage your contacts, tags and segments in AiDwar." },
      { property: "og:title", content: "Contacts — AiDwar" },
      { property: "og:description", content: "Manage your contacts, tags and segments in AiDwar." },
    ],
  }),
  component: ContactsPage,
});

function ContactsPage() {
  return (
    <>
      <PageHeader
        title="Contacts"
        description="Your customer list with tags and smart segments, so every campaign reaches exactly the right people."
      />
      <EmptyState
        icon={Contact}
        title="No contacts yet"
        description="Import your customer list from a CSV or let contacts flow in automatically from conversations."
        action={
          <Button className="rounded-full" disabled>
            <Upload className="mr-2 h-4 w-4" />
            Import contacts — coming soon
          </Button>
        }
      />
    </>
  );
}
