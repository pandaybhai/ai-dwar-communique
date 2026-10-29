import { useCallback, useEffect, useId, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { NeedsYouCard } from "@/components/design-v2";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { gapsChanged } from "@/hooks/use-pending-gaps";
import { outcomeOf } from "@/lib/ai-outcome";
import {
  employeeApi,
  knowledgeApi,
  whenText,
  type EmployeeRun,
  type Gap,
} from "@/lib/employee-client";
import { answersToCheck } from "./aiden-v2";

const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/**
 * Batch 49: what needs the owner on Automate > Aiden, each with one-tap
 * "Teach Aiden". Both use the actions the Employee page already has:
 *
 * - Questions Aiden couldn't answer: the "Questions for you" list
 *   (/api/ai/knowledge "gaps"); the answer goes through "answer_gap" (sent to
 *   the customer while their chat is open, remembered either way) and
 *   "dismiss_gap", exactly as UnansweredList sends them.
 * - Answers to check: the work log (/api/ai/employee "work", last 7 days)
 *   runs Aiden passed on or didn't give; the right answer goes through the
 *   work log's own correction ("correct").
 *
 * Only ai.configure sees the Teach buttons, as on the Employee page.
 */
export function AidenReview({
  organizationId,
  name,
  canConfigure,
  onChanged,
  onSeeAll,
}: {
  organizationId: string;
  name: string;
  canConfigure: boolean;
  onChanged: () => void;
  /** Opens the full list on the Employee tabs below ("gaps" or "work"). */
  onSeeAll: (tab: "gaps" | "work") => void;
}) {
  const [gaps, setGaps] = useState<Gap[] | null>(null);
  const [gapTotal, setGapTotal] = useState(0);
  const [runs, setRuns] = useState<EmployeeRun[] | null>(null);

  const loadGaps = useCallback(async () => {
    const { data, error } = await knowledgeApi<{ gaps: Gap[]; total: number; waiting?: number }>({
      organization_id: organizationId,
      action: "gaps",
      page: 0,
    });
    if (error) toast.error(error);
    setGaps(data?.gaps ?? []);
    // "waiting" is the pending count (the list also carries expired ones).
    setGapTotal(data?.waiting ?? 0);
  }, [organizationId]);

  const loadRuns = useCallback(async () => {
    const { data } = await employeeApi<{ runs: EmployeeRun[] }>({
      organization_id: organizationId,
      action: "work",
      days: 7,
    });
    setRuns(data?.runs ?? []);
  }, [organizationId]);

  useEffect(() => {
    void loadGaps();
    void loadRuns();
  }, [loadGaps, loadRuns]);

  const pending = (gaps ?? []).filter((g) => g.status === "pending").slice(0, 3);
  const toCheck = answersToCheck(runs ?? []);
  const loading = gaps === null || runs === null;

  if (loading) {
    return (
      <section aria-label="Needs your answer" className="flex flex-col gap-3">
        <div className="h-6 w-48 animate-pulse rounded-full bg-bubble-in motion-reduce:animate-none" />
        <div className="h-28 animate-pulse rounded-[18px] bg-bubble-in motion-reduce:animate-none" />
      </section>
    );
  }

  if (pending.length === 0 && toCheck.length === 0) {
    return (
      <section aria-labelledby="aiden-review-heading" className="flex flex-col gap-2">
        <h2 id="aiden-review-heading" className="m-0 font-display text-[1.25rem] font-semibold">
          Needs your answer
        </h2>
        <p className="m-0 text-body font-semibold text-aiden-deep">Nothing waits on you.</p>
        <p className="m-0 text-sm text-muted-foreground">
          When {name} can&rsquo;t answer a customer, the question lands here so you can teach the
          answer once.
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="aiden-review-heading" className="flex flex-col gap-5">
      <h2 id="aiden-review-heading" className="m-0 font-display text-[1.25rem] font-semibold">
        Needs your answer
      </h2>

      {pending.length > 0 ? (
        <NeedsYouCard
          title={`${count(Math.max(gapTotal, pending.length), "question")} ${name} couldn't answer`}
        >
          <p className="text-sm text-muted-foreground">
            {name} kept each chat going and noted the question. Answer once: if the chat is still
            open it goes to the customer now, and {name} remembers it.
          </p>
          <ul className="m-0 mt-1 flex list-none flex-col p-0">
            {pending.map((gap) => (
              <GapItem
                key={gap.id}
                gap={gap}
                name={name}
                organizationId={organizationId}
                canConfigure={canConfigure}
                onDone={() => {
                  gapsChanged();
                  void loadGaps();
                  onChanged();
                }}
              />
            ))}
          </ul>
          {gapTotal > pending.length ? (
            <Button variant="outline" size="sm" className="self-start" onClick={() => onSeeAll("gaps")}>
              See all {gapTotal}
            </Button>
          ) : null}
        </NeedsYouCard>
      ) : null}

      {toCheck.length > 0 ? (
        <div className="flex flex-col gap-2.5">
          <h3 className="m-0 text-body font-semibold">Answers to check</h3>
          <p className="m-0 text-sm text-muted-foreground">
            This week {name} passed these on or didn&rsquo;t answer. Teach the right answer and{" "}
            {name} uses it from now on.
          </p>
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
            {toCheck.map((run) => (
              <RunItem key={run.id} run={run} name={name} organizationId={organizationId} canConfigure={canConfigure} />
            ))}
          </ul>
          <Button variant="ghost" size="sm" className="self-start" onClick={() => onSeeAll("work")}>
            See everything {name} did
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function GapItem({
  gap,
  name,
  organizationId,
  canConfigure,
  onDone,
}: {
  gap: Gap;
  name: string;
  organizationId: string;
  canConfigure: boolean;
  onDone: () => void;
}) {
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);

  // UnansweredList's teach and dismiss, same bodies, same messages.
  const teach = async () => {
    const text = answer.trim();
    if (!text) {
      toast.error("Write the answer first.");
      return;
    }
    setBusy(true);
    const { data, error } = await knowledgeApi<{ delivered?: boolean }>({
      organization_id: organizationId,
      action: "answer_gap",
      reply_id: gap.id,
      answer: text,
    });
    setBusy(false);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success(
      data?.delivered
        ? "Sent to the customer — and I'll remember it."
        : "Saved — customer's window has closed, they'll get it next time they write.",
    );
    setAnswer("");
    setOpen(false);
    onDone();
  };

  const dismiss = async () => {
    setBusy(true);
    const { error } = await knowledgeApi({
      organization_id: organizationId,
      action: "dismiss_gap",
      reply_id: gap.id,
    });
    setBusy(false);
    if (error) {
      toast.error(error);
      return;
    }
    onDone();
  };

  return (
    <li className="flex flex-col gap-2 border-t border-gold-line py-3 first:border-t-0 first:pt-1">
      <p className="m-0 font-semibold text-foreground">&ldquo;{gap.question}&rdquo;</p>
      <p className="m-0 flex flex-wrap gap-x-3 text-sm text-muted-foreground">
        <span>Asked {whenText(gap.created_at)}</span>
        {gap.conversation_id ? (
          <a
            className="font-semibold text-aiden-deep underline-offset-4 hover:underline"
            href={`/app/inbox?c=${gap.conversation_id}`}
          >
            Open chat
          </a>
        ) : (
          <span>Your test chat</span>
        )}
      </p>
      {canConfigure ? (
        open ? (
          <div className="flex flex-col gap-2">
            <label htmlFor={fieldId} className="text-sm font-semibold">
              The answer, the way you&rsquo;d say it
            </label>
            <Textarea
              id={fieldId}
              rows={2}
              autoFocus
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="gold" disabled={busy} onClick={() => void teach()}>
                {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                Teach {name}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="gold" onClick={() => setOpen(true)}>
              Teach {name}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void dismiss()}>
              Dismiss
            </Button>
          </div>
        )
      ) : null}
    </li>
  );
}

function RunItem({
  run,
  name,
  organizationId,
  canConfigure,
}: {
  run: EmployeeRun;
  name: string;
  organizationId: string;
  canConfigure: boolean;
}) {
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const outcome = outcomeOf(run.status, run.escalation_signal);
  const question = (run.input_summary ?? "").trim();

  // WorkLog's saveCorrection, same body, same messages.
  const save = async () => {
    if (!question || !answer.trim()) {
      toast.error("Write both the question and the answer it should have given.");
      return;
    }
    setSaving(true);
    const { error } = await knowledgeApi({
      organization_id: organizationId,
      action: "correct",
      question,
      answer: answer.trim(),
    });
    setSaving(false);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success("Saved. It will use your answer from now on.");
    setOpen(false);
    setSaved(true);
  };

  return (
    <li className="flex flex-col gap-2 rounded-[18px] border border-line bg-surface p-4 shadow-md">
      <div className="flex items-baseline justify-between gap-3">
        <p className="m-0 min-w-0 font-semibold text-foreground">&ldquo;{question}&rdquo;</p>
        <span className="shrink-0 text-sm text-muted-foreground">{whenText(run.created_at)}</span>
      </div>
      <p className="m-0 rounded-[14px] rounded-bl-[4px] bg-bubble-out px-3 py-2 text-sm">
        <b className="block text-[13px] text-aiden-deep">{name}</b>
        {run.output?.trim() || outcome.reason || outcome.label}
      </p>
      {saved ? (
        <p className="m-0 text-sm font-semibold text-aiden-deep">{name} uses your answer from now on.</p>
      ) : canConfigure ? (
        open ? (
          <div className="flex flex-col gap-2">
            <label htmlFor={fieldId} className="text-sm font-semibold">
              The answer {name} should have given
            </label>
            <Textarea id={fieldId} rows={2} autoFocus value={answer} onChange={(e) => setAnswer(e.target.value)} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="gold" disabled={saving} onClick={() => void save()}>
                {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                Teach {name}
              </Button>
              <Button size="sm" variant="ghost" disabled={saving} onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="outline" className="self-start" onClick={() => setOpen(true)}>
            Teach {name}
          </Button>
        )
      ) : null}
    </li>
  );
}
