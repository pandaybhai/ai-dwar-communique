import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { sendInboxText } from "@/lib/inbox-actions";
import { agoLabel } from "@/lib/new-home";
import type { DraftItem } from "@/lib/new-home-data";
import { NeedsYou } from "./replying-view";
import { HomeAvatar, HomeGrid, HomeOrb, LatestCampaign, TodayStats, contactName, type StatRow } from "./parts";
import type { NewHomeData } from "./use-new-home";

/**
 * Sends a draft (as written, edited, or the owner's own words) to its chat
 * through the Inbox composer's send. Nothing is sent for empty words.
 */
export async function sendDraftReply(
  organizationId: string,
  draft: Pick<DraftItem, "conversationId">,
  text: string,
): Promise<{ sent: boolean; error: string | null }> {
  const body = text.trim();
  if (!body) return { sent: false, error: null };
  const { error } = await sendInboxText(organizationId, draft.conversationId, body);
  return error ? { sent: false, error } : { sent: true, error: null };
}

/** How long a sent card takes to slide away (matches .nd-draft). */
const LEAVE_MS = 450;

/**
 * Batch 45, state 2: Aiden drafts, you send. His drafts as a stack: Send
 * sends the draft as it is, Edit or Write my own opens it for your words —
 * all through the Inbox composer's own send (sendInboxText). The sent card
 * slides away and the next one rises.
 */
export function DraftsView({
  data,
  organizationId,
  canReply,
  stats,
  headlineFor,
  onSent,
}: {
  data: NewHomeData;
  organizationId: string;
  canReply: boolean;
  stats: StatRow[];
  headlineFor: (n: number) => string;
  onSent: () => void;
}) {
  // Sent here: hidden at once (the realtime re-read drops them too).
  const [sent, setSent] = useState<Set<string>>(() => new Set());
  const [leaving, setLeaving] = useState<string | null>(null);
  const drafts = (data.drafts ?? []).filter((d) => !sent.has(d.runId));
  const left = drafts.filter((d) => d.runId !== leaving).length;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const send = async (draft: DraftItem, text: string): Promise<boolean> => {
    const { sent: ok, error } = await sendDraftReply(organizationId, draft, text);
    if (!ok) {
      if (error) toast.error(error);
      return false;
    }
    toast.success(`Sent to ${contactName(draft.contact)}.`);
    setLeaving(draft.runId);
    timer.current = setTimeout(() => {
      setSent((s) => new Set(s).add(draft.runId));
      setLeaving(null);
      onSent();
    }, LEAVE_MS);
    return true;
  };

  const needs = data.needsYou;
  return (
    <HomeGrid
      orb={<HomeOrb state="draft" label="Aiden writes drafts for you" />}
      headline={headlineFor(left)}
      lede={
        left > 0
          ? "Aiden wrote them. Nothing goes out until you send it."
          : "Aiden will line up the next ones as customers write."
      }
      side={
        <>
          {needs && needs.items.length > 0 ? <NeedsYou items={needs.items} total={needs.total} /> : null}
          <TodayStats rows={stats} />
          {data.campaign ? <LatestCampaign campaign={data.campaign} /> : null}
        </>
      }
    >
      {data.drafts === null ? null : drafts.length === 0 ? (
        <p className="m-0 rounded-[20px] border border-line bg-surface p-5 text-muted-foreground shadow-md">
          <b className="block font-display text-lg font-semibold text-foreground">All caught up</b>
          Every draft has been sent or answered.
        </p>
      ) : (
        <div className="relative pb-7" aria-label="Aiden's drafts">
          {drafts.slice(0, 3).map((d, i) => {
            const pos = d.runId === leaving ? "gone" : String(drafts.slice(0, i).filter((x) => x.runId !== leaving).length);
            return (
              <DraftCard
                key={d.runId}
                draft={d}
                pos={pos}
                canReply={canReply}
                onSend={(text) => send(d, text)}
              />
            );
          })}
        </div>
      )}
    </HomeGrid>
  );
}

function DraftCard({
  draft,
  pos,
  canReply,
  onSend,
}: {
  draft: DraftItem;
  /** "0" on top, "1" and "2" behind, "gone" while it slides away. */
  pos: string;
  canReply: boolean;
  onSend: (text: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const top = pos === "0";
  const who = contactName(draft.contact);
  const go = async (text: string) => {
    setBusy(true);
    const ok = await onSend(text);
    if (!ok) setBusy(false);
  };

  return (
    <article
      data-pos={pos}
      aria-hidden={top ? undefined : true}
      inert={top ? undefined : true}
      aria-label={top ? `Draft for ${who}` : undefined}
      className={
        "nd-draft rounded-[20px] border border-line bg-surface p-5 shadow-lg " +
        (top ? "relative z-[3]" : `absolute inset-x-0 top-0 h-full ${pos === "gone" ? "z-[4]" : pos === "1" ? "z-[2]" : "z-[1]"}`)
      }
    >
      <div className="flex justify-between gap-2.5 font-bold">
        <span className="flex min-w-0 items-center gap-3">
          <HomeAvatar seed={draft.contact?.id ?? draft.conversationId} label={who} />
          <span className="min-w-0 truncate">{who}</span>
        </span>
        <span className="shrink-0 text-sm font-medium text-muted-foreground">{agoLabel(draft.at, Date.now())}</span>
      </div>
      {draft.question ? (
        <p className="m-0 mt-3 rounded-[14px_14px_14px_4px] bg-bubble-in px-3 py-2.5">{draft.question}</p>
      ) : null}
      {editing === null ? (
        <div className="mt-2.5 rounded-[14px_14px_4px_14px] bg-bubble-out px-3 py-2.5">
          <small className="block text-[13px] font-bold text-aiden-deep">Aiden's draft</small>
          <span className="whitespace-pre-line">{draft.draft}</span>
        </div>
      ) : (
        <div className="mt-2.5">
          <label htmlFor={`draft-${draft.runId}`} className="mb-1.5 block text-[13px] font-bold text-aiden-deep">
            Your reply to {who}
          </label>
          <Textarea
            id={`draft-${draft.runId}`}
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            rows={4}
            autoFocus
            className="bg-surface text-[15px]"
          />
        </div>
      )}
      {top ? (
        canReply ? (
          <div className="mt-2.5 flex flex-wrap gap-2">
            {editing === null ? (
              <>
                <Button disabled={busy} onClick={() => void go(draft.draft)}>
                  Send
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => setEditing(draft.draft)}>
                  Edit
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => setEditing("")}>
                  Write my own
                </Button>
              </>
            ) : (
              <>
                <Button disabled={busy || !editing.trim()} onClick={() => void go(editing)}>
                  Send
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => setEditing(null)}>
                  Back to Aiden's draft
                </Button>
              </>
            )}
          </div>
        ) : (
          <div className="mt-2.5">
            <Button asChild variant="outline">
              <a href={`/app/inbox?c=${draft.conversationId}`}>Open the chat</a>
            </Button>
          </div>
        )
      ) : null}
    </article>
  );
}
