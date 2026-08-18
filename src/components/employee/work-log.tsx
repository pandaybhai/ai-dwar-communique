import { useCallback, useEffect, useState } from "react";
import { ClipboardList, Loader2, PencilLine } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePermissions } from "@/hooks/use-permissions";
import {
  employeeApi,
  knowledgeApi,
  moneyText,
  whenText,
  type EmployeeRun,
} from "@/lib/employee-client";

const STATUS_TEXT: Record<string, { label: string; tone: "default" | "secondary" | "destructive" }> = {
  ok: { label: "I answered this", tone: "default" },
  escalated: { label: "I passed this to you", tone: "secondary" },
  refused: { label: "I didn't answer this", tone: "secondary" },
  capped: { label: "I've hit this month's limit", tone: "destructive" },
  error: { label: "Something went wrong", tone: "destructive" },
};

const TASK_TEXT: Record<string, string> = {
  agent_reply: "I answered a customer",
  suggest_reply: "I drafted a reply",
  summarise: "I caught you up on a chat",
  auto_tag: "I labelled a chat",
};

/** Why it stopped, said in one sentence, in its own voice. */
const REASON_TEXT: Record<string, string> = {
  no_source: "I had nothing to answer from.",
  unsure: "I wasn't sure enough to answer.",
  tool_failed: "A lookup didn't work, so I passed it to you.",
  opted_out: "This customer asked not to be messaged.",
  capped: "I've hit this month's limit.",
  human_requested: "They asked for a person.",
  policy: "This isn't something I'm allowed to answer.",
};

/** Every single thing it did, why, what it read, and what it cost. */
export function WorkLog({ organizationId, currency }: { organizationId: string; currency: string }) {
  const [runs, setRuns] = useState<EmployeeRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);
  const [openId, setOpenId] = useState<string | null>(null);
  const [correctingId, setCorrectingId] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [saving, setSaving] = useState(false);
  const { can } = usePermissions();
  const canConfigure = can("ai.configure");

  const startCorrection = (run: EmployeeRun) => {
    setCorrectingId(run.id);
    setQuestion(run.input_summary ?? "");
    setAnswer("");
  };

  const saveCorrection = async () => {
    if (!question.trim() || !answer.trim()) {
      toast.error("Write both the question and the answer it should have given.");
      return;
    }
    setSaving(true);
    const { error } = await knowledgeApi({
      organization_id: organizationId,
      action: "correct",
      question: question.trim(),
      answer: answer.trim(),
    });
    setSaving(false);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success("Saved. It will use your answer from now on.");
    setCorrectingId(null);
  };

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await employeeApi<{ runs: EmployeeRun[] }>({
      organization_id: organizationId,
      action: "work",
      days,
    });
    if (error) toast.error(error);
    setRuns(data?.runs ?? []);
    setLoading(false);
  }, [organizationId, days]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section
      aria-labelledby="work-heading"
      className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="work-heading" className="text-lg font-semibold text-foreground">
            Everything it has done
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Open any row to see what it read before answering and what that answer cost.
          </p>
        </div>
        <div className="flex gap-2">
          {[7, 30, 90].map((d) => (
            <Button
              key={d}
              size="sm"
              variant={days === d ? "default" : "outline"}
              onClick={() => setDays(d)}
            >
              {d} days
            </Button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="mt-6 space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            icon={ClipboardList}
            title="It hasn't done anything yet"
            description="Once it starts drafting or answering, every single thing it does shows up here."
          />
        </div>
      ) : (
        <ul className="mt-6 space-y-2">
          {runs.map((run) => {
            const status = STATUS_TEXT[run.status] ?? { label: run.status, tone: "secondary" as const };
            const expanded = openId === run.id;
            return (
              <li key={run.id} className="rounded-xl border border-border/70 bg-muted/20">
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setOpenId(expanded ? null : run.id)}
                  className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {run.input_summary || TASK_TEXT[run.task] || run.task}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {TASK_TEXT[run.task] ?? run.task} · {whenText(run.created_at)}
                      {run.latency_ms ? ` · ${Math.round(run.latency_ms / 100) / 10}s` : ""}
                    </p>
                  </div>
                  <Badge variant={status.tone}>{status.label}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {run.cost_source === "unknown" ? "—" : moneyText(run.cost_amount, currency)}
                  </span>
                </button>

                {expanded ? (
                  <div className="border-t border-border/70 px-4 py-3">
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                      {run.output || "No answer was produced."}
                    </p>
                    {run.escalation_signal ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Passed to your team because: {run.escalation_signal.replace(/_/g, " ")}
                      </p>
                    ) : null}
                    {run.tool_calls && run.tool_calls.length > 0 ? (
                      <ul className="mt-3 space-y-1.5">
                        {run.tool_calls.map((t, i) => (
                          <li
                            key={`${t.tool_name}-${i}`}
                            className="flex flex-wrap items-center gap-2 text-xs"
                          >
                            <Badge
                              variant={t.ok ? "secondary" : "destructive"}
                              className="text-[11px]"
                            >
                              {t.ok ? "Checked" : "Failed"}: {t.tool_name.replace(/_/g, " ")}
                            </Badge>
                            {t.latency_ms ? (
                              <span className="text-muted-foreground">{t.latency_ms} ms</span>
                            ) : null}
                            {!t.ok && t.error ? (
                              <span className="text-muted-foreground">{t.error}</span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {run.sources && run.sources.length > 0 ? (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {run.sources.map((s, i) => (
                          <Badge key={`${s.label}-${i}`} variant="secondary" className="text-[11px]">
                            {s.kind === "tool" ? "Looked up: " : "From: "}
                            {s.label}
                          </Badge>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-3 text-xs text-muted-foreground">
                        It answered without reading anything of yours.
                      </p>
                    )}

                    {canConfigure ? (
                      correctingId === run.id ? (
                        <div className="mt-4 space-y-3 rounded-xl border border-border/70 bg-card p-4">
                          <div className="space-y-1.5">
                            <Label htmlFor={`q-${run.id}`}>The question</Label>
                            <Input
                              id={`q-${run.id}`}
                              value={question}
                              onChange={(e) => setQuestion(e.target.value)}
                              placeholder="What the customer asked"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor={`a-${run.id}`}>What it should have said</Label>
                            <Textarea
                              id={`a-${run.id}`}
                              rows={3}
                              value={answer}
                              onChange={(e) => setAnswer(e.target.value)}
                              placeholder="Write the right answer in your own words."
                              className="resize-y"
                            />
                          </div>
                          <div className="flex gap-2">
                            <Button size="sm" disabled={saving} onClick={() => void saveCorrection()}>
                              {saving ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                              Teach it this
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setCorrectingId(null)}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="mt-4"
                          onClick={() => startCorrection(run)}
                        >
                          <PencilLine className="mr-2 h-3.5 w-3.5" />
                          This answer was wrong
                        </Button>
                      )
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {loading ? null : (
        <Button variant="outline" size="sm" className="mt-5" onClick={() => void load()}>
          <Loader2 className="mr-2 h-3.5 w-3.5" />
          Refresh
        </Button>
      )}
    </section>
  );
}
