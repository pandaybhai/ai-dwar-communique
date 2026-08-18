import { useCallback, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Bot, Lock } from "lucide-react";
import { toast } from "sonner";
import { EmptyState, PageHeader, PageSkeleton } from "@/components/empty-state";
import { BehaviourEditor } from "@/components/employee/behaviour-editor";
import { BrainPicker } from "@/components/employee/brain-picker";
import { KnowledgeManager } from "@/components/employee/knowledge-manager";
import { Playground } from "@/components/employee/playground";
import { ToolsList } from "@/components/employee/tools-list";
import { WeeklyReport } from "@/components/employee/weekly-report";
import { WorkLog } from "@/components/employee/work-log";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePermissions } from "@/hooks/use-permissions";
import { employeeApi, moneyText, type EmployeeOverview } from "@/lib/employee-client";
import { useOrg } from "@/lib/org-context";



const DESCRIPTION =
  "Your AI employee: what I know, how I behave, and every answer I've given. Start me on drafts, read my work, then let me reply.";

export const Route = createFileRoute("/app/employee")({
  head: () => ({
    meta: [
      { title: "AI employee — AiDwar" },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: "AI employee — AiDwar" },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: EmployeePage,
});

const MODES = [
  { key: "off", label: "Off", blurb: "I do nothing. Your team handles every message." },
  { key: "draft", label: "Draft only", blurb: "I write replies. You read them and send them." },
  {
    key: "replying",
    label: "Replying",
    blurb: "I reply to customers myself, and pass anything I'm unsure about to you.",
  },
] as const;

function EmployeePage() {
  const { active, loading: orgLoading } = useOrg();
  const { can, loading: permsLoading } = usePermissions();
  const organizationId = active?.organization.id ?? null;

  const [overview, setOverview] = useState<EmployeeOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("knows");

  const load = useCallback(async () => {
    if (!organizationId) return;
    const { data, error } = await employeeApi<EmployeeOverview>({
      organization_id: organizationId,
      action: "overview",
    });
    if (error) toast.error(error);
    setOverview(data);
    setLoading(false);
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const setMode = async (mode: string) => {
    if (!organizationId) return;
    const { error, raw } = await employeeApi({
      organization_id: organizationId,
      action: "set_mode",
      mode,
    });
    const needsTest = (raw as { needs_test?: boolean } | null)?.needs_test;
    if (needsTest) {
      toast.warning((raw as { message: string }).message);
      return;
    }
    if (error) toast.error(error);
    else {
      toast.success("Saved.");
      void load();
    }
  };

  if (orgLoading || permsLoading) return <PageSkeleton />;
  if (!active) {
    return (
      <EmptyState
        icon={Bot}
        title="No workspace selected"
        description="Pick a workspace from the switcher and I\u2019ll show you my work there."
      />
    );
  }
  if (!can("ai.use")) {
    return (
      <EmptyState
        icon={Lock}
        title="The AI employee is restricted"
        description='You need the "Use AI" permission for this workspace. Ask an owner or admin to grant it.'
      />
    );
  }

  const canConfigure = can("ai.configure");
  const mode = overview?.agent?.mode ?? "off";
  const currency = overview?.settings?.currency ?? "INR";
  const aiEnabled = overview?.settings?.ai_enabled !== false;

  const setAiEnabled = async (value: boolean): Promise<boolean> => {
    if (!organizationId) return false;
    const { error } = await employeeApi({
      organization_id: organizationId,
      action: "save_settings",
      ai_enabled: value,
    });
    if (error) {
      toast.error(error);
      return false;
    }
    toast.success(value ? "AI is on." : "AI is off.");
    await load();
    return true;
  };

  const enableAi = () => setAiEnabled(true);


  return (
    <>
      <PageHeader title={overview?.agent?.name ?? "Your AI employee"} description={DESCRIPTION} />

      {loading ? (
        <PageSkeleton />
      ) : (
        <div className="space-y-10">
          {!aiEnabled ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 p-5">
              <div>
                <p className="text-sm font-semibold text-foreground">I'm switched off here</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  I won't answer, draft or even test until you turn me on for this workspace.
                </p>
              </div>
              <Button disabled={!canConfigure} onClick={() => void setAiEnabled(true)}>
                Turn me on
              </Button>
            </div>
          ) : null}
          <section
            aria-labelledby="mode-heading"
            className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="mode-heading" className="text-lg font-semibold text-foreground">
                What I'm doing right now
              </h2>
              <Badge variant={mode === "off" ? "secondary" : "default"}>
                {MODES.find((m) => m.key === mode)?.label ?? "Not working"}
              </Badge>
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-3">
              {MODES.map((option) => {
                const activeMode = option.key === mode;
                return (
                  <button
                    key={option.key}
                    type="button"
                    disabled={!canConfigure}
                    aria-pressed={activeMode}
                    onClick={() => setMode(option.key)}
                    className={`rounded-xl border p-4 text-left transition-all duration-200 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 ${
                      activeMode
                        ? "border-primary bg-primary/5 shadow-sm"
                        : "border-border/70 hover:border-primary/40 hover:shadow-sm"
                    }`}
                  >
                    <span className="block text-sm font-medium text-foreground">{option.label}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">{option.blurb}</span>
                  </button>
                );
              })}
            </div>

            <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
              Off: I do nothing. Draft only: I write replies, you send them. Replying: I reply to
              customers myself, and pass anything I'm unsure about to you.
            </p>

            <dl className="mt-6 grid gap-4 sm:grid-cols-3">
              <Stat label="I answered this week" value={String(overview?.week.answered ?? 0)} />
              <Stat label="I passed to you" value={String(overview?.week.passed ?? 0)} />
              <Stat
                label="I cost you this month"
                value={moneyText(overview?.spend_this_month ?? 0, currency)}
              />
            </dl>

            {!overview?.tested_recently && canConfigure ? (
              <p className="mt-5 rounded-xl bg-muted/50 p-4 text-sm text-muted-foreground">
                You haven't tried me yet. Ask me your last 20 real customer questions before you
                let me reply on my own.
              </p>
            ) : null}
          </section>

          <WeeklyReport
            organizationId={active.organization.id}
            currency={currency}
            canConfigure={canConfigure}
          />

          <Tabs value={tab} onValueChange={setTab} className="space-y-6">
            <TabsList className="flex w-full flex-wrap justify-start gap-1">
              <TabsTrigger value="knows">What I know</TabsTrigger>
              <TabsTrigger value="behaviour">How I behave</TabsTrigger>
              <TabsTrigger value="brains">My brain &amp; tools</TabsTrigger>
              <TabsTrigger value="try">Try me</TabsTrigger>
              <TabsTrigger value="work">My work</TabsTrigger>
            </TabsList>

            <TabsContent value="knows">
              <KnowledgeManager
                organizationId={active.organization.id}
                sources={overview?.sources ?? []}
                loading={false}
                canConfigure={canConfigure}
                onChanged={load}
              />
            </TabsContent>

            <TabsContent value="behaviour">
              <BehaviourEditor
                organizationId={active.organization.id}
                versions={overview?.instructions ?? []}
                canConfigure={canConfigure}
                onChanged={load}
              />
            </TabsContent>

            <TabsContent value="brains" className="space-y-6">
              <BrainPicker
                organizationId={active.organization.id}
                models={overview?.models ?? []}
                taskModels={overview?.task_models ?? []}
                settings={overview?.settings ?? null}
                spendThisMonth={overview?.spend_this_month ?? 0}
                canConfigure={canConfigure}
                onChanged={load}
              />
              <ToolsList tools={overview?.tools ?? []} />
            </TabsContent>

            <TabsContent value="try">
              <Playground
                organizationId={active.organization.id}
                models={overview?.models ?? []}
                currency={currency}
                onRan={load}
                {...(canConfigure ? { onEnableAi: enableAi } : {})}
              />

            </TabsContent>

            <TabsContent value="work">
              <WorkLog
                organizationId={active.organization.id}
                currency={currency}
                onRaiseLimit={() => setTab("brains")}
              />
            </TabsContent>
          </Tabs>

          {!canConfigure ? (
            <p className="text-sm text-muted-foreground">
              You can see everything I do. Changing how I work needs the "Configure AI" permission.
            </p>
          ) : (
            <div>
              <Button variant="outline" onClick={() => void load()}>
                Refresh
              </Button>
            </div>
          )}

        </div>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/70 bg-muted/30 p-4">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tracking-tight text-foreground">{value}</dd>
    </div>
  );
}
