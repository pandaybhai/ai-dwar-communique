import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ErrorState } from "@/components/empty-state";
import { aidwar } from "@/integrations/aidwar/client";
import { useOrg } from "@/lib/org-context";
import { usePermissions } from "@/hooks/use-permissions";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { TeamSettings } from "@/components/team/team-settings";
import { WhatsAppTab } from "@/components/whatsapp-settings";
import { WhatsAppProfileCard, WhatsAppProfileHoisted } from "@/components/whatsapp-profile-card";
import { LeadSourcesTab } from "@/components/contacts/lead-sources-settings";
import { OptOutKeywordsCard } from "@/components/contacts/opt-out-keywords-settings";
import { DeleteWorkspaceCard } from "@/components/settings/delete-workspace-card";
import { IntegrationsTab } from "@/components/integrations/integrations-settings";
import { FlowConnections } from "@/components/integrations/flow-connections";
import { SendSettingsTab } from "@/components/settings/send-settings";
import { ApiSettingsTab } from "@/components/settings/api-settings";
import { ApiConsoleCard } from "@/components/settings/api-console";
import { HandoffAlertsCard } from "@/components/employee/handoff-alerts-card";
import { ConnectedAiApps } from "@/components/settings-v2/connected-ai-apps";
import {
  NUMBER_COLUMNS,
  numberLabel,
  sortNumbers,
  type WhatsAppNumber,
} from "@/lib/whatsapp-numbers";
import { cn } from "@/lib/utils";
import {
  sectionFor,
  visibleSections,
  type SettingsSection,
  type SettingsSectionKey,
} from "./settings-sections";
import { SETTINGS_COPY } from "./copy";

/**
 * Batch 50: Settings in the new design (flag new_design on). A left sub-nav
 * (a scrolling row of pills on a phone) and the chosen section's cards. Every
 * card is the classic tab's own component, so each save, connect and delete
 * goes through exactly the path it always did. `workspace` is the classic
 * General tab's form, handed in by the route so its one write path stays put.
 */
export function NewSettingsPage({ workspace }: { workspace: ReactNode }) {
  const { active, loading, error, reload } = useOrg();
  return (
    <div className="pb-6">
      <header className="nd-rise mb-7 flex flex-col gap-2">
        <h1 className="min-w-0 font-display text-[clamp(1.75rem,3.4vw,2.5rem)] font-extrabold leading-[1.05] tracking-[-0.03em] text-foreground">
          {SETTINGS_COPY.title}
        </h1>
        <p className="max-w-2xl text-body text-muted-foreground">{SETTINGS_COPY.description}</p>
      </header>
      {loading ? (
        <SettingsSkeleton />
      ) : error ? (
        <ErrorState message={SETTINGS_COPY.loadFailed} onRetry={() => void reload()} />
      ) : !active ? (
        <ErrorState message={SETTINGS_COPY.noWorkspace} />
      ) : (
        <SettingsLayout workspace={workspace} />
      )}
    </div>
  );
}

/** The page's own shape while the workspace loads: the sub-nav, then a section. */
function SettingsSkeleton() {
  return (
    <div
      className="grid gap-6 wide:grid-cols-[13.5rem_minmax(0,1fr)] wide:gap-10"
      aria-busy="true"
      aria-label={SETTINGS_COPY.loadingLabel}
    >
      <div className="flex gap-2 overflow-hidden wide:flex-col">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-10 w-28 shrink-0 rounded-full wide:w-full wide:rounded-xl" />
        ))}
      </div>
      <div className="flex flex-col gap-4">
        <Skeleton className="h-7 w-48 rounded-lg" />
        <Skeleton className="h-4 w-full max-w-md rounded-lg" />
        <Skeleton className="h-64 w-full rounded-[18px]" />
      </div>
    </div>
  );
}

function useSettingsAccess() {
  const { active } = useOrg();
  const { can } = usePermissions();
  const shopify = useFeatureFlag("shopify");
  const flowsV2 = useFeatureFlag("flows_v2");
  const flows = useFeatureFlag("flows");
  const publicApi = useFeatureFlag("public_api");
  const compliance = useFeatureFlag("compliance");
  const ai = useFeatureFlag("ai_features");
  return {
    shopify: shopify.enabled && can("integrations.view"),
    connections: flowsV2.enabled && can("integrations.view"),
    sending: flows.enabled && can("flows.view"),
    api: publicApi.enabled && can("public_api.manage"),
    compliance: compliance.enabled,
    notifications: ai.enabled && can("ai.use"),
    owner: active?.role === "owner",
    // Batch 52: everyone's own grants, whatever the workspace's flags.
    aiApps: true,
  };
}

function SettingsLayout({ workspace }: { workspace: ReactNode }) {
  const access = useSettingsAccess();
  const sections = visibleSections(access);
  const search = useRouterState({
    select: (st) => st.location.search as Record<string, unknown>,
  });
  const tab = typeof search["tab"] === "string" ? (search["tab"] as string) : null;
  const current = sectionFor(tab, search["google"] !== undefined, sections);
  const section = sections.find((s) => s.key === current) ?? sections[0]!;

  // A section picked from the sub-nav takes the reader to its heading.
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    headingRef.current?.focus({ preventScroll: true });
  }, [current]);

  return (
    <div className="grid gap-6 wide:grid-cols-[13.5rem_minmax(0,1fr)] wide:items-start wide:gap-10">
      <SubNav sections={sections} current={current} />
      <section
        key={current}
        aria-labelledby="settings-section-title"
        className="nd-view-enter min-w-0"
        data-section={current}
      >
        <div className="mb-5 flex flex-col gap-1">
          <h2
            id="settings-section-title"
            ref={headingRef}
            tabIndex={-1}
            className={cn(
              "font-display text-[1.375rem] font-semibold leading-tight outline-none",
              current === "danger" ? "text-danger" : "text-foreground",
            )}
          >
            {section.label}
          </h2>
          <p className="text-body text-muted-foreground">{section.blurb}</p>
        </div>
        <div
          className={cn("space-y-6", current === "danger" && "border-t border-danger-border pt-6")}
        >
          <SectionBody section={current} workspace={workspace} />
        </div>
      </section>
    </div>
  );
}

function SubNav({
  sections,
  current,
}: {
  sections: SettingsSection[];
  current: SettingsSectionKey;
}) {
  return (
    <nav aria-label={SETTINGS_COPY.navLabel} className="min-w-0 wide:sticky wide:top-3">
      <ul className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 [scrollbar-width:none] wide:mx-0 wide:flex-col wide:overflow-visible wide:px-0 wide:pb-0">
        {sections.map((s) => {
          const on = s.key === current;
          const danger = s.key === "danger";
          return (
            <li
              key={s.key}
              className={cn(
                "shrink-0",
                danger && "wide:mt-3 wide:border-t wide:border-border wide:pt-3",
              )}
            >
              <Link
                to="/app/settings"
                search={{ tab: s.key } as never}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "flex items-center whitespace-nowrap rounded-full px-3.5 py-2 text-[0.9375rem] font-semibold transition-colors duration-200",
                  "phone:min-h-11 wide:rounded-xl",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  on
                    ? danger
                      ? "bg-danger-soft text-danger-soft-foreground"
                      : "bg-aiden-soft text-aiden-deep"
                    : danger
                      ? "text-danger-soft-foreground hover:bg-danger-soft"
                      : "text-muted-foreground hover:bg-surface hover:text-foreground",
                )}
              >
                {s.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function SectionBody({
  section,
  workspace,
}: {
  section: SettingsSectionKey;
  workspace: ReactNode;
}) {
  const { active } = useOrg();
  const { can } = usePermissions();
  const orgId = active!.organization.id;
  switch (section) {
    case "general":
      return <>{workspace}</>;
    case "team":
      return <TeamSettings />;
    case "whatsapp":
      return (
        <WhatsAppProfileHoisted.Provider value={true}>
          <WhatsAppProfileTop orgId={orgId} />
          <WhatsAppTab />
        </WhatsAppProfileHoisted.Provider>
      );
    case "api":
      return (
        <>
          <ApiSettingsTab />
          <ApiConsoleCard />
        </>
      );
    case "ai_apps":
      return <ConnectedAiApps />;
    case "notifications":
      return (
        <>
          <HandoffAlertsCard organizationId={orgId} canConfigure={can("ai.configure")} />
          <p className="text-sm text-muted-foreground">{SETTINGS_COPY.billingNote}</p>
        </>
      );
    case "optout":
      return <OptOutKeywordsCard />;
    case "integrations":
      return <IntegrationsTab />;
    case "connections":
      return <FlowConnections />;
    case "sending":
      return <SendSettingsTab />;
    case "sources":
      return <LeadSourcesTab />;
    case "danger":
      return <DeleteWorkspaceCard />;
  }
}

/**
 * The WhatsApp profile as its own card at the top of the section: the
 * default number's profile, with a picker when there are several. The card
 * itself (WhatsAppProfileCard) reads and saves through /api/whatsapp/profile
 * as it always did, and shows only to people who may change it.
 */
function WhatsAppProfileTop({ orgId }: { orgId: string }) {
  const [numbers, setNumbers] = useState<WhatsAppNumber[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.resolve(
      aidwar.from("whatsapp_accounts").select(NUMBER_COLUMNS).eq("organization_id", orgId),
    ).then(({ data }) => {
      if (!live) return;
      const rows = sortNumbers(
        ((data ?? []) as WhatsAppNumber[]).filter((n) => n.status === "active"),
      );
      setNumbers(rows);
      setChosen(rows[0]?.id ?? null);
    });
    return () => {
      live = false;
    };
  }, [orgId]);

  if (numbers === null) return <Skeleton className="h-28 w-full rounded-[18px]" />;
  if (!chosen) return null;

  const picker =
    numbers.length > 1 ? (
      <Select value={chosen} onValueChange={setChosen}>
        <SelectTrigger className="w-full max-w-xs" aria-label={SETTINGS_COPY.profilePicker}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {numbers.map((n) => (
            <SelectItem key={n.id} value={n.id}>
              {numberLabel(n)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : undefined;

  return (
    <WhatsAppProfileCard
      key={chosen}
      orgId={orgId}
      accountId={chosen}
      placement="top"
      numberSwitch={picker}
    />
  );
}
