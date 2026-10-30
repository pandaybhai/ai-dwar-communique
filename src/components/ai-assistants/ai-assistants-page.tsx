import { useCallback, useEffect, useMemo, useState } from "react";
import { Lock } from "lucide-react";
import { toast } from "sonner";
import { EmptyState, ErrorState, PageHeader, PageSkeleton } from "@/components/empty-state";
import { ConnectedAiApps } from "@/components/settings-v2/connected-ai-apps";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { usePermissions } from "@/hooks/use-permissions";
import { useOrg } from "@/lib/org-context";
import { useNewDesign } from "@/lib/new-design";
import { callApi } from "@/lib/whatsapp-client";
import type { AssistantsOverview } from "@/lib/mcp-workspace";
import {
  ConnectSteps,
  PromptLibrary,
  SafetyList,
  SectionCard,
  TeamApps,
  Timeline,
  UsageMeters,
  focusRing,
} from "./parts";
import { ASSISTANTS_COPY, assistantsCopy } from "./copy";

/**
 * Batch 53: /app/ai-assistants, the same page in Classic and Aiden
 * Workspace (PageHeader and the shared tokens give each its look). For
 * anyone with mcp.use; the On/Off switch only for settings.manage (owners
 * and admins). Every read goes through GET /api/ai-assistants; the only
 * write is the switch (POST, audit-logged) and Remove on your own app
 * (Supabase Auth, exactly Batch 52's Connected AI apps).
 */

/** The route's meta and both designs' page line (Batch 56 wording: unchanged). */
export const PAGE_DESCRIPTION = ASSISTANTS_COPY.classic.description;

export function AiAssistantsPage() {
  const nd = useNewDesign();
  const copy = assistantsCopy(nd);
  const { active } = useOrg();
  const { can, loading: permsLoading } = usePermissions();
  const orgId = active?.organization.id ?? null;
  const [data, setData] = useState<AssistantsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [app, setApp] = useState("");
  const [member, setMember] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) return;
    setError(null);
    const q = new URLSearchParams({ organization_id: orgId });
    if (app) q.set("app", app);
    if (member) q.set("member", member);
    const res = await callApi<AssistantsOverview>(`/api/ai-assistants?${q.toString()}`, {
      method: "GET",
    });
    if (res.data) setData(res.data);
    else setError(res.error ?? copy.loadFailed);
  }, [orgId, app, member, copy.loadFailed]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setAccess(enabled: boolean) {
    if (!orgId) return;
    setSaving(true);
    const res = await callApi<{ ok: boolean; enabled: boolean }>("/api/ai-assistants", {
      method: "POST",
      body: { organization_id: orgId, action: "set_access", enabled },
    });
    setSaving(false);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    toast.success(enabled ? copy.toastOn : copy.toastOff);
    void load();
  }

  if (!permsLoading && !can("mcp.use")) {
    return (
      <>
        <PageHeader title={copy.title} description={PAGE_DESCRIPTION} />
        <EmptyState icon={Lock} title={copy.noAccess.title} description={copy.noAccess.body} />
      </>
    );
  }

  return (
    <>
      <PageHeader title={copy.title} description={PAGE_DESCRIPTION} />
      {error ? (
        nd ? (
          <div className="mb-6">
            <ErrorState message={copy.loadFailed} onRetry={() => void load()} />
          </div>
        ) : (
          <p
            role="alert"
            className="mb-6 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger-soft-foreground"
          >
            {error}
          </p>
        )
      ) : null}
      {!data && !error ? <PageSkeleton /> : null}
      {data ? (
        <AiAssistantsView
          data={data}
          saving={saving}
          app={app}
          member={member}
          onApp={setApp}
          onMember={setMember}
          onAccess={(on) => void setAccess(on)}
        />
      ) : null}
    </>
  );
}

/** The page body for given data (no fetching), for the page and the tests. */
export function AiAssistantsView({
  data,
  saving = false,
  app = "",
  member = "",
  onApp,
  onMember,
  onAccess,
  ownApps,
}: {
  data: AssistantsOverview;
  saving?: boolean;
  app?: string;
  member?: string;
  onApp?: (v: string) => void;
  onMember?: (v: string) => void;
  onAccess?: (on: boolean) => void;
  /** Tests pass the person's own apps list; the page uses Supabase Auth's. */
  ownApps?: React.ReactNode;
}) {
  const nd = useNewDesign();
  const copy = assistantsCopy(nd);
  // Aiden Workspace: each section arrives in turn (nd-rise); Classic draws them at once.
  const rise = (d: number) => (nd ? d : undefined);
  const lastUsed = useMemo(
    () =>
      Object.fromEntries(
        (data.apps ?? []).filter((a) => a.mine).map((a) => [a.clientId, a.lastUsedAt]),
      ),
    [data.apps],
  );
  const appOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of data.timeline) if (e.appId) seen.set(e.appId, e.app);
    for (const a of data.apps ?? []) seen.set(a.clientId, a.name);
    return Array.from(seen.entries());
  }, [data.timeline, data.apps]);
  const memberOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of data.timeline) if (e.userId) seen.set(e.userId, e.member);
    for (const a of data.apps ?? []) seen.set(a.userId, a.member);
    return Array.from(seen.entries());
  }, [data.timeline, data.apps]);

  return (
    <div className="flex flex-col gap-8 pb-10">
      {!data.mcpOn ? (
        <div
          role="status"
          className="flex gap-3 rounded-2xl border border-warning-border bg-warning-soft px-5 py-4 text-warning-soft-foreground"
        >
          <Lock className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <div className="space-y-1">
            <p className="font-semibold">{copy.off.title}</p>
            <p className="text-sm">
              {data.supportLocked
                ? copy.off.support
                : data.canManage
                  ? copy.off.manager
                  : copy.off.member}
            </p>
          </div>
        </div>
      ) : null}

      <SectionCard
        id="connect"
        title={copy.connect.title}
        blurb={copy.connect.blurb}
        rise={rise(0)}
      >
        <ConnectSteps />
      </SectionCard>

      <SectionCard
        id="apps"
        title={copy.apps.title}
        blurb={data.seesEveryone ? copy.apps.blurbEveryone : copy.apps.blurbOwn}
        rise={rise(1)}
      >
        {ownApps ?? <ConnectedAiApps lastUsed={lastUsed} intro={false} />}
        {data.seesEveryone && data.apps ? <TeamApps apps={data.apps} /> : null}
      </SectionCard>

      <SectionCard
        id="activity"
        title={copy.activity.title}
        blurb={data.seesEveryone ? copy.activity.blurbEveryone : copy.activity.blurbOwn}
        rise={rise(2)}
      >
        {appOptions.length > 1 ||
        (data.seesEveryone && memberOptions.length > 1) ||
        app ||
        member ? (
          <div className="flex flex-wrap gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="ai-filter-app">{copy.activity.app}</Label>
              <select
                id="ai-filter-app"
                value={app}
                onChange={(e) => onApp?.(e.target.value)}
                className={`h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground ${nd ? "phone:h-11 " : ""}${focusRing}`}
              >
                <option value="">{copy.activity.allApps}</option>
                {appOptions.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            {data.seesEveryone ? (
              <div className="flex flex-col gap-1">
                <Label htmlFor="ai-filter-member">{copy.activity.person}</Label>
                <select
                  id="ai-filter-member"
                  value={member}
                  onChange={(e) => onMember?.(e.target.value)}
                  className={`h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground ${nd ? "phone:h-11 " : ""}${focusRing}`}
                >
                  <option value="">{copy.activity.everyone}</option>
                  {memberOptions.map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>
        ) : null}
        <Timeline events={data.timeline} seesEveryone={data.seesEveryone} copy={copy.activity} />
      </SectionCard>

      <SectionCard
        id="prompts"
        title={copy.prompts.title}
        blurb={copy.prompts.blurb}
        rise={rise(3)}
      >
        <PromptLibrary />
      </SectionCard>

      <SectionCard id="safety" title={copy.safety.title} rise={rise(4)}>
        <SafetyList />
        <UsageMeters usage={data.usage} />
        {data.canManage ? (
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-4 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <Label htmlFor="mcp-access" className="text-base font-semibold text-foreground">
                {copy.safety.switchLabel}
              </Label>
              <p className="text-sm text-muted-foreground">{copy.safety.switchHelp}</p>
            </div>
            <Switch
              id="mcp-access"
              checked={data.mcpOn}
              disabled={saving || (data.supportLocked && !data.mcpOn)}
              onCheckedChange={(on) => onAccess?.(on)}
              aria-describedby="mcp-access-state"
            />
            <span id="mcp-access-state" className="text-sm font-semibold text-foreground">
              {data.mcpOn ? copy.safety.on : copy.safety.off}
            </span>
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
}
