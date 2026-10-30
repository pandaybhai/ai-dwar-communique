import { useCallback, useEffect, useMemo, useState } from "react";
import { Lock } from "lucide-react";
import { toast } from "sonner";
import { EmptyState, PageHeader, PageSkeleton } from "@/components/empty-state";
import { ConnectedAiApps } from "@/components/settings-v2/connected-ai-apps";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { usePermissions } from "@/hooks/use-permissions";
import { useOrg } from "@/lib/org-context";
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

/**
 * Batch 53: /app/ai-assistants, the same page in Classic and Aiden
 * Workspace (PageHeader and the shared tokens give each its look). For
 * anyone with mcp.use; the On/Off switch only for settings.manage (owners
 * and admins). Every read goes through GET /api/ai-assistants; the only
 * write is the switch (POST, audit-logged) and Remove on your own app
 * (Supabase Auth, exactly Batch 52's Connected AI apps).
 */

export const PAGE_DESCRIPTION =
  "Use AiDwar from Claude, ChatGPT, Codex or Cursor: ask about your numbers, draft campaigns and flows. Nothing is sent until you confirm.";

export function AiAssistantsPage() {
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
    const res = await callApi<AssistantsOverview>(`/api/ai-assistants?${q.toString()}`, { method: "GET" });
    if (res.data) setData(res.data);
    else setError(res.error ?? "We couldn't load this page. Please refresh.");
  }, [orgId, app, member]);

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
    toast.success(enabled ? "AI assistants are on for this workspace." : "AI assistants are off for this workspace.");
    void load();
  }

  if (!permsLoading && !can("mcp.use")) {
    return (
      <>
        <PageHeader title="AI assistants" description={PAGE_DESCRIPTION} />
        <EmptyState
          icon={Lock}
          title="You don't have access to AI assistants"
          description="Ask an owner or admin of this workspace to give you “Use AiDwar from an AI assistant”."
        />
      </>
    );
  }

  return (
    <>
      <PageHeader title="AI assistants" description={PAGE_DESCRIPTION} />
      {error ? (
        <p role="alert" className="mb-6 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger-soft-foreground">
          {error}
        </p>
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
  const lastUsed = useMemo(
    () => Object.fromEntries((data.apps ?? []).filter((a) => a.mine).map((a) => [a.clientId, a.lastUsedAt])),
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
        <div role="status" className="flex gap-3 rounded-2xl border border-warning-border bg-warning-soft px-5 py-4 text-warning-soft-foreground">
          <Lock className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <div className="space-y-1">
            <p className="font-semibold">AI assistants are switched off for this workspace.</p>
            <p className="text-sm">
              {data.supportLocked
                ? "AiDwar support switched them off. Write to support to switch them back on."
                : data.canManage
                  ? "Connected apps can't read or draft anything here until you switch them on under Safety and limits."
                  : "Connected apps can't read or draft anything here. An owner or admin can switch them on from this page."}
            </p>
          </div>
        </div>
      ) : null}

      <SectionCard id="connect" title="Connect" blurb="Add AiDwar to your AI assistant once; it signs in as you.">
        <ConnectSteps />
      </SectionCard>

      <SectionCard
        id="apps"
        title="Your connected apps"
        blurb={
          data.seesEveryone
            ? "The AI apps you allowed, and below them your team's. Removing one ends its access at once."
            : "The AI apps you allowed to use AiDwar as you. Removing one ends its access at once."
        }
      >
        {ownApps ?? <ConnectedAiApps lastUsed={lastUsed} intro={false} />}
        {data.seesEveryone && data.apps ? <TeamApps apps={data.apps} /> : null}
      </SectionCard>

      <SectionCard
        id="activity"
        title="What your AI did"
        blurb={
          data.seesEveryone
            ? "Everything an AI assistant created, drafted, sent or switched on in this workspace."
            : "Everything your AI assistant created, drafted, sent or switched on for you."
        }
      >
        {(appOptions.length > 1 || (data.seesEveryone && memberOptions.length > 1) || app || member) ? (
          <div className="flex flex-wrap gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="ai-filter-app">App</Label>
              <select
                id="ai-filter-app"
                value={app}
                onChange={(e) => onApp?.(e.target.value)}
                className={`h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground ${focusRing}`}
              >
                <option value="">All apps</option>
                {appOptions.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            {data.seesEveryone ? (
              <div className="flex flex-col gap-1">
                <Label htmlFor="ai-filter-member">Person</Label>
                <select
                  id="ai-filter-member"
                  value={member}
                  onChange={(e) => onMember?.(e.target.value)}
                  className={`h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground ${focusRing}`}
                >
                  <option value="">Everyone</option>
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
        <Timeline events={data.timeline} seesEveryone={data.seesEveryone} />
      </SectionCard>

      <SectionCard id="prompts" title="Prompt library" blurb="Copy one into your assistant. Each works with today's AiDwar tools.">
        <PromptLibrary />
      </SectionCard>

      <SectionCard id="safety" title="Safety and limits">
        <SafetyList />
        <UsageMeters usage={data.usage} />
        {data.canManage ? (
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-4 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <Label htmlFor="mcp-access" className="text-base font-semibold text-foreground">
                AI assistants in this workspace
              </Label>
              <p className="text-sm text-muted-foreground">
                Off stops every connected app from reading or drafting here, for everyone. Apps stay connected and work
                again when you switch it back on.
              </p>
            </div>
            <Switch
              id="mcp-access"
              checked={data.mcpOn}
              disabled={saving || (data.supportLocked && !data.mcpOn)}
              onCheckedChange={(on) => onAccess?.(on)}
              aria-describedby="mcp-access-state"
            />
            <span id="mcp-access-state" className="text-sm font-semibold text-foreground">
              {data.mcpOn ? "On" : "Off"}
            </span>
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
}

