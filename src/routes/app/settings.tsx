import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Loader2, UserPlus, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ErrorState, PageHeader } from "@/components/empty-state";
import { aidwar } from "@/integrations/aidwar/client";
import { logActivity } from "@/lib/activity";
import { useOrg } from "@/lib/org-context";
import { usePermissions } from "@/hooks/use-permissions";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { TeamSettings } from "@/components/team/team-settings";
import { WhatsAppTab } from "@/components/whatsapp-settings";
import { LeadSourcesTab } from "@/components/contacts/lead-sources-settings";
import { OptOutKeywordsCard } from "@/components/contacts/opt-out-keywords-settings";
import { DeleteWorkspaceCard } from "@/components/settings/delete-workspace-card";
import { IntegrationsTab } from "@/components/integrations/integrations-settings";
import { FlowConnections } from "@/components/integrations/flow-connections";
import { SendSettingsTab } from "@/components/settings/send-settings";
import { ApiSettingsTab } from "@/components/settings/api-settings";
import { ApiConsoleCard } from "@/components/settings/api-console";
import { NewSettingsPage } from "@/components/settings-v2/new-settings";
import { useNewDesign } from "@/lib/new-design";

export const Route = createFileRoute("/app/settings")({
  head: () => ({
    meta: [
      { title: "Settings — AiDwar" },
      {
        name: "description",
        content: "Manage your AiDwar workspace, team members and connections.",
      },
      { property: "og:title", content: "Settings — AiDwar" },
      {
        property: "og:description",
        content: "Manage your AiDwar workspace, team members and connections.",
      },
    ],
  }),
  component: SettingsRoute,
});

/**
 * Batch 50: with new_design on, the new Settings (left sub-nav, section
 * cards); off, the classic tabs below exactly as before. Both use the same
 * cards, and the Workspace form is the classic GeneralTab itself.
 */
function SettingsRoute() {
  return useNewDesign() ? <NewSettingsPage workspace={<GeneralTab />} /> : <SettingsPage />;
}

function SettingsPage() {
  const { active, loading, error } = useOrg();
  const tabParam = useRouterState({
    select: (st) => (st.location.search as Record<string, unknown>)["tab"] as string | undefined,
  });

  return (
    <>
      <PageHeader
        title="Settings"
        description="Workspace details, your team, and the connections that power your messaging."
      />
      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-10 w-72 rounded-xl" />
          <Skeleton className="h-64 w-full rounded-2xl" />
        </div>
      ) : error ? (
        <ErrorState message={error} />
      ) : !active ? (
        <ErrorState message="We couldn't find your workspace. Please refresh the page." />
      ) : (
        // Batch 44: a new ?tab= (the avatar menu's Team, Shop → Shopify) opens that tab.
        <SettingsTabs key={tabParam ?? ""} />
      )}
    </>
  );
}

/** The tab the address asks for: ?tab=<name> (the docs link to ?tab=api), or Google's return to Integrations. */
function initialTab(showIntegrations: boolean): string {
  if (typeof window === "undefined") return "general";
  const q = new URLSearchParams(window.location.search);
  const asked = q.get("tab");
  const tabs = ["general", "team", "whatsapp", "integrations", "sending", "sources", "api"];
  if (asked && tabs.includes(asked)) return asked;
  return q.has("google") && showIntegrations ? "integrations" : "general";
}

/** Tabs, with integrations appearing only where the feature is switched on. */
function SettingsTabs() {
  const { enabled: shopifyEnabled } = useFeatureFlag("shopify");
  const { can } = usePermissions();
  const { enabled: flowsV2Enabled } = useFeatureFlag("flows_v2");
  const showShopify = shopifyEnabled && can("integrations.view");
  const showConnections = flowsV2Enabled && can("integrations.view");
  const showIntegrations = showShopify || showConnections;
  const { enabled: flowsEnabled } = useFeatureFlag("flows");
  const showSending = flowsEnabled && can("flows.view");
  const { enabled: publicApiEnabled } = useFeatureFlag("public_api");
  const showApi = publicApiEnabled && can("public_api.manage");

  return (
    <Tabs defaultValue={initialTab(showIntegrations)} className="max-w-3xl">
      <TabsList>
        <TabsTrigger value="general">General</TabsTrigger>
        <TabsTrigger value="team">Team</TabsTrigger>
        <TabsTrigger value="whatsapp">WhatsApp</TabsTrigger>
        {showIntegrations ? <TabsTrigger value="integrations">Integrations</TabsTrigger> : null}
        {showSending ? <TabsTrigger value="sending">Sending</TabsTrigger> : null}
        <TabsTrigger value="sources">Lead sources</TabsTrigger>
        {showApi ? <TabsTrigger value="api">API & webhooks</TabsTrigger> : null}
      </TabsList>
      <TabsContent value="general" className="mt-6 space-y-6">
        <GeneralTab />
        <DeleteWorkspaceCard />
      </TabsContent>

      <TabsContent value="team" className="mt-6">
        <TeamSettings />
      </TabsContent>
      <TabsContent value="whatsapp" className="mt-6">
        <WhatsAppTab />
      </TabsContent>
      {showIntegrations ? (
        <TabsContent value="integrations" className="mt-6">
          <div className="space-y-6">
            {showShopify ? <IntegrationsTab /> : null}
            {showConnections ? <FlowConnections /> : null}
          </div>
        </TabsContent>
      ) : null}
      {showSending ? (
        <TabsContent value="sending" className="mt-6">
          <SendSettingsTab />
        </TabsContent>
      ) : null}
      <TabsContent value="sources" className="mt-6 space-y-6">
        <LeadSourcesTab />
        <ComplianceSection />
      </TabsContent>
      {showApi ? (
        <TabsContent value="api" className="mt-6 space-y-6">
          <ApiSettingsTab />
          <ApiConsoleCard />
        </TabsContent>
      ) : null}
    </Tabs>
  );
}

/** Opt-out keywords live behind the compliance feature flag. */
function ComplianceSection() {
  const { enabled, loading } = useFeatureFlag("compliance");
  if (loading) return <Skeleton className="h-48 w-full rounded-2xl" />;
  if (!enabled) return null;
  return <OptOutKeywordsCard />;
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm sm:p-8">
      {children}
    </div>
  );
}

function GeneralTab() {
  const { active, reload } = useOrg();
  const { can } = usePermissions();
  const canManage = can("settings.manage");
  const [name, setName] = useState(active?.organization.name ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(active?.organization.name ?? "");
  }, [active?.organization.name]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!active) return;
    if (name.trim().length < 2) {
      toast.error("Workspace name must be at least 2 characters.");
      return;
    }
    setSaving(true);
    const { error } = await aidwar
      .from("organizations")
      .update({ name: name.trim() })
      .eq("id", active.organization.id);
    setSaving(false);
    if (error) {
      toast.error("We couldn't save your changes. Please try again.");
      return;
    }
    await logActivity("organization.updated", active.organization.id, { field: "name" });
    toast.success("Workspace updated");
    await reload();
  }

  return (
    <Card>
      <h2 className="text-base font-semibold text-foreground">Workspace</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {canManage
          ? "Change how your workspace appears across AiDwar."
          : "Only owners and admins can change workspace details."}
      </p>
      <form onSubmit={save} className="mt-6 max-w-md space-y-4">
        <div className="space-y-2">
          <Label htmlFor="org_name">Organization name</Label>
          <Input
            id="org_name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!canManage || saving}
          />
        </div>
        {canManage ? (
          <Button type="submit" className="rounded-full" disabled={saving}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save changes
          </Button>
        ) : null}
      </form>
    </Card>
  );
}
