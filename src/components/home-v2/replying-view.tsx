import { AnimatedList, NeedsYouCard, TypingText } from "@/components/design-v2";
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

/** Batch 45, state 1: Aiden is replying. His latest replies on the left, what needs you on the right. */
export function ReplyingView({
  data,
  headline,
  stats,
}: {
  data: NewHomeData;
  headline: string;
  stats: StatRow[];
}) {
  const needs = data.needsYou;
  const answered = data.summary?.today.ai_answers ?? null;
  return (
    <HomeGrid
      orb={<HomeOrb state="replying" label="Aiden is replying" />}
      headline={headline}
      lede={replyingLede(answered, needs?.total ?? null)}
      side={
        <>
          {needs && needs.items.length > 0 ? <NeedsYou items={needs.items} total={needs.total} /> : null}
          <TodayStats rows={stats} />
          {data.campaign ? <LatestCampaign campaign={data.campaign} /> : null}
        </>
      }
    >
      {data.feed && data.feed.length > 0 ? (
        <AidenFeed items={data.feed} />
      ) : data.feed ? (
        <p className="m-0 rounded-[18px] border border-line bg-surface px-4 py-3.5 text-muted-foreground shadow-md">
          Aiden's replies show here the moment he sends them.
        </p>
      ) : null}
    </HomeGrid>
  );
}

function replyingLede(answered: number | null, needs: number | null): string {
  const first =
    answered === null
      ? ""
      : answered === 0
        ? "No replies from Aiden yet today."
        : `Aiden has sent ${count.format(answered)} ${answered === 1 ? "reply" : "replies"} today.`;
  const second =
    needs === null
      ? ""
      : needs === 0
        ? "Nothing needs you right now."
        : needs === 1
          ? "One thing needs you."
          : `${count.format(needs)} things need you.`;
  return [first, second].filter(Boolean).join(" ") || "Aiden answers your customers as they write.";
}

/** Aiden's latest replies, newest on top; the newest types itself out. */
function AidenFeed({ items }: { items: FeedItem[] }) {
  const now = Date.now();
  // AnimatedList puts its last child on top: hand it oldest first.
  const ordered = items.slice().reverse();
  const newest = items[0]!;
  return (
    <AnimatedList delay={600} aria-label="Aiden's latest replies">
      {ordered.map((it) => {
        const who = contactName(it.contact);
        return (
          <article
            key={`${it.conversationId}-${it.at}`}
            className="flex items-start gap-3.5 rounded-[18px] border border-line bg-surface px-4 py-3.5 shadow-md phone:p-3"
          >
            <HomeAvatar seed={it.contact?.id ?? it.conversationId} label={who} />
            <div className="min-w-0 flex-1">
              <div className="flex justify-between gap-2.5 font-bold">
                <span className="min-w-0 truncate">{who}</span>
                <span className="shrink-0 text-sm font-medium text-muted-foreground">{agoLabel(it.at, now)}</span>
              </div>
              {it.question ? (
                <p className="m-0 mt-0.5 line-clamp-2 text-[15px] text-muted-foreground">{it.question}</p>
              ) : null}
              <div className="mt-2 rounded-[14px_14px_14px_4px] bg-bubble-out px-3 py-[9px] text-[15px]">
                <small className="block text-[13px] font-bold text-aiden-deep">Aiden</small>
                {it === newest ? (
                  <TypingText startOnView={false}>{it.reply}</TypingText>
                ) : (
                  <span className="whitespace-pre-line">{it.reply}</span>
                )}
              </div>
            </div>
          </article>
        );
      })}
    </AnimatedList>
  );
}

/** What only you can answer: chats handed to a person and questions Aiden is holding for you. */
export function NeedsYou({ items, total }: { items: NeedsYouItem[]; total: number }) {
  const first = items[0]!;
  return (
    <NeedsYouCard
      title="Needs you"
      actions={
        <>
          {first.conversationId ? (
            <Button asChild variant="gold">
              <a href={`/app/inbox?c=${first.conversationId}`}>Reply to {firstName(first.who)}</a>
            </Button>
          ) : null}
          {total > 1 || !first.conversationId ? (
            <Button asChild variant="outline">
              <a href="/app/inbox">Open the inbox</a>
            </Button>
          ) : null}
        </>
      }
    >
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {items.map((it) => (
          <li key={it.key}>
            <b>{it.who}</b> {it.question}
          </li>
        ))}
      </ul>
      {total > items.length ? (
        <p className="mt-2 text-sm text-gold-ink">
          {count.format(total - items.length)} more in the inbox.
        </p>
      ) : null}
    </NeedsYouCard>
  );
}
