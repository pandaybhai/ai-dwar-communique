import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Building2, FlaskConical, Lock, RotateCcw, Search, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState, PageHeader } from "@/components/empty-state";
import { callApi } from "@/lib/whatsapp-client";
import { PromptBlocksEditor } from "@/components/admin/prompt-blocks-editor";
import { SCRIPT_KEYS } from "@/lib/scripts";
import { ReadingSettingsPanel } from "@/components/admin/reading-settings";
import { BehaviourEditor } from "@/components/employee/behaviour-editor";
import type { InstructionVersion } from "@/lib/employee-client";

export const Route = createFileRoute("/admin/aiden")({
  head: () => ({
    meta: [
      { title: "Aiden control centre — AiDwar Admin" },
      { name: "description", content: "Rules, scripts, workspace behaviour, reading and testing for Aiden." },
      { property: "og:title", content: "Aiden control centre — AiDwar Admin" },
      { property: "og:description", content: "Rules, scripts, workspace behaviour, reading and testing for Aiden." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AidenControl,
});

const adminApi = async (body: Record<string, unknown>) => {
  const { data, error } = await callApi<Record<string, unknown>>("/api/admin/ai", { body });
  return { data, error };
};

function Soon({ icon, title, text }: { icon: typeof BookOpen; title: string; text: string }) {
  return <EmptyState icon={icon} title={title} description={text} />;
}

function AidenControl() {
  return (
    <div>
      <PageHeader
        title="Aiden control centre"
        description="Everything that shapes how Aiden talks and reads, across every workspace. Every change is versioned and recorded."
      />
      <Tabs defaultValue="rules">
        <TabsList className="flex h-auto flex-wrap justify-start">
          <TabsTrigger value="rules">Rules</TabsTrigger>
          <TabsTrigger value="scripts">Scripts</TabsTrigger>
          <TabsTrigger value="workspaces">Workspaces</TabsTrigger>
          <TabsTrigger value="reading">Reading</TabsTrigger>
          <TabsTrigger value="test">Test</TabsTrigger>
        </TabsList>
        <TabsContent value="rules" className="mt-6">
          <PromptBlocksEditor keys={["agent_rules", "merchant_rules"]} heading={false} />
        </TabsContent>
        <TabsContent value="scripts" className="mt-6">
          <div className="space-y-6">
            <PromptBlocksEditor keys={SCRIPT_KEYS} heading={false} />
            <ApprovedTemplates />
          </div>
        </TabsContent>
        <TabsContent value="workspaces" className="mt-6">
          <WorkspacesTab />
        </TabsContent>
        <TabsContent value="reading" className="mt-6">
          <ReadingSettingsPanel />
        </TabsContent>
        <TabsContent value="test" className="mt-6">
          <Soon icon={FlaskConical} title="Test replies without sending" text="Coming in a later phase." />
        </TabsContent>
      </Tabs>
    </div>
  );
}

type Org = {
  id: string;
  name: string;
  plan?: string | null;
  numbers?: number;
  ai_mode?: string | null;
  behaviour?: "none" | "suggested" | "owner" | "aidwar";
  sources?: number;
  items?: number;
  pages_read?: number;
  credits_month?: number;
  last_full_read?: string | null;
  last_refresh?: string | null;
};

const BEHAVIOUR_LABEL: Record<string, string> = {
  none: "Not set",
  suggested: "Suggested — review",
  owner: "Owner",
  aidwar: "Edited by AiDwar",
};

const shortDate = (v?: string | null) =>
  v ? new Date(v).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "—";

function WorkspacesTab() {
  const [q, setQ] = useState("");
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Org | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const t = setTimeout(async () => {
      const { data, error: err } = await adminApi({ action: "aiden_orgs", q });
      if (err) setError(err);
      else setOrgs(((data?.["organizations"] as Org[]) ?? []));
    }, 250);
    return () => clearTimeout(t);
  }, [q, tick]);

  if (error) return <ErrorState message={error} />;

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm">
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search workspaces" className="pl-9" />
        </div>
        <div className="mt-3 max-h-[50vh] overflow-auto">
          {orgs === null ? (
            <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-9 w-full rounded-lg" />)}</div>
          ) : orgs.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">No workspace matches.</p>
          ) : (
            <table className="w-full min-w-[900px] text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-b border-border/70">
                  {["Workspace", "Plan", "Numbers", "Aiden", "Behaviour", "Knowledge", "Pages read", "Firecrawl (month)", "Last full read", "Last refresh"].map((h) => (
                    <th key={h} className="px-2 py-2 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {orgs.map((o) => (
                  <tr
                    key={o.id}
                    onClick={() => setPicked(o)}
                    className={`cursor-pointer border-b border-border/40 transition-colors duration-150 ${picked?.id === o.id ? "bg-primary/10" : "hover:bg-muted/60"}`}
                  >
                    <td className="px-2 py-2 font-medium text-foreground">{o.name}</td>
                    <td className="px-2 py-2">{o.plan ?? "—"}</td>
                    <td className="px-2 py-2">{o.numbers ?? 0}</td>
                    <td className="px-2 py-2">{o.ai_mode ?? "—"}</td>
                    <td className="px-2 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs ${o.behaviour === "suggested" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
                        {BEHAVIOUR_LABEL[o.behaviour ?? "none"]}
                      </span>
                    </td>
                    <td className="px-2 py-2">{o.sources ?? 0} sources · {o.items ?? 0} items</td>
                    <td className="px-2 py-2">{o.pages_read ?? 0}</td>
                    <td className="px-2 py-2">{o.credits_month ?? 0}</td>
                    <td className="px-2 py-2">{shortDate(o.last_full_read)}</td>
                    <td className="px-2 py-2">{shortDate(o.last_refresh)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {picked ? (
        <WorkspaceBehaviour key={picked.id} org={picked} onChanged={() => setTick((n) => n + 1)} />
      ) : (
        <EmptyState icon={Building2} title="Pick a workspace" description="Open one to see and edit how Aiden behaves there." />
      )}
    </div>
  );
}

function WorkspaceBehaviour({ org, onChanged }: { org: Org; onChanged: () => void }) {
  const [versions, setVersions] = useState<InstructionVersion[] | null>(null);
  const [hasAgent, setHasAgent] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"generate" | "restore" | null>(null);

  const load = useCallback(async () => {
    const { data, error: err } = await adminApi({ action: "behaviour_load", organization_id: org.id });
    if (err) return setError(err);
    setHasAgent(Boolean(data?.["agent"]));
    setVersions((data?.["instructions"] as InstructionVersion[]) ?? []);
  }, [org.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (kind: "generate" | "restore") => {
    const current = versions?.find((v) => v.is_current);
    setBusy(kind);
    const { error: err } = await adminApi({
      action: kind === "generate" ? "generate_persona" : "restore_previous",
      organization_id: org.id,
      base_version: current?.version ?? null,
    });
    setBusy(null);
    if (err) toast.error(err);
    else toast.success(kind === "generate" ? "Saved as a suggestion — the merchant will be asked to review it." : "Previous version restored.");
    await load();
    onChanged();
  };

  if (error) return <ErrorState message={error} />;
  if (versions === null) return <Skeleton className="h-96 w-full rounded-2xl" />;
  if (!hasAgent)
    return <EmptyState icon={Building2} title={`${org.name} has no AI employee yet`} description="It's created when the workspace finishes onboarding." />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Editing <span className="font-medium text-foreground">{org.name}</span> — the merchant will see "Updated by AiDwar support".
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void run("generate")}>
            <Sparkles className="mr-1.5 h-4 w-4" />
            {busy === "generate" ? "Reading the website…" : "Generate from website"}
          </Button>
          <Button variant="outline" size="sm" disabled={busy !== null || versions.length < 2} onClick={() => void run("restore")}>
            <RotateCcw className="mr-1.5 h-4 w-4" />
            Restore previous version
          </Button>
        </div>
      </div>
      <BehaviourEditor
        organizationId={org.id}
        versions={versions}
        canConfigure
        onChanged={() => {
          void load();
          onChanged();
        }}
        api={async (body) => {
          const { error: err } = await adminApi(body);
          if (err) await load();
          return { error: err };
        }}
      />
    </div>
  );
}

type Template = { name: string; body: string; status: string };

function ApprovedTemplates() {
  const [rows, setRows] = useState<Template[] | null>(null);
  useEffect(() => {
    void adminApi({ action: "approved_templates" }).then(({ data }) =>
      setRows((data?.["templates"] as Template[]) ?? []),
    );
  }, []);
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">Meta-approved templates</h2>
        <p className="text-sm text-muted-foreground">Approved by Meta — changing it needs a new template.</p>
      </div>
      {rows === null ? (
        <Skeleton className="h-28 w-full rounded-xl" />
      ) : (
        rows.map((t) => (
          <div key={t.name} className="rounded-xl border border-border/70 bg-muted/30 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <Lock className="h-4 w-4 text-muted-foreground" />
              <span className="font-mono text-sm font-medium">{t.name}</span>
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{t.status}</span>
            </div>
            <p className="mt-3 whitespace-pre-wrap text-sm text-foreground">{t.body}</p>
          </div>
        ))
      )}
    </section>
  );
}
