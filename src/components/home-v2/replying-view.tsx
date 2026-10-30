import { useState } from "react";
import { MessageCircle } from "lucide-react";
import {
  AnimatedList,
  NeedsYouCard,
  StickyAction,
  TypingDots,
  TypingText,
} from "@/components/design-v2";
import { EmptyState } from "@/components/empty-state";
import {
  DecisionButtons,
  DecisionForm,
  useOpenGap,
  type Decision,
} from "@/components/inbox/v2/owner-decision";
import { Button } from "@/components/ui/button";
import { agoLabel } from "@/lib/new-home";
import type { FeedItem, NeedsYouItem } from "@/lib/new-home-data";
import {
  HomeAvatar,
  HomeGrid,
  HomeOrb,
  LatestCampaign,
  TodayStats,
  contactName,
  count,
  firstName,
  type StatRow,
} from "./parts";
import type { NewHomeData } from "./use-new-home";
import { HOME_COPY } from "./copy";

/** Batch 45, state 1: Aiden is replying. His latest replies on the left, what needs you on the right. */
export function ReplyingView({
  data,
  greeting,
  headline,
  stats,
  organizationId,
  canDecide = false,
  onDecided,
  typing,
}: {
  data: NewHomeData;
  /** Batch 57: "Good morning, Riya", the page's title. */
  greeting?: string | undefined;
  headline: string;
  stats: StatRow[];
  /** Batch 51: with canDecide, Approve / Decline on the first item. */
  organizationId?: string | null | undefined;
  canDecide?: boolean;
  onDecided?: (() => void) | undefined;
  /** Batch 57: chats in the feed whose customer has just written again (live). */
  typing?: ReadonlySet<string> | undefined;
}) {
  const needs = data.needsYou;
  const answered = data.summary?.today.ai_answers ?? null;
  return (
    <HomeGrid
      orb={<HomeOrb state="replying" label={HOME_COPY.orb.replying} />}
      greeting={greeting}
      headline={headline}
      lede={HOME_COPY.replying.lede(answered, needs?.total ?? null)}
      focus={
        needs && needs.items.length > 0 ? (
          <NeedsYou
            items={needs.items}
            total={needs.total}
            organizationId={organizationId}
            canDecide={canDecide}
            onDecided={onDecided}
          />
        ) : null
      }
      side={
        <>
          <TodayStats rows={stats} />
          {data.campaign ? <LatestCampaign campaign={data.campaign} /> : null}
        </>
      }
    >
      {data.feed && data.feed.length > 0 ? (
        <AidenFeed items={data.feed} typing={typing} />
      ) : data.feed ? (
        <EmptyState
          icon={MessageCircle}
          title={HOME_COPY.replying.emptyTitle}
          description={HOME_COPY.replying.emptyBody}
          action={
            <Button asChild variant="outline">
              <a href="/app/employee">{HOME_COPY.replying.emptyAction}</a>
            </Button>
          }
        />
      ) : null}
    </HomeGrid>
  );
}

/** Aiden’s latest replies, newest on top; the newest types itself out. */
function AidenFeed({
  items,
  typing,
}: {
  items: FeedItem[];
  typing?: ReadonlySet<string> | undefined;
}) {
  const now = Date.now();
  // AnimatedList puts its last child on top: hand it oldest first.
  const ordered = items.slice().reverse();
  const newest = items[0]!;
  return (
    <AnimatedList delay={600} role="group" aria-label={HOME_COPY.replying.feedLabel}>
      {ordered.map((it) => {
        const who = contactName(it.contact);
        return (
          <article
            key={`${it.conversationId}-${it.at}`}
            className="nd-lift flex items-start gap-3.5 rounded-[18px] border border-line bg-surface px-4 py-3.5 shadow-md phone:p-3"
          >
            <HomeAvatar seed={it.contact?.id ?? it.conversationId} label={who} />
            <div className="min-w-0 flex-1">
              <div className="flex justify-between gap-2.5 font-bold">
                <span className="min-w-0 truncate">{who}</span>
                <span className="shrink-0 text-sm font-medium text-muted-foreground">
                  {agoLabel(it.at, now)}
                </span>
              </div>
              {it.question ? (
                <p className="m-0 mt-0.5 line-clamp-2 text-[15px] text-muted-foreground">
                  {it.question}
                </p>
              ) : null}
              <div className="mt-2 rounded-[14px_14px_14px_4px] bg-bubble-out px-3 py-[9px] text-[15px]">
                <small className="block text-[13px] font-bold text-aiden-deep">
                  {HOME_COPY.replying.aiden}
                </small>
                {it === newest ? (
                  <TypingText startOnView={false}>{it.reply}</TypingText>
                ) : (
                  <span className="whitespace-pre-line">{it.reply}</span>
                )}
              </div>
              {typing?.has(it.conversationId) ? (
                // Batch 57: the customer has just written again in a chat Aiden
                // answers; the dots go when the reply lands (live) or after a minute.
                <div className="nd-pop mt-2 inline-flex rounded-[14px_14px_14px_4px] bg-bubble-out px-3 py-1.5">
                  <TypingDots label={HOME_COPY.replying.aidenTyping} />
                </div>
              ) : null}
            </div>
          </article>
        );
      })}
    </AnimatedList>
  );
}

/**
 * What only you can answer: chats handed to a person and questions Aiden is
 * holding for you. Batch 51: when the first chat's question is filed under
 * Unanswered and you may decide, Approve / Decline open a box for your own
 * words (owner-decision.tsx, the Unanswered list's answer_gap), and "Reply
 * myself" opens the chat; otherwise the Batch 45 buttons, unchanged.
 */
export function NeedsYou({
  items,
  total,
  organizationId,
  canDecide = false,
  onDecided,
}: {
  items: NeedsYouItem[];
  total: number;
  organizationId?: string | null | undefined;
  canDecide?: boolean;
  onDecided?: (() => void) | undefined;
}) {
  const first = items[0]!;
  const { gap } = useOpenGap(canDecide ? organizationId : null, first.conversationId);
  const [decision, setDecision] = useState<Decision | null>(null);
  const deciding = Boolean(canDecide && organizationId && gap && first.conversationId);
  const others = items.slice(1);
  const more = total - items.length;
  return (
    <NeedsYouCard
      title={HOME_COPY.needsYou.title(total)}
      actions={
        deciding ? (
          <>
            <DecisionButtons picked={decision} onPick={setDecision} />
            <Button asChild variant="outline">
              <a href={`/app/inbox?c=${first.conversationId}`}>{HOME_COPY.needsYou.replyMyself}</a>
            </Button>
          </>
        ) : (
          <>
            {first.conversationId ? (
              <StickyAction>
                <Button asChild variant="gold">
                  <a href={`/app/inbox?c=${first.conversationId}`}>
                    {HOME_COPY.needsYou.reply(firstName(first.who))}
                  </a>
                </Button>
              </StickyAction>
            ) : null}
            {total > 1 || !first.conversationId ? (
              <Button asChild variant="outline">
                <a href="/app/inbox">{HOME_COPY.needsYou.openInbox}</a>
              </Button>
            ) : null}
          </>
        )
      }
    >
      {/* Batch 57: one customer up front, the rest named on one line. */}
      <p className="text-sm font-semibold text-gold-ink">{HOME_COPY.needsYou.asked(first.who)}</p>
      <p className="mt-0.5 text-[17px] leading-snug">“{first.question}”</p>
      {others.length > 0 ? (
        <p className="mt-2 text-sm text-gold-ink">
          {HOME_COPY.needsYou.alsoWaiting(
            others.map((it) => firstName(it.who)),
            Math.max(0, more),
          )}
        </p>
      ) : more > 0 ? (
        <p className="mt-2 text-sm text-gold-ink">{count.format(more)} more in the Inbox.</p>
      ) : null}
      {deciding && decision && gap ? (
        <DecisionForm
          className="mt-3 bg-surface"
          organizationId={organizationId!}
          gap={gap}
          decision={decision}
          who={firstName(first.who)}
          onCancel={() => setDecision(null)}
          onDone={() => {
            setDecision(null);
            onDecided?.();
          }}
        />
      ) : null}
    </NeedsYouCard>
  );
}
