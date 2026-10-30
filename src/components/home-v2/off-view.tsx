import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { CountdownRing, NeedsYouCard, StickyAction } from "@/components/design-v2";
import { HOME_COPY } from "./copy";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { assignConversation } from "@/lib/inbox-actions";
import { timeLeftLabel, waitedFor, type ClosingWindow, type WaitingChat } from "@/lib/new-home";
import type { OpenChat } from "@/lib/new-home-data";
import { cn } from "@/lib/utils";
import {
  Bar,
  HomeAvatar,
  HomeGrid,
  HomeOrb,
  SideSection,
  TodayStats,
  contactName,
  count,
  firstName,
  type StatRow,
} from "./parts";
import type { NewHomeData } from "./use-new-home";

/** Rows shown before "See all in the inbox". */
const QUEUE_ROWS = 6;

/**
 * Batch 45, state 3: Aiden off (or a plan without AI) — your team answers.
 * Who is waiting, oldest first, with the Inbox's own Reply and Assign; the
 * chats about to lose their free 24-hour window; what your flows did today.
 */
export function OffView({
  data,
  organizationId,
  queue,
  closing,
  headlineFor,
  canReply,
  canAssign,
  stats,
  tryDraft,
  greeting,
}: {
  /** Batch 57: "Good morning, Riya", the page's title. */
  greeting?: string | undefined;
  data: NewHomeData;
  organizationId: string;
  queue: WaitingChat[];
  closing: ClosingWindow[];
  headlineFor: (n: number) => string;
  canReply: boolean;
  canAssign: boolean;
  stats: StatRow[];
  /** Set when this person may switch Aiden to drafts (plan has AI, ai.configure). */
  tryDraft: (() => void) | null;
}) {
  const known = data.openChats !== null;
  const byId = new Map((data.openChats ?? []).map((c) => [c.id, c]));
  return (
    <HomeGrid
      orb={<HomeOrb state="off" label={HOME_COPY.orb.off} />}
      greeting={greeting}
      headline={known ? headlineFor(queue.length) : HOME_COPY.off.headlineUnknown}
      lede={
        !known
          ? HOME_COPY.off.ledeUnknown
          : queue.length > 0
            ? HOME_COPY.off.ledeWaiting
            : HOME_COPY.off.ledeNone
      }
      focus={closing.length > 0 ? <ClosingSoon closing={closing} chats={byId} /> : null}
      side={
        <>
          <TodayStats rows={stats} />
          {data.flows ? <FlowsToday flows={data.flows} /> : null}
          {tryDraft ? (
            <p className="m-0 text-[15px] text-muted-foreground">
              {HOME_COPY.off.tryDraftLead}{" "}
              <button
                type="button"
                onClick={tryDraft}
                className="rounded-sm font-bold text-aiden-deep underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden active:opacity-80"
              >
                {HOME_COPY.off.tryDraft}
              </button>
            </p>
          ) : null}
        </>
      }
    >
      {queue.length > 0 ? (
        <ul
          aria-label={HOME_COPY.off.queueLabel}
          className="m-0 flex list-none flex-col gap-2.5 p-0"
        >
          {queue.slice(0, QUEUE_ROWS).map((w, i) => (
            <WaitingRow
              key={w.conversation.id}
              item={w}
              index={i}
              organizationId={organizationId}
              canReply={canReply}
              canAssign={canAssign}
              teammates={data.teammates}
            />
          ))}
          {queue.length > QUEUE_ROWS ? (
            <li>
              <Button asChild variant="outline">
                <a href="/app/inbox">{HOME_COPY.off.seeAll(queue.length)}</a>
              </Button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </HomeGrid>
  );
}

function WaitingRow({
  item,
  index,
  organizationId,
  canReply,
  canAssign,
  teammates,
}: {
  item: WaitingChat;
  index: number;
  organizationId: string;
  canReply: boolean;
  canAssign: boolean;
  teammates: NewHomeData["teammates"];
}) {
  const c = item.conversation as OpenChat;
  const who = contactName(c.contact);
  const [assignedTo, setAssignedTo] = useState<string | null>(c.assigned_to);
  const assignee = teammates.find((t) => t.user_id === assignedTo) ?? null;
  return (
    <li
      className={cn(
        "nd-lift flex items-start gap-3.5 rounded-[18px] border border-line bg-surface px-4 py-3.5 shadow-md phone:p-3",
        index === 0 ? "nd-oldest" : "nd-slide-in",
      )}
      style={{ ["--i" as string]: index }}
    >
      <HomeAvatar seed={c.contact?.id ?? c.id} label={who} />
      <div className="min-w-0 flex-1">
        <div className="flex justify-between gap-2.5 font-bold">
          <span className="min-w-0 truncate">{who}</span>
          <span className="shrink-0 text-sm font-medium text-muted-foreground">
            {HOME_COPY.off.waiting(waitedFor(item.since, Date.now()))}
          </span>
        </div>
        <p className="m-0 mt-0.5 line-clamp-2 text-[15px] text-foreground">{item.said}</p>
        {assignee ? (
          <p className="m-0 mt-1 text-sm text-muted-foreground">
            {HOME_COPY.off.with(assignee.name)}
          </p>
        ) : null}
        <div className="mt-2.5 flex flex-wrap gap-2">
          {canReply ? (
            <Button asChild>
              <a href={`/app/inbox?c=${c.id}`}>{HOME_COPY.off.reply}</a>
            </Button>
          ) : null}
          {canAssign && teammates.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" aria-label={HOME_COPY.off.assignLabel(who)}>
                  {HOME_COPY.off.assign}
                  <ChevronDown aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>{HOME_COPY.off.assignTo}</DropdownMenuLabel>
                {teammates.map((t) => (
                  <DropdownMenuItem
                    key={t.user_id}
                    onSelect={() => {
                      void assignConversation(organizationId, c, t.user_id).then((ok) => {
                        if (ok) setAssignedTo(t.user_id);
                      });
                    }}
                  >
                    {t.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/** The gold card: chats whose free reply window closes within 2 hours, soonest first. */
function ClosingSoon({
  closing,
  chats,
}: {
  closing: ClosingWindow[];
  chats: Map<string, OpenChat>;
}) {
  const soonest = closing[0]!;
  const n = closing.length;
  const name = (id: string) => contactName(chats.get(id)?.contact);
  return (
    <NeedsYouCard
      title={HOME_COPY.off.closingTitle}
      actions={
        <StickyAction>
          <Button asChild variant="gold">
            <a href={`/app/inbox?c=${soonest.conversationId}`}>
              {HOME_COPY.needsYou.reply(firstName(name(soonest.conversationId)))}
            </a>
          </Button>
        </StickyAction>
      }
    >
      <div className="flex items-center gap-3.5">
        <CountdownRing
          remaining={soonest.minutesLeft}
          label={timeLeftLabel(soonest.minutesLeft)}
          className="shrink-0"
        />
        <p>{HOME_COPY.off.closingBody(n)}</p>
      </div>
      <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0 text-sm">
        {closing.slice(0, 3).map((w) => (
          <li key={w.conversationId} className="flex justify-between gap-3">
            <a
              href={`/app/inbox?c=${w.conversationId}`}
              className="min-w-0 truncate font-semibold text-gold-ink underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden"
            >
              {name(w.conversationId)}
            </a>
            <span className="shrink-0 tabular-nums text-gold-ink">
              {timeLeftLabel(w.minutesLeft)}
            </span>
          </li>
        ))}
      </ul>
    </NeedsYouCard>
  );
}

function FlowsToday({ flows }: { flows: NonNullable<NewHomeData["flows"]> }) {
  return (
    <SideSection id="home-flows" title={HOME_COPY.off.flowsTitle}>
      {flows.flows.length === 0 ? (
        <p className="m-0 text-[15px] text-muted-foreground">{HOME_COPY.off.flowsNone}</p>
      ) : (
        flows.flows.slice(0, 4).map((f) => (
          <div key={f.flowId} className="flex flex-col gap-2.5">
            <div className="flex justify-between gap-3 text-sm text-muted-foreground">
              <span className="min-w-0 truncate">{f.name}</span>
              <span className="tabular-nums">{count.format(f.runs)}</span>
            </div>
            <Bar value={flows.total ? (f.runs / flows.total) * 100 : 0} />
          </div>
        ))
      )}
    </SideSection>
  );
}
