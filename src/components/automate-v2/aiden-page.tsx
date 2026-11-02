import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Bot, Lock } from "lucide-react";
import { toast } from "sonner";
import { AidenSetupCard } from "@/components/aiden-setup-card";
import { EmptyState, PageHeader, PageSkeleton } from "@/components/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { BehaviourEditor } from "@/components/employee/behaviour-editor";
import { BrainPicker } from "@/components/employee/brain-picker";
import { CorrectionsList } from "@/components/employee/corrections-list";
import { FormsManager } from "@/components/employee/forms-manager";
import { HandoffAlertsCard } from "@/components/employee/handoff-alerts-card";
import { KnowledgeManager, UnansweredList } from "@/components/employee/knowledge-manager";
import { Playground } from "@/components/employee/playground";
import { PriceReviewsCard } from "@/components/employee/price-reviews-card";
import { PromptPreview } from "@/components/employee/prompt-preview";
import { SkillsManager } from "@/components/employee/skills-manager";
import { ToolsList } from "@/components/employee/tools-list";
import { WeeklyReport } from "@/components/employee/weekly-report";
import { WorkLog } from "@/components/employee/work-log";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAidenModeSwitch } from "@/hooks/use-aiden-mode-switch";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { usePendingGapCount } from "@/hooks/use-pending-gaps";
import { usePermissions } from "@/hooks/use-permissions";
import { employeeApi, type EmployeeOverview } from "@/lib/employee-client";
import { useOrg } from "@/lib/org-context";
import { AidenKnows } from "./aiden-knows";
import { AidenReview } from "./aiden-review";
import { AidenStatusCard } from "./aiden-status-card";
import { aidenPage as t } from "./copy";
import { TestAiden } from "./test-aiden";

/** Batch 57: blocks arrive one after another (styles.css .nd-rise; still under reduced motion). */
const rise = (d: number) => ({ "--d": d }) as CSSProperties;

export type EmployeeTab =
  "job" | "knows" | "gaps" | "behaviour" | "brains" | "forms" | "try" | "work";

/**
 * Batch 49: Automate > Aiden in the new design (new_design on). The top is
 * new and only reads, or calls what the Employee page already calls: the
 * status card (set_mode through the shared useAidenModeSwitch, save_settings
 * for Turn on), Test Aiden (the Playground's "playground" run), what needs
 * the owner (gaps / answer_gap / dismiss_gap, work / correct) and what Aiden
 * knows (the overview's sources). Below it, every control the Employee page
 * has, the same components with the same props: the weekly report and the
 * My job, What I know, Questions for you, How I behave, My brain & tools,
 * Forms, Try me and My work tabs. With new_design off /app/employee is the
 * classic EmployeePage, untouched.
 */
export function NewAidenPage() {
  const { active, loading: orgLoading } = useOrg();
  const { can, loading: permsLoading } = usePermissions();
  const organizationId = active?.organization.id ?? null;

  const [overview, setOverview] = useState<EmployeeOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<EmployeeTab>("knows");
  const formsOn = useFeatureFlag("wa_forms").enabled;
  const catalogsOn = useFeatureFlag("catalogs").enabled;
  const [compareRequest, setCompareRequest] = useState(0);
  const [dataVersion, setDataVersion] = useState(0);
  const [turningOn, setTurningOn] = useState(false);
  const gapCount = usePendingGapCount(organizationId);
  const tabsRef = useRef<HTMLDivElement>(null);

  // The Employee page's load: one "overview" read.
  const load = useCallback(async () => {
    if (!organizationId) return;
    const { data, error } = await employeeApi<EmployeeOverview>({
      organization_id: organizationId,
      action: "overview",
    });
    if (error) toast.error(error);
    setOverview(data);
    setDataVersion((v) => v + 1);
    setLoading(false);
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const onModeChanged = useCallback(() => void load(), [load]);
  const { setMode, busy, gate, closeGate } = useAidenModeSwitch(organizationId, onModeChanged);

  const openTab = (next: EmployeeTab) => {
    setTab(next);
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    requestAnimationFrame(() =>
      tabsRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" }),
    );
  };

  if (orgLoading || permsLoading) return <PageSkeleton />;
  if (!active) {
    return (
      <EmptyState icon={Bot} title={t.noWorkspace.title} description={t.noWorkspace.description} />
    );
  }
  if (!can("ai.use")) {
    return (
      <EmptyState icon={Lock} title={t.restricted.title} description={t.restricted.description} />
    );
  }

  const canConfigure = can("ai.configure");
  const name = overview?.agent?.name?.trim() || "Aiden";
  const currency = overview?.settings?.currency ?? "INR";
  const aiEnabled = overview?.settings?.ai_enabled !== false;

  // The Employee page's setAiEnabled: save_settings with ai_enabled.
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
    toast.success(value ? t.aiOnToast : t.aiOffToast);
    await load();
    return true;
  };
  const enableAi = () => setAiEnabled(true);
  const turnOn = async () => {
    setTurningOn(true);
    await setAiEnabled(true);
    setTurningOn(false);
  };

  return (
    <>
      <PageHeader title={name} description={t.description(name)} />
      <AidenSetupCard organizationId={organizationId} />

      {loading ? (
        <AidenSkeleton />
      ) : (
        <div className="flex flex-col gap-10 phone:gap-8">
          {/* Batch 57: the status card, then what needs the owner, lead; the test chat and what Aiden knows sit beside them. */}
          <div className="grid items-start gap-x-10 gap-y-8 wide:grid-cols-[minmax(0,7fr)_minmax(0,4fr)]">
            <div className="flex min-w-0 flex-col gap-8">
              <AidenStatusCard
                name={name}
                mode={overview?.agent?.mode}
                aiEnabled={aiEnabled}
                canConfigure={canConfigure}
                busy={busy}
                onSetMode={(m) => void setMode(m)}
                onTurnOn={() => void turnOn()}
                turningOn={turningOn}
                week={{
                  answered: overview?.week.answered ?? 0,
                  passed: overview?.week.passed ?? 0,
                }}
                spend={overview?.spend_this_month ?? 0}
                currency={currency}
                testedRecently={Boolean(overview?.tested_recently)}
              />
              <div className="nd-rise" style={rise(1)}>
                <AidenReview
                  organizationId={active.organization.id}
                  name={name}
                  canConfigure={canConfigure}
                  onChanged={() => void load()}
                  onSeeAll={openTab}
                />
              </div>
            </div>
            <div className="flex min-w-0 flex-col gap-8">
              <div className="nd-rise" style={rise(2)}>
                <TestAiden
                  organizationId={active.organization.id}
                  name={name}
                  currency={currency}
                  onRan={load}
                  {...(canConfigure ? { onEnableAi: enableAi } : {})}
                  onCompare={() => {
                    openTab("try");
                    setCompareRequest((n) => n + 1);
                  }}
                />
              </div>
              <div className="nd-rise" style={rise(3)}>
                <AidenKnows
                  organizationId={active.organization.id}
                  name={name}
                  sources={overview?.sources ?? []}
                  catalogueOn={catalogsOn && can("catalog.view")}
                  onManage={() => openTab("knows")}
                />
              </div>
            </div>
          </div>

          <div className="nd-rise" style={rise(4)}>
            <WeeklyReport
              organizationId={active.organization.id}
              currency={currency}
              canConfigure={canConfigure}
            />
          </div>

          <div ref={tabsRef} className="scroll-mt-24 flex flex-col gap-4">
            <div>
              <h2 className="m-0 font-display text-[1.375rem] font-semibold">
                {t.everythingHeading(name)}
              </h2>
              <p className="m-0 mt-1 text-sm text-muted-foreground">{t.everythingLine}</p>
            </div>
            <Tabs value={tab} onValueChange={(v) => setTab(v as EmployeeTab)} className="space-y-6">
              <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1">
                <TabsTrigger value="job">{t.tabs.job}</TabsTrigger>
                <TabsTrigger value="knows">{t.tabs.knows}</TabsTrigger>
                <TabsTrigger value="gaps">
                  {t.tabs.gaps}
                  {gapCount > 0 ? (
                    <Badge variant="secondary" className="ml-2">
                      {gapCount}
                    </Badge>
                  ) : null}
                </TabsTrigger>
                <TabsTrigger value="behaviour">{t.tabs.behaviour}</TabsTrigger>
                <TabsTrigger value="brains">{t.tabs.brains}</TabsTrigger>
                {formsOn ? <TabsTrigger value="forms">{t.tabs.forms}</TabsTrigger> : null}
                <TabsTrigger value="try">{t.tabs.try}</TabsTrigger>
                <TabsTrigger value="work">{t.tabs.work}</TabsTrigger>
              </TabsList>

              <TabsContent value="job">
                <SkillsManager
                  organizationId={active.organization.id}
                  agentName={overview?.agent?.name ?? "Your AI employee"}
                  canConfigure={canConfigure}
                  onChanged={load}
                />
              </TabsContent>

              <TabsContent value="knows" className="space-y-6">
                <PriceReviewsCard
                  organizationId={active.organization.id}
                  canConfigure={canConfigure}
                />
                <KnowledgeManager
                  organizationId={active.organization.id}
                  sources={overview?.sources ?? []}
                  loading={false}
                  canConfigure={canConfigure}
                  onChanged={load}
                />
                <CorrectionsList
                  organizationId={active.organization.id}
                  agentName={overview?.agent?.name ?? "your AI employee"}
                  canConfigure={canConfigure}
                />
              </TabsContent>

              <TabsContent value="gaps">
                <UnansweredList
                  organizationId={active.organization.id}
                  canConfigure={canConfigure}
                  onChanged={load}
                />
              </TabsContent>

              <TabsContent value="behaviour" className="space-y-6">
                <BehaviourEditor
                  organizationId={active.organization.id}
                  versions={overview?.instructions ?? []}
                  canConfigure={canConfigure}
                  onChanged={load}
                />
                <HandoffAlertsCard
                  organizationId={active.organization.id}
                  canConfigure={canConfigure}
                />
                <PromptPreview
                  organizationId={active.organization.id}
                  agentName={overview?.agent?.name ?? "your AI employee"}
                  currency={currency}
                  refreshKey={dataVersion}
                />
              </TabsContent>

              {formsOn ? (
                <TabsContent value="forms">
                  <FormsManager
                    organizationId={active.organization.id}
                    canConfigure={canConfigure}
                  />
                </TabsContent>
              ) : null}

              <TabsContent value="brains" className="space-y-6">
                <BrainPicker
                  organizationId={active.organization.id}
                  tiers={overview?.tiers ?? []}
                  internals={overview?.tier_internals ?? null}
                  taskTiers={overview?.task_models ?? []}
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
                  tiers={overview?.tiers ?? []}
                  internals={overview?.tier_internals ?? null}
                  currency={currency}
                  onRan={load}
                  compareRequest={compareRequest}
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
          </div>

          {canConfigure ? (
            <div>
              <Button variant="outline" className="phone:h-11" onClick={() => void load()}>
                {t.refresh}
              </Button>
            </div>
          ) : null}
        </div>
      )}

      {/* The Employee page's test gate, word for word. */}
      <AlertDialog open={gate !== null} onOpenChange={(open) => !open && closeGate()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.gate.title}</AlertDialogTitle>
            <AlertDialogDescription>{gate?.message ?? t.gate.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.gate.notNow}</AlertDialogCancel>
            <Button
              variant="outline"
              onClick={() => {
                const mode = gate?.mode;
                closeGate();
                if (mode) void setMode(mode, true);
              }}
            >
              {t.gate.anyway}
            </Button>
            <AlertDialogAction
              onClick={() => {
                closeGate();
                openTab("try");
                setCompareRequest((n) => n + 1);
              }}
            >
              {t.gate.run}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Batch 57: loading in the page's own shape (it shimmers in Aiden Workspace). */
function AidenSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading"
      className="grid items-start gap-x-10 gap-y-8 wide:grid-cols-[minmax(0,7fr)_minmax(0,4fr)]"
    >
      <div className="flex min-w-0 flex-col gap-8">
        <Skeleton className="h-80 rounded-[20px]" />
        <Skeleton className="h-40 rounded-[20px]" />
      </div>
      <div className="flex min-w-0 flex-col gap-8">
        <Skeleton className="h-[440px] rounded-[20px]" />
        <Skeleton className="h-48 rounded-[20px]" />
      </div>
    </div>
  );
}
