import { useCallback, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { EmptyState, PageHeader, PageSkeleton } from "@/components/empty-state";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { useOrg } from "@/lib/org-context";
import { aidwar } from "@/integrations/aidwar/client";
import type { TagRow } from "@/lib/contacts";
import { ContactsView } from "@/components/contacts/contacts-view";
import { SegmentsView } from "@/components/segments/segments-view";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type ContactsSearch = { opt_in?: string; tab?: "segments" };

export const Route = createFileRoute("/app/contacts")({
  validateSearch: (search: Record<string, unknown>): ContactsSearch => {
    const value = typeof search["opt_in"] === "string" ? (search["opt_in"] as string) : undefined;
    const out: ContactsSearch =
      value && ["unknown", "opted_in", "opted_out"].includes(value) ? { opt_in: value } : {};
    // Batch 44: ?tab=segments opens Segments (the new shell's Customers → Segments).
    if (search["tab"] === "segments") out.tab = "segments";
    return out;
  },
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
  const { opt_in: optInParam, tab } = Route.useSearch();
  const { enabled, loading } = useFeatureFlag("contacts");
  const { active } = useOrg();
  const organizationId = active?.organization.id ?? null;

  const [tags, setTags] = useState<TagRow[]>([]);
  const [attributeKeys, setAttributeKeys] = useState<string[]>([]);

  const loadMeta = useCallback(async () => {
    if (!organizationId) return;
    const [{ data: tagRows }, { data: contactRows }] = await Promise.all([
      aidwar.from("tags").select("id, name, color").eq("organization_id", organizationId).order("name"),
      aidwar
        .from("contacts")
        .select("attributes")
        .eq("organization_id", organizationId)
        .not("attributes", "is", null)
        .limit(300),
    ]);
    setTags((tagRows as TagRow[]) ?? []);
    const keys = new Set<string>();
    for (const row of ((contactRows as { attributes: Record<string, unknown> | null }[]) ?? [])) {
      for (const key of Object.keys(row.attributes ?? {})) keys.add(key);
    }
    setAttributeKeys(Array.from(keys).sort());
  }, [organizationId]);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  if (loading || !active || !organizationId) return <PageSkeleton />;

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

  return (
    <>
      <PageHeader
        title="Contacts"
        description="Your customer list with tags and smart segments, so every campaign reaches exactly the right people."
      />
      <Tabs key={tab ?? "contacts"} defaultValue={tab ?? "contacts"}>
        {/* The new design shows these as the Customers sub-tabs in the page head. */}
        <TabsList className="mb-6 nd:hidden">
          <TabsTrigger value="contacts">All contacts</TabsTrigger>
          <TabsTrigger value="segments">Segments</TabsTrigger>
        </TabsList>
        <TabsContent value="contacts">
          <ContactsView
            organizationId={organizationId}
            role={active.role}
            showHeader={false}
            initialOptIn={optInParam ?? "all"}
          />
        </TabsContent>
        <TabsContent value="segments">
          <SegmentsView
            organizationId={organizationId}
            role={active.role}
            tags={tags}
            attributeKeys={attributeKeys}
          />
        </TabsContent>
      </Tabs>
    </>
  );
}
