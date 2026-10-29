import { useCallback, useMemo } from "react";
import { AidenSetupCard } from "@/components/aiden-setup-card";
import { JourneyResume } from "@/components/onboarding/journey-resume";
import { PersonaReviewBanner } from "@/components/persona-review-banner";
import { SendHealthBanner } from "@/components/send-health-banner";
import { EmptyState } from "@/components/empty-state";
import { AidenOrb } from "@/components/design-v2";
import { Skeleton } from "@/components/ui/skeleton";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { usePermissions } from "@/hooks/use-permissions";
import { useAidenModeSwitch } from "@/hooks/use-aiden-mode-switch";
import { useOrg } from "@/lib/org-context";
import {
  draftsHeadline,
  replyingHeadline,
  waitingHeadline,
  type HomeMode,
} from "@/lib/new-home";
import { Inbox } from "lucide-react";
import { ModeSwitch, TestFirstDialog, type StatRow } from "./parts";
import { ReplyingView } from "./replying-view";
import { useNewHome, type HomeAccess } from "./use-new-home";

/**
 * Batch 45: Home in the new design (docs/design/preview.html #home), shown
 * only with the new_design flag on. Which of the three it is follows the mode
 * Aiden really runs in: replying (his live work), drafts (replies waiting for
 * you) or off (customers waiting on the team; also every plan without AI).
 */
export function NewHome() {
  const { active, loading: orgLoading } = useOrg();
  const { can, loading: permsLoading } = usePermissions();
  const aiFlag = useFeatureFlag("ai_features");
  const campaignsFlag = useFeatureFlag("campaigns");
  const flowsFlag = useFeatureFlag("flows");
  // Flow runs are recorded by Flows v2 only (legacy event flows keep no runs).
  const flowsV2Flag = useFeatureFlag("flows_v2");
  const revenueFlag = useFeatureFlag("revenue_attribution");
  const billingFlag = useFeatureFlag("billing");
  const organizationId = active?.organization.id ?? null;
  const timezone = active?.organization.timezone || "Asia/Kolkata";

  const ready = !permsLoading && !aiFlag.loading;
  const access: HomeAccess | null = useMemo(
    () =>
      ready
        ? {
            aiPlan: aiFlag.enabled,
            campaigns: campaignsFlag.enabled && can("campaigns.view"),
            flows: flowsFlag.enabled && flowsV2Flag.enabled && can("flows.view"),
            revenue: revenueFlag.enabled && can("revenue.view"),
            billing: billingFlag.enabled && can("billing.view"),
            teammates: can("inbox.assign"),
          }
        : null,
    [ready, aiFlag.enabled, campaignsFlag.enabled, flowsFlag.enabled, flowsV2Flag.enabled, revenueFlag.enabled, billingFlag.enabled, can],
  );
  const { data, loading, reload } = useNewHome(organizationId, timezone, access);
  const onChanged = useCallback(() => void reload(), [reload]);
  const modeSwitch = useAidenModeSwitch(organizationId, onChanged);

  if (!orgLoading && !active) {
    return (
      <EmptyState
        icon={Inbox}
        title="No workspace selected"
        description="Pick a workspace from the switcher to see today's overview."
      />
    );
  }

  const mode = data.mode;
  const canSeeAiden = Boolean(access?.aiPlan) && can("ai.use");
  const canChange = can("ai.configure");

  return (
    <div className="flex flex-col gap-6 pb-10">
      <JourneyResume organizationId={organizationId} isOwner={active?.role === "owner"} />
      <SendHealthBanner organizationId={organizationId} showLink />
      <AidenSetupCard organizationId={organizationId} showFinished />
      <PersonaReviewBanner organizationId={organizationId} />

      {mode && canSeeAiden ? (
        <ModeSwitch
          mode={mode}
          canChange={canChange}
          busy={modeSwitch.busy}
          onChange={(m: HomeMode) => void modeSwitch.setMode(m)}
        />
      ) : null}

      {loading || !mode ? (
        <HomeSkeleton />
      ) : mode === "replying" ? (
        <ReplyingView data={data} headline={replyingHeadline(data.active ?? 0)} stats={todayStats(data, "replying")} />
      ) : (
        // Batch 45: the Draft and Off Homes land in the next commits.
        <p className="m-0 text-muted-foreground">{mode === "draft" ? draftsHeadline(0) : waitingHeadline(0)}</p>
      )}

      <TestFirstDialog
        gate={modeSwitch.gate}
        onClose={modeSwitch.closeGate}
        onSwitchAnyway={(m) => void modeSwitch.setMode(m, true)}
      />
    </div>
  );
}

/** Today's rows for each Home; a number that wasn't read is left out. */
function todayStats(data: ReturnType<typeof useNewHome>["data"], mode: HomeMode): StatRow[] {
  const rows: StatRow[] = [];
  const s = data.summary;
  if (s) rows.push({ label: "Chats", value: s.today.conversations });
  if (mode === "replying" && s) rows.push({ label: "Answered by Aiden", value: s.today.ai_answers });
  if (mode === "draft" && data.draftsToday !== null)
    rows.push({ label: "Drafts Aiden wrote", value: data.draftsToday });
  if (mode === "off" && data.flows) rows.push({ label: "Flow runs", value: data.flows.total });
  if (data.sales) rows.push({ label: data.sales.label, value: data.sales.value, currency: data.sales.currency });
  return rows;
}


function HomeSkeleton() {
  return (
    <div
      className="grid items-start gap-10 min-[901px]:grid-cols-[minmax(0,7fr)_minmax(0,4fr)]"
      aria-busy="true"
      aria-label="Loading"
    >
      <div className="flex flex-col gap-[22px]">
        <div className="flex items-center gap-5 phone:gap-3.5">
          <AidenOrb state="off" size={72} className="opacity-60 phone:hidden" />
          <Skeleton className="h-12 w-3/4 rounded-xl" />
        </div>
        <Skeleton className="h-6 w-1/2 rounded-lg" />
        <Skeleton className="h-28 rounded-[18px]" />
        <Skeleton className="h-28 rounded-[18px]" />
      </div>
      <div className="flex flex-col gap-7">
        <Skeleton className="h-36 rounded-[20px]" />
        <Skeleton className="h-40 rounded-[20px]" />
      </div>
    </div>
  );
}
