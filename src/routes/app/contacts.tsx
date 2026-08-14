import { createFileRoute } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { EmptyState, PageHeader, PageSkeleton } from "@/components/empty-state";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { useOrg } from "@/lib/org-context";
import { ContactsView } from "@/components/contacts/contacts-view";

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
  const { enabled, loading } = useFeatureFlag("contacts");
  const { active } = useOrg();

  if (loading || !active) return <PageSkeleton />;

  if (!enabled) {
    return (
      <>
        <PageHeader
          title="Contacts"
          description="Your customer list with tags and smart segments."
        />
        <EmptyState
          icon={Lock}
          title="Contacts are turned off"
          description="This feature isn't enabled for your workspace yet. Reach out to your administrator to switch it on."
        />
      </>
    );
  }

  return <ContactsView organizationId={active.organization.id} role={active.role} />;
}
