import { useCallback, useEffect, useState } from "react";
import { Loader2, MessageSquare, Play, Scale, Trophy } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  aiRunApi,
  employeeApi,
  moneyText,
  type AiTier,
  type CompareResult,
  type CompareSide,
  type PlaygroundRun,
  type RunSource,
} from "@/lib/employee-client";

/**
 * Try it before you trust it: one question at a time, or the same twenty real
 * customer questions run through two setups side by side.
 */
export function Playground({
  organizationId,
  tiers,
  currency,
  onRan,
  onEnableAi,
}: {
  organizationId: string;
  tiers: AiTier[];
  currency: string;
  onRan: () => void | Promise<void>;
  onEnableAi?: () => Promise<boolean>;
}) {
  const [question, setQuestion] = useState("");
  const [running, setRunning] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [run, setRun] = useState<PlaygroundRun | null>(null);


  const [questions, setQuestions] = useState<string[]>([]);
  const [tierA, setTierA] = useState("default");
  const [tierB, setTierB] = useState(tiers[0]?.key ?? "default");
  const [comparing, setComparing] = useState(false);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [picking, setPicking] = useState<"A" | "B" | null>(null);

  const loadQuestions = useCallback(async () => {
    const { data } = await employeeApi<{ questions: string[] }>({
      organization_id: organizationId,
      action: "questions",
    });
    setQuestions(data?.questions ?? []);
  }, [organizationId]);

  useEffect(() => {
    void loadQuestions();
  }, [loadQuestions]);

  const ask = async () => {
    const text = question.trim();
    if (!text) return;
    setRunning(true);
    const { data, error } = await aiRunApi<{ run: PlaygroundRun }>({
      organization_id: organizationId,
      action: "playground",
      question: text,
    });
    setRunning(false);
    if (error) toast.error(error);
    else {
      setRun(data?.run ?? null);
      await onRan();
    }
  };

  const enableAndRetry = async () => {
    if (!onEnableAi) return;
    setEnabling(true);
    const ok = await onEnableAi();
    setEnabling(false);
    if (!ok) return;
    setRun(null);
    await ask();
  };


  const parseTier = (value: string) => (value === "default" ? null : value);

  const compare = async () => {
    if (questions.length === 0) {
      toast.error("No real customer questions yet — ask one above instead.");
      return;
    }
    setComparing(true);
    const tA = parseTier(tierA);
    const tB = parseTier(tierB);
    const { data, error } = await aiRunApi<CompareResult>({
      organization_id: organizationId,
      action: "compare",
      questions,
      config_a: { label: "Setup A", ...(tA ? { tier: tA } : {}) },
      config_b: { label: "Setup B", ...(tB ? { tier: tB } : {}) },
    });
    setComparing(false);
    if (error) toast.error(error);
    else {
      setResult(data);
      await onRan();
    }
  };

  const pickWinner = async (side: "A" | "B") => {
    const tier = parseTier(side === "A" ? tierA : tierB);
    if (!tier) {
      toast.info("That's already how I work today.");
      return;
    }
    setPicking(side);
    const { error } = await employeeApi({
      organization_id: organizationId,
      action: "set_tier",
      task: "agent_reply",
      tier,
    });
    setPicking(null);
    if (error) toast.error(error);
    else {
      toast.success(`Setup ${side} is now how I answer your customers.`);
      await onRan();
    }
  };


  return (
    <section
      aria-labelledby="try-heading"
      className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm"
    >
      <h2 id="try-heading" className="text-lg font-semibold text-foreground">
        Try it before you trust it
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Nothing here reaches a customer. Ask it something, or replay your last real questions
        through two setups and see which one you'd rather have answering.
      </p>

      <Tabs defaultValue="ask" className="mt-5">
        <TabsList>
          <TabsTrigger value="ask">Ask it something</TabsTrigger>
          <TabsTrigger value="compare">Compare two setups</TabsTrigger>
        </TabsList>

        <TabsContent value="ask" className="mt-5 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="pg-question">A question a customer might ask</Label>
            <Textarea
              id="pg-question"
              rows={3}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Where's my order #1042?"
              className="resize-y"
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void ask()} disabled={running || !question.trim()}>
              {running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
              See the answer
            </Button>
            {questions.slice(0, 3).map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setQuestion(q)}
                className="max-w-xs truncate rounded-full border border-border/70 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              >
                {q}
              </button>
            ))}
          </div>

          {run ? (
            <AnswerCard
              run={run}
              currency={currency}
              {...(onEnableAi ? { onEnableAi: enableAndRetry } : {})}
              enabling={enabling}
            />
          ) : null}

        </TabsContent>

        <TabsContent value="compare" className="mt-5 space-y-4">
          <p className="text-sm text-muted-foreground">
            Running your last {questions.length} real customer question
            {questions.length === 1 ? "" : "s"} through both.
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            <TierSelect id="tier-a" label="Setup A" value={tierA} onChange={setTierA} tiers={tiers} />
            <TierSelect id="tier-b" label="Setup B" value={tierB} onChange={setTierB} tiers={tiers} />
          </div>
          <Button onClick={() => void compare()} disabled={comparing}>
            {comparing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Scale className="mr-2 h-4 w-4" />}
            Run the comparison
          </Button>

          {result ? (
            <div className="space-y-5">
              <div className="grid gap-4 md:grid-cols-2">
                <SummaryCard
                  title="Setup A"
                  summary={result.summaryA}
                  currency={currency}
                  onPick={() => void pickWinner("A")}
                  picking={picking === "A"}
                />
                <SummaryCard
                  title="Setup B"
                  summary={result.summaryB}
                  currency={currency}
                  onPick={() => void pickWinner("B")}
                  picking={picking === "B"}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Happy with one of them? Make it the setup that answers your customers.
              </p>
              <ul className="space-y-4">
                {result.pairs.map((pair, i) => (
                  <li key={`${pair.question}-${i}`} className="rounded-xl border border-border/70 p-4">
                    <p className="flex items-start gap-2 text-sm font-medium text-foreground">
                      <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      {pair.question}
                    </p>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <SideCard label="A" side={pair.a} currency={currency} />
                      <SideCard label="B" side={pair.b} currency={currency} />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </TabsContent>
      </Tabs>
    </section>
  );
}

function TierSelect({
  id,
  label,
  value,
  onChange,
  tiers,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  tiers: AiTier[];
}) {
  const chosen = tiers.find((t) => t.key === value);
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="default">How I work today</SelectItem>
          {tiers.map((t) => (
            <SelectItem key={t.key} value={t.key}>
              {t.display_name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {chosen?.plain_description ? (
        <p className="text-xs text-muted-foreground">{chosen.plain_description}</p>
      ) : null}
    </div>
  );
}

function Sources({ sources }: { sources: RunSource[] | null | undefined }) {
  if (!sources || sources.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {sources.map((s, i) => (
        <Badge key={`${s.label}-${i}`} variant="secondary" className="max-w-full truncate text-[11px]">
          {s.kind === "tool" ? "Looked up: " : "From: "}
          {s.label}
        </Badge>
      ))}
    </div>
  );
}

function AnswerCard({
  run,
  currency,
  onEnableAi,
  enabling,
}: {
  run: PlaygroundRun;
  currency: string;
  onEnableAi?: () => void | Promise<void>;
  enabling?: boolean;
}) {
  const blocked = run.status !== "ok" && !run.output;
  const blockedLabel =
    run.status === "refused"
      ? "I didn't answer this"
      : run.status === "capped"
        ? "I've hit this month's limit"
        : "Something went wrong";
  return (
    <div
      className={`rounded-xl border p-4 ${blocked ? "border-destructive/40 bg-destructive/5" : "border-border/70 bg-muted/20"}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={blocked ? "destructive" : run.escalationSignal ? "secondary" : "default"}>
          {blocked
            ? blockedLabel
            : run.escalationSignal
              ? "I'd pass this to you"
              : "I'd answer this"}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {run.brainName} · {Math.round(run.latencyMs / 100) / 10}s ·{" "}
          {run.costKnown ? moneyText(run.costAmount, currency) : "cost unknown"}
        </span>
      </div>
      <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
        {run.output ||
          run.error ||
          "I couldn't answer this one."}
      </p>
      {blocked && run.status === "refused" ? (
        onEnableAi ? (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button size="sm" disabled={enabling} onClick={() => void onEnableAi()}>
              {enabling ? "Turning me on…" : "Turn me on and ask again"}
            </Button>
            <span className="text-xs text-muted-foreground">
              This switches me on for this workspace and asks the question again.
            </span>
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            Ask an owner or admin to switch me on for this workspace.
          </p>
        )
      ) : null}

      <Sources sources={run.sources} />
    </div>
  );
}

function SideCard({ label, side, currency }: { label: string; side: CompareSide; currency: string }) {
  return (
    <div className="rounded-xl border border-border/70 bg-muted/20 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{label}</Badge>
        <span className="text-[11px] text-muted-foreground">
          {side.brainName} · {side.costKnown ? moneyText(side.costAmount, currency) : "cost unknown"}
        </span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
        {side.answer || (side.passedToYou ? "I'd pass this to you." : "I had nothing to say here.")}
      </p>
      <Sources sources={side.sources} />
    </div>
  );
}

function SummaryCard({
  title,
  summary,
  currency,
  onPick,
  picking,
}: {
  title: string;
  summary: CompareResult["summaryA"];
  currency: string;
  onPick?: () => void;
  picking?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-muted/20 p-4">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <dl className="mt-2 space-y-1 text-sm text-muted-foreground">
        <div className="flex justify-between">
          <dt>Answered</dt>
          <dd className="font-medium text-foreground">{summary.answered}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Passed to your team</dt>
          <dd className="font-medium text-foreground">{summary.passed}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Cost for this run</dt>
          <dd className="font-medium text-foreground">
            {summary.costKnown ? moneyText(summary.totalCost, currency) : "—"}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt>Average time</dt>
          <dd className="font-medium text-foreground">
            {Math.round(summary.averageMs / 100) / 10}s
          </dd>
        </div>
      </dl>
      {onPick ? (
        <Button
          size="sm"
          variant="outline"
          className="mt-3 w-full rounded-full"
          disabled={picking}
          onClick={onPick}
        >
          {picking ? (
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trophy className="mr-2 h-3.5 w-3.5" />
          )}
          Use {title}
        </Button>
      ) : null}
    </div>
  );
}
