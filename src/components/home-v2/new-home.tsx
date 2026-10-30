import { useCallback, useMemo } from "react";
import { ConnectAssistantCard } from "@/components/ai-assistants/connect-card";
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
  closingWindows,
  draftsHeadline,
  replyingHeadline,
  waitingHeadline,
  waitingQueue,
  type HomeMode,
} from "@/lib/new-home";
import { Inbox } from "lucide-react";
import { ModeSwitch, TestFirstDialog, type StatRow } from "./parts";
import { ReplyingView } from "./replying-view";
import { DraftsView } from "./drafts-view";
import { OffView } from "./off-view";
import { useNewHome, type HomeAccess } from "./use-new-home";
import { HOME_COPY } from "./copy";
import { greetingFor } from "@/lib/greeting";
import { canDecide } from "@/components/inbox/v2/owner-decision";

/**
 * Batch 45: Home in the new design (docs/design/preview.html #home), shown
 * only with the new_design flag on. Which of the three it is follows the mode
 * Aiden really runs in: replying (his live work), drafts (replies waiting for
 * you) or off (customers waiting on the team; also every plan without AI).
 */
export function NewHome() {
  const { active, loading: orgLoading, profile } = useOrg();
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
    [
      ready,
      aiFlag.enabled,
      campaignsFlag.enabled,
      flowsFlag.enabled,
      flowsV2Flag.enabled,
      revenueFlag.enabled,
      billingFlag.enabled,
      can,
    ],
  );
  const { data, loading, reload, typing } = useNewHome(organizationId, timezone, access);
  const greeting = greetingFor(profile?.full_name, timezone);
  const onChanged = useCallback(() => void reload(), [reload]);
  const modeSwitch = useAidenModeSwitch(organizationId, onChanged);

  if (!orgLoading && !active) {
    return (
      <EmptyState
        icon={Inbox}
        title={HOME_COPY.noWorkspace.title}
        description={HOME_COPY.noWorkspace.body}
      />
    );
  }

  const mode = data.mode;
  const canSeeAiden = Boolean(access?.aiPlan) && can("ai.use");
  const canChange = can("ai.configure");

  return (
    // Batch 57: room below for the phone's sticky main action.
    <div className="flex flex-col gap-6 pb-10 phone:pb-20">
      <JourneyResume organizationId={organizationId} isOwner={active?.role === "owner"} />
      <SendHealthBanner organizationId={organizationId} showLink />
      <AidenSetupCard organizationId={organizationId} showFinished />
      <PersonaReviewBanner organizationId={organizationId} />
      <ConnectAssistantCard className="" />

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
        <ReplyingView
          data={data}
          greeting={greeting}
          typing={typing}
          headline={replyingHeadline(data.active ?? 0)}
          stats={todayStats(data, "replying")}
          organizationId={organizationId}
          canDecide={canDecide(can)}
          onDecided={() => void reload()}
        />
      ) : mode === "draft" ? (
        <DraftsView
          greeting={greeting}
          data={data}
          organizationId={organizationId!}
          canReply={can("inbox.reply")}
          canDecide={canDecide(can)}
          stats={todayStats(data, "draft")}
          headlineFor={draftsHeadline}
          onSent={() => void reload()}
        />
      ) : (
        <OffView
          greeting={greeting}
          data={data}
          organizationId={organizationId!}
          queue={waitingQueue(data.openChats ?? [], Date.now())}
          closing={closingWindows(
            (data.openChats ?? []).map((c) => ({
              conversationId: c.id,
              lastInboundAt: c.lastInboundAt,
            })),
            Date.now(),
          )}
          headlineFor={waitingHeadline}
          canReply={can("inbox.view")}
          canAssign={can("inbox.assign")}
          stats={todayStats(data, "off")}
          tryDraft={canSeeAiden && canChange ? () => void modeSwitch.setMode("draft") : null}
        />
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
  const L = HOME_COPY.todayRows;
  if (s) rows.push({ label: L.chats, value: s.today.conversations });
  if (mode === "replying" && s) rows.push({ label: L.answered, value: s.today.ai_answers });
  if (mode === "draft" && data.draftsToday !== null)
    rows.push({ label: L.drafts, value: data.draftsToday });
  if (mode === "off" && data.flows) rows.push({ label: L.flows, value: data.flows.total });
  if (data.sales)
    rows.push({ label: data.sales.label, value: data.sales.value, currency: data.sales.currency });
  return rows;
}

function HomeSkeleton() {
  return (
    <div
      className="grid items-start gap-10 min-[901px]:grid-cols-[minmax(0,7fr)_minmax(0,4fr)]"
      aria-busy="true"
      aria-label={HOME_COPY.loading}
    >
      <div className="flex flex-col gap-[22px]">
        <div className="flex items-center gap-5 phone:gap-3.5">
          <AidenOrb state="off" size={72} className="opacity-60 phone:hidden" />
          <div className="flex flex-1 flex-col gap-2.5">
            <Skeleton className="h-12 w-3/4 rounded-xl" />
            <Skeleton className="h-6 w-1/2 rounded-lg" />
          </div>
        </div>
        <Skeleton className="h-5 w-2/3 rounded-lg" />
        <Skeleton className="h-32 rounded-[20px]" />
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
