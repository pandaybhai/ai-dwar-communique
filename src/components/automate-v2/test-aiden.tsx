import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Send } from "lucide-react";
import { toast } from "sonner";
import { PhoneFrame, ProductBubble, TypingDots, WhatsAppBubble } from "@/components/design-v2";
import { Button } from "@/components/ui/button";
import { outcomeOf } from "@/lib/ai-outcome";
import { aiRunApi, employeeApi, moneyText, type PlaygroundRun } from "@/lib/employee-client";
import { testCopy as t } from "./copy";

type Turn = { id: number; question: string; run: PlaygroundRun | null; pending: boolean };

/**
 * Batch 49: "Test Aiden" — a WhatsApp-style chat in a phone. Every question
 * goes through the Playground's own answer path (/api/ai/run action
 * "playground", the "Ask it something" tab), so nothing reaches a customer
 * and the answer, its cost and its pictures are exactly what the Playground
 * shows. The suggestions are the Playground's: the last real customer
 * questions (/api/ai/employee action "questions").
 */
export function TestAiden({
  organizationId,
  name,
  currency,
  onRan,
  onEnableAi,
  onCompare,
}: {
  organizationId: string;
  name: string;
  currency: string;
  onRan: () => void | Promise<void>;
  /** Only with ai.configure: switches AI on and asks again, as the Playground does. */
  onEnableAi?: () => Promise<boolean>;
  /** Opens the full Playground on its Compare two setups tab. */
  onCompare: () => void;
}) {
  const inputId = useId();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [questions, setQuestions] = useState<string[]>([]);
  const [enabling, setEnabling] = useState(false);
  const seq = useRef(0);
  const wall = useRef<HTMLDivElement>(null);
  const running = turns.some((t) => t.pending);

  useEffect(() => {
    let live = true;
    void employeeApi<{ questions: string[] }>({
      organization_id: organizationId,
      action: "questions",
    }).then(({ data }) => {
      if (live) setQuestions(data?.questions ?? []);
    });
    return () => {
      live = false;
    };
  }, [organizationId]);

  useEffect(() => {
    const el = wall.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const ask = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      const id = (seq.current += 1);
      setQuestion("");
      setTurns((t) => [...t, { id, question: text, run: null, pending: true }]);
      const { data, error } = await aiRunApi<{ run: PlaygroundRun }>({
        organization_id: organizationId,
        action: "playground",
        question: text,
      });
      if (error) {
        toast.error(error);
        setTurns((t) => t.filter((x) => x.id !== id));
        return;
      }
      setTurns((t) =>
        t.map((x) => (x.id === id ? { ...x, run: data?.run ?? null, pending: false } : x)),
      );
      await onRan();
    },
    [organizationId, onRan],
  );

  const enableAndRetry = async (turn: Turn) => {
    if (!onEnableAi) return;
    setEnabling(true);
    const ok = await onEnableAi();
    setEnabling(false);
    if (!ok) return;
    setTurns((t) => t.filter((x) => x.id !== turn.id));
    await ask(turn.question);
  };

  return (
    <section aria-labelledby="test-aiden-heading" className="flex flex-col items-center gap-4">
      <div className="flex w-full flex-col gap-1 self-stretch">
        <h2 id="test-aiden-heading" className="m-0 font-display text-[1.25rem] font-semibold">
          {t.heading(name)}
        </h2>
        <p className="m-0 text-sm text-muted-foreground">{t.line}</p>
      </div>

      <PhoneFrame label={t.phoneLabel(name)} className="wide:max-w-[320px] phone:max-w-[320px]">
        <div
          ref={wall}
          aria-live="polite"
          className="-mt-4 flex max-h-[360px] min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-2 [&>div]:text-sm"
        >
          {turns.length === 0 ? (
            <WhatsAppBubble from="system" className="mt-auto">
              {t.hello}
            </WhatsAppBubble>
          ) : null}
          {turns.map((turn) => (
            <TurnView
              key={turn.id}
              turn={turn}
              name={name}
              currency={currency}
              enabling={enabling}
              {...(onEnableAi ? { onEnableAi: () => void enableAndRetry(turn) } : {})}
            />
          ))}
        </div>
        <form
          className="mt-2 flex items-center gap-1.5 rounded-full bg-surface p-1 pl-3.5 shadow-xs"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(question);
          }}
        >
          <label htmlFor={inputId} className="sr-only">
            {t.inputLabel}
          </label>
          <input
            id={inputId}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={t.placeholder}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <button
            type="submit"
            aria-label={t.ask(name)}
            disabled={running || !question.trim()}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-aiden text-ink-foreground transition-[opacity,transform] duration-200 active:scale-95 motion-reduce:active:scale-100 phone:h-11 phone:w-11 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden disabled:opacity-50"
          >
            <Send className="h-4 w-4" aria-hidden="true" />
          </button>
        </form>
      </PhoneFrame>

      {questions.length > 0 ? (
        <div className="flex w-full flex-col gap-2">
          <p className="m-0 text-sm text-muted-foreground">{t.suggestions}</p>
          <div className="flex flex-wrap gap-1.5">
            {questions.slice(0, 3).map((q) => (
              <button
                key={q}
                type="button"
                disabled={running}
                onClick={() => void ask(q)}
                className="max-w-full truncate rounded-full border border-line bg-surface px-3 py-1.5 text-left text-[13px] font-medium text-foreground transition-[border-color,color] duration-200 phone:min-h-11 phone:py-2.5 hover:border-aiden hover:text-aiden-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden disabled:opacity-60"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <Button
        variant="outline"
        className="h-auto min-h-[39px] self-stretch whitespace-normal phone:min-h-11"
        onClick={onCompare}
      >
        {t.compare(questions.length || 20)}
      </Button>
    </section>
  );
}

function TurnView({
  turn,
  name,
  currency,
  enabling,
  onEnableAi,
}: {
  turn: Turn;
  name: string;
  currency: string;
  enabling: boolean;
  onEnableAi?: () => void;
}) {
  const run = turn.run;
  return (
    <>
      <WhatsAppBubble from="in">{turn.question}</WhatsAppBubble>
      {turn.pending ? (
        <WhatsAppBubble from="out" sender={name}>
          <TypingDots label={t.typing(name)} />
        </WhatsAppBubble>
      ) : run ? (
        <RunView
          run={run}
          name={name}
          currency={currency}
          enabling={enabling}
          {...(onEnableAi ? { onEnableAi } : {})}
        />
      ) : (
        <WhatsAppBubble from="system">{t.couldNot}</WhatsAppBubble>
      )}
    </>
  );
}

function RunView({
  run,
  name,
  currency,
  enabling,
  onEnableAi,
}: {
  run: PlaygroundRun;
  name: string;
  currency: string;
  enabling: boolean;
  onEnableAi?: () => void;
}) {
  // The Playground's AnswerCard rules: a run that never reached the AI costs nothing.
  const blocked = run.status !== "ok" && !run.output;
  const outcome = outcomeOf(run.status, run.escalationSignal);
  const cost =
    run.status === "error" && !run.output
      ? t.nothingCharged
      : run.costKnown
        ? moneyText(run.billedAmount, currency)
        : t.costUnknown;
  return (
    <>
      {blocked ? (
        <WhatsAppBubble from="system">{run.error || t.couldNot}</WhatsAppBubble>
      ) : (
        <WhatsAppBubble
          from="out"
          sender={name}
          meta={<span>{`${Math.round(run.latencyMs / 100) / 10}s, ${cost}`}</span>}
        >
          <span className="whitespace-pre-wrap">{run.output}</span>
        </WhatsAppBubble>
      )}
      {(run.media ?? []).slice(0, 2).map((m) => (
        <ProductBubble
          key={m.imageUrl}
          title={m.title}
          detail={m.price === null ? t.priceOnRequest : moneyText(m.price, m.currency || currency)}
          image={m.imageUrl}
          imageAlt={m.title}
          className="w-[200px]"
        />
      ))}
      {outcome.key !== "answered" && !blocked ? (
        <WhatsAppBubble from="system">
          {outcome.label}
          {outcome.reason ? `: ${outcome.reason}` : ""}
        </WhatsAppBubble>
      ) : null}
      {blocked && run.status === "refused" && onEnableAi ? (
        <Button
          size="sm"
          variant="gold"
          className="self-center phone:h-11"
          disabled={enabling}
          onClick={onEnableAi}
        >
          {enabling ? t.turningOn : t.turnOnAndAsk(name)}
        </Button>
      ) : null}
    </>
  );
}
