import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  BellRing,
  Building2,
  Check,
  Code2,
  Copy,
  Loader2,
  MessageCircle,
  Plug,
  ShieldOff,
  Timer,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState, PageHeader } from "@/components/empty-state";
import { aidwar } from "@/integrations/aidwar/client";
import { logActivity } from "@/lib/activity";
import { useOrg } from "@/lib/org-context";
import { cn } from "@/lib/utils";
import { usePermissions } from "@/hooks/use-permissions";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { usePageShortcut } from "@/hooks/use-page-shortcut";
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
import { HandoffAlertsCard } from "@/components/employee/handoff-alerts-card";

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
  component: SettingsPage,
});

function SettingsPage() {
  const { active, loading, error } = useOrg();

  return (
    <>
      <PageHeader
        title="Settings"
        description="Workspace details, your team, and the connections that power your messaging."
      />
      {loading ? (
        <SettingsSkeleton />
      ) : error ? (
        <ErrorState message={error} />
      ) : !active ? (
        <ErrorState message="We couldn't find your workspace. Please refresh the page." />
      ) : (
        <SettingsLayout />
      )}
    </>
  );
}

function SettingsSkeleton() {
  return (
    <div className="grid gap-8 lg:grid-cols-[13.5rem_minmax(0,1fr)]" aria-busy="true" aria-label="Loading">
      <div className="hidden space-y-2 lg:block">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-8 w-full rounded-lg" />
        ))}
      </div>
      <div className="space-y-4">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </div>
    </div>
  );
}

/**
 * Batch 43: one settings layout — a left sub-nav (a scrolling row on phones)
 * and one section at a time, each with its own header and cards. The section
 * is the address's ?tab= (the docs link to ?tab=api&try=…#try-it), so the
 * old tab names keep working; "danger" sits apart at the foot of the nav.
 */
type SectionKey =
  | "general"
  | "team"
  | "notifications"
  | "whatsapp"
  | "sending"
  | "opt-out"
  | "sources"
  | "integrations"
  | "api"
  | "danger";

type Section = {
  key: SectionKey;
  label: string;
  group: "Workspace" | "Messaging" | "Connections" | "Danger";
  icon: LucideIcon;
  title: string;
  description: string;
  render: () => ReactNode;
};

/** The section the address asks for: ?tab=<name>, or Google's return to Integrations. */
function initialSection(keys: SectionKey[], showIntegrations: boolean): SectionKey {
  if (typeof window === "undefined") return "general";
  const q = new URLSearchParams(window.location.search);
  const asked = q.get("tab") as SectionKey | null;
  if (asked && keys.includes(asked)) return asked;
  return q.has("google") && showIntegrations ? "integrations" : "general";
}

function SettingsLayout() {
  const { active } = useOrg();
  const { can } = usePermissions();
  const { enabled: shopifyEnabled } = useFeatureFlag("shopify");
  const { enabled: flowsV2Enabled } = useFeatureFlag("flows_v2");
  const { enabled: flowsEnabled } = useFeatureFlag("flows");
  const { enabled: publicApiEnabled } = useFeatureFlag("public_api");
  const { enabled: complianceEnabled } = useFeatureFlag("compliance");
  const { enabled: aiEnabled } = useFeatureFlag("ai_features");
  const showShopify = shopifyEnabled && can("integrations.view");
  const showConnections = flowsV2Enabled && can("integrations.view");
  const showIntegrations = showShopify || showConnections;
  const showSending = flowsEnabled && can("flows.view");
  const showApi = publicApiEnabled && can("public_api.manage");
  // Hand-off alerts are the AI employee's own card (Behaviour tab), shown here too.
  const showNotifications = aiEnabled && can("ai.use");
  const orgId = active?.organization.id ?? "";

  const sections = useMemo<Section[]>(() => {
    const list: Array<Section | null> = [
      {
        key: "general",
        label: "Workspace",
        group: "Workspace",
        icon: Building2,
        title: "Workspace",
        description: "How your workspace appears across AiDwar.",
        render: () => <GeneralSection />,
      },
      {
        key: "team",
        label: "Team & roles",
        group: "Workspace",
        icon: Users,
        title: "Team & roles",
        description: "Who can sign in to this workspace, their roles and what each person may do.",
        render: () => <TeamSettings />,
      },
      showNotifications
        ? {
            key: "notifications",
            label: "Notifications",
            group: "Workspace",
            icon: BellRing,
            title: "Notifications",
            description: "Who is told when a chat needs a person.",
            render: () => (
              <HandoffAlertsCard organizationId={orgId} canConfigure={can("ai.configure")} />
            ),
          }
        : null,
      {
        key: "whatsapp",
        label: "WhatsApp",
        group: "Messaging",
        icon: MessageCircle,
        title: "WhatsApp numbers & profile",
        description: "Your connected numbers, their health, and what customers see when they tap your name.",
        render: () => <WhatsAppTab />,
      },
      showSending
        ? {
            key: "sending",
            label: "Sending",
            group: "Messaging",
            icon: Timer,
            title: "Sending",
            description: "Quiet hours, frequency caps and the rules every flow follows.",
            render: () => <SendSettingsTab />,
          }
        : null,
      complianceEnabled
        ? {
            key: "opt-out",
            label: "Opt-out keywords",
            group: "Messaging",
            icon: ShieldOff,
            title: "Opt-out keywords",
            description: "The words that stop and restart marketing messages for a customer.",
            render: () => <OptOutKeywordsCard />,
          }
        : null,
      {
        key: "sources",
        label: "Lead sources",
        group: "Messaging",
        icon: UserPlus,
        title: "Lead sources",
        description: "Where new contacts come from, so every chat is credited to the right place.",
        render: () => <LeadSourcesTab />,
      },
      showIntegrations
        ? {
            key: "integrations",
            label: "Integrations",
            group: "Connections",
            icon: Plug,
            title: "Integrations",
            description: "Your shop and the accounts your flows use.",
            render: () => (
              <div className="space-y-6">
                {showShopify ? <IntegrationsTab /> : null}
                {showConnections ? <FlowConnections /> : null}
              </div>
            ),
          }
        : null,
      showApi
        ? {
            key: "api",
            label: "API & webhooks",
            group: "Connections",
            icon: Code2,
            title: "API & webhooks",
            description: "Keys for your own systems, the events we send you, and a console to try every call.",
            render: () => (
              <div className="space-y-6">
                <ApiSettingsTab />
                <ApiConsoleCard />
              </div>
            ),
          }
        : null,
      {
        key: "danger",
        label: "Danger zone",
        group: "Danger",
        icon: AlertTriangle,
        title: "Danger zone",
        description: "Actions here can't be undone. Take a breath first.",
        render: () => <DangerSection />,
      },
    ];
    return list.filter((s): s is Section => s !== null);
  }, [showNotifications, showSending, complianceEnabled, showIntegrations, showShopify, showConnections, showApi, orgId, can]);

  const keys = sections.map((s) => s.key);
  const [current, setCurrent] = useState<SectionKey>(() => initialSection(keys, showIntegrations));
  // A section that appears once flags load (?tab=api before public_api is read).
  useEffect(() => {
    const asked = initialSection(keys, showIntegrations);
    if (asked !== "general" && current === "general") setCurrent(asked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys.join(",")]);
  const section = sections.find((s) => s.key === current) ?? sections[0]!;

  const go = (key: SectionKey) => {
    setCurrent(key);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", key);
      if (key !== "api") {
        url.searchParams.delete("try");
        url.hash = "";
      }
      window.history.replaceState(window.history.state, "", url);
    } catch {
      // The address is a convenience; the section still changes.
    }
    document.getElementById("main")?.scrollTo?.({ top: 0 });
  };
  const step = (delta: number) => {
    const i = keys.indexOf(section.key);
    const next = keys[(i + delta + keys.length) % keys.length];
    if (next) go(next);
  };
  usePageShortcut("j", () => step(1));
  usePageShortcut("k", () => step(-1));

  const groups = ["Workspace", "Messaging", "Connections"] as const;
  const danger = sections.find((s) => s.key === "danger");

  return (
    <div className="grid gap-6 lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:gap-10">
      <nav aria-label="Settings sections" className="min-w-0 lg:sticky lg:top-0 lg:self-start lg:pt-1">
        {/* Phones: one scrolling row of chips. */}
        <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] lg:hidden">
          {sections.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => go(s.key)}
              aria-current={s.key === section.key ? "page" : undefined}
              className={cn(
                "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[0.8125rem] font-medium transition-colors duration-150",
                s.key === section.key
                  ? s.key === "danger"
                    ? "border-danger-border bg-danger-soft text-danger-soft-foreground"
                    : "border-transparent bg-foreground text-background"
                  : s.key === "danger"
                    ? "border-border bg-card text-danger-soft-foreground"
                    : "border-border bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              <s.icon className="h-3.5 w-3.5" aria-hidden="true" />
              {s.label}
            </button>
          ))}
        </div>

        {/* Desktop: grouped list. */}
        <div className="hidden space-y-5 lg:block">
          {groups.map((g) => {
            const items = sections.filter((s) => s.group === g);
            if (items.length === 0) return null;
            return (
              <div key={g}>
                <p className="type-label mb-1.5 px-2.5 text-faint">{g}</p>
                <ul className="space-y-0.5">
                  {items.map((s) => (
                    <li key={s.key}>
                      <NavButton section={s} active={s.key === section.key} onSelect={() => go(s.key)} />
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          {danger ? (
            <div className="border-t border-border pt-4">
              <NavButton section={danger} active={danger.key === section.key} onSelect={() => go(danger.key)} danger />
            </div>
          ) : null}
          <p className="px-2.5 text-xs text-faint">
            <Kbd>J</Kbd> <Kbd>K</Kbd> to move between sections
          </p>
        </div>
      </nav>

      <section key={section.key} aria-labelledby="settings-section-title" className="page-enter min-w-0 max-w-4xl">
        <header className="mb-6 flex items-start gap-3.5">
          <span
            className={cn(
              "mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border shadow-xs",
              section.key === "danger"
                ? "border-danger-border bg-danger-soft text-danger-soft-foreground"
                : "border-border bg-card text-primary",
            )}
          >
            <section.icon className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 id="settings-section-title" className="type-title text-foreground">
              {section.title}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{section.description}</p>
          </div>
        </header>
        <div className="space-y-6">{section.render()}</div>
      </section>
    </div>
  );
}

function NavButton({
  section,
  active,
  onSelect,
  danger = false,
}: {
  section: Section;
  active: boolean;
  onSelect: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm transition-colors duration-150",
        danger
          ? active
            ? "bg-danger-soft font-medium text-danger-soft-foreground"
            : "text-danger-soft-foreground hover:bg-danger-soft"
          : active
            ? "bg-accent font-medium text-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <section.icon
        className={cn("h-4 w-4 shrink-0", active && !danger ? "text-primary" : undefined)}
        aria-hidden="true"
      />
      <span className="truncate">{section.label}</span>
    </button>
  );
}

function SettingsCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-2xl border border-border bg-card p-6 shadow-xs sm:p-7", className)}>
      {children}
    </div>
  );
}

function orgInitials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter((w) => /[a-z0-9]/i.test(w))
      .map((w) => w[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || "W"
  );
}

function GeneralSection() {
  const { active, reload } = useOrg();
  const { can } = usePermissions();
  const canManage = can("settings.manage");
  const saved = active?.organization.name ?? "";
  const [name, setName] = useState(saved);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setName(active?.organization.name ?? "");
  }, [active?.organization.name]);

  const tooShort = name.trim().length < 2;
  const dirty = name.trim() !== saved.trim();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!active) return;
    setTouched(true);
    if (tooShort) {
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

  const copyId = async () => {
    if (!active) return;
    try {
      await navigator.clipboard.writeText(active.organization.id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Couldn't copy — select the ID and copy it instead.");
    }
  };

  return (
    <>
      <SettingsCard>
        <div className="flex items-center gap-4">
          <span
            aria-hidden="true"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-800 text-sm font-bold text-white shadow-xs"
          >
            {orgInitials(name || saved)}
          </span>
          <div className="min-w-0">
            <p className="truncate type-heading text-foreground">{name.trim() || saved}</p>
            <p className="text-sm text-muted-foreground">
              Your role: <span className="capitalize">{active?.role}</span>
            </p>
          </div>
        </div>

        <form onSubmit={save} className="mt-6 max-w-md space-y-4 border-t border-border pt-6" noValidate>
          <div className="space-y-2">
            <Label htmlFor="org_name">Organization name</Label>
            <Input
              id="org_name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setTouched(true)}
              disabled={!canManage || saving}
              aria-invalid={touched && tooShort ? true : undefined}
              aria-describedby="org_name_hint"
            />
            <p
              id="org_name_hint"
              className={cn("text-xs", touched && tooShort ? "text-danger-soft-foreground" : "text-muted-foreground")}
            >
              {!canManage
                ? "Only owners and admins can change workspace details."
                : touched && tooShort
                  ? "Workspace name must be at least 2 characters."
                  : "Change how your workspace appears across AiDwar."}
            </p>
          </div>
          {canManage ? (
            <Button type="submit" disabled={saving || !dirty}>
              {saving ? <Loader2 className="animate-spin" /> : null}
              Save changes
            </Button>
          ) : null}
        </form>
      </SettingsCard>

      <SettingsCard>
        <h3 className="type-heading text-foreground">Workspace ID</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Quote this when you write to support, so we find your workspace straight away.
        </p>
        <div className="mt-4 flex max-w-md items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg border border-border bg-subtle px-3 py-2 font-mono text-xs text-foreground">
            {active?.organization.id}
          </code>
          <Button type="button" variant="outline" size="icon" onClick={() => void copyId()} aria-label="Copy workspace ID">
            {copied ? <Check className="text-primary" /> : <Copy />}
          </Button>
        </div>
      </SettingsCard>
    </>
  );
}

/** Only the owner sees the delete card (it returns nothing for anyone else). */
function DangerSection() {
  const { active } = useOrg();
  if (active?.role !== "owner") {
    return (
      <SettingsCard>
        <p className="text-sm text-muted-foreground">
          Only the workspace owner can delete this workspace.
        </p>
      </SettingsCard>
    );
  }
  return <DeleteWorkspaceCard />;
}
