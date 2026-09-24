import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { BookOpen, Building2, FileText, FlaskConical, ScrollText, Search } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState, PageHeader } from "@/components/empty-state";
import { callApi } from "@/lib/whatsapp-client";
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
      <Tabs defaultValue="workspaces">
        <TabsList className="flex h-auto flex-wrap justify-start">
          <TabsTrigger value="rules">Rules</TabsTrigger>
          <TabsTrigger value="scripts">Scripts</TabsTrigger>
          <TabsTrigger value="workspaces">Workspaces</TabsTrigger>
          <TabsTrigger value="reading">Reading</TabsTrigger>
          <TabsTrigger value="test">Test</TabsTrigger>
        </TabsList>
        <TabsContent value="rules" className="mt-6">
          <Soon icon={ScrollText} title="Customer and owner rules move here next" text="Until then, edit them under AI operations." />
        </TabsContent>
        <TabsContent value="scripts" className="mt-6">
          <Soon icon={FileText} title="Aiden's fixed texts arrive in the next phase" text="Stranger reply, day-one intro and the rest will be editable here, with safe fallbacks." />
        </TabsContent>
        <TabsContent value="workspaces" className="mt-6">
          <WorkspacesTab />
        </TabsContent>
        <TabsContent value="reading" className="mt-6">
          <Soon icon={BookOpen} title="Reading settings come later" text="Page limits and Firecrawl caps already apply; the editor for them lands in a later phase." />
        </TabsContent>
        <TabsContent value="test" className="mt-6">
          <Soon icon={FlaskConical} title="Test replies without sending" text="Coming in a later phase." />
        </TabsContent>
      </Tabs>
    </div>
  );
}

type Org = { id: string; name: string };

function WorkspacesTab() {
  const [q, setQ] = useState("");
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Org | null>(null);

  useEffect(() => {
    const t = setTimeout(async () => {
      const { data, error: err } = await adminApi({ action: "aiden_orgs", q });
      if (err) setError(err);
      else setOrgs(((data?.["organizations"] as Org[]) ?? []));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  if (error) return <ErrorState message={error} />;

  return (
    <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
      <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search workspaces" className="pl-9" />
        </div>
        <ul className="mt-3 max-h-[60vh] space-y-1 overflow-y-auto">
          {orgs === null
            ? Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-9 w-full rounded-lg" />)
            : orgs.length === 0
              ? <li className="px-2 py-6 text-center text-sm text-muted-foreground">No workspace matches.</li>
              : orgs.map((o) => (
                  <li key={o.id}>
                    <button
                      type="button"
                      onClick={() => setPicked(o)}
                      className={`w-full rounded-lg px-3 py-2 text-left text-sm transition-colors duration-150 ${
                        picked?.id === o.id ? "bg-primary/10 font-medium text-foreground" : "text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      {o.name}
                    </button>
                  </li>
                ))}
        </ul>
      </div>
      {picked ? (
        <WorkspaceBehaviour key={picked.id} org={picked} />
      ) : (
        <EmptyState icon={Building2} title="Pick a workspace" description="Open one to see and edit how Aiden behaves there." />
      )}
    </div>
  );
}

function WorkspaceBehaviour({ org }: { org: Org }) {
  const [versions, setVersions] = useState<InstructionVersion[] | null>(null);
  const [hasAgent, setHasAgent] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: err } = await adminApi({ action: "behaviour_load", organization_id: org.id });
    if (err) return setError(err);
    setHasAgent(Boolean(data?.["agent"]));
    setVersions((data?.["instructions"] as InstructionVersion[]) ?? []);
  }, [org.id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorState message={error} />;
  if (versions === null) return <Skeleton className="h-96 w-full rounded-2xl" />;
  if (!hasAgent)
    return <EmptyState icon={Building2} title={`${org.name} has no AI employee yet`} description="It's created when the workspace finishes onboarding." />;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Editing <span className="font-medium text-foreground">{org.name}</span> — the merchant will see "Updated by AiDwar support".
      </p>
      <BehaviourEditor
        organizationId={org.id}
        versions={versions}
        canConfigure
        onChanged={load}
        api={async (body) => {
          const { error: err } = await adminApi(body);
          if (err) await load();
          return { error: err };
        }}
      />
    </div>
  );
}
