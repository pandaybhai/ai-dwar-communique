import { useCallback, useEffect, useState } from "react";
import { CalendarCheck, Loader2, PencilLine } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { employeeApi, knowledgeApi, moneyText, type WeeklyReport as Report } from "@/lib/employee-client";

/**
 * The employee's Friday note to the merchant: what it did, what it cost, and
 * the questions it couldn't answer — each one a button away from being learned.
 */
export function WeeklyReport({
  organizationId,
  currency,
  canConfigure,
}: {
  organizationId: string;
  currency: string;
  canConfigure: boolean;
}) {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [teaching, setTeaching] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await employeeApi<{ report: Report }>({
      organization_id: organizationId,
      action: "weekly_report",
    });
    if (error) toast.error(error);
    setReport(data?.report ?? null);
    setLoading(false);
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const teach = async (question: string) => {
    if (!answer.trim()) {
      toast.error("Write the answer you'd give, and I'll use it from now on.");
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
    toast.success("Thanks — I'll handle that one myself next time.");
    setTeaching(null);
    setAnswer("");
    void load();
  };

  return (
    <section
      aria-labelledby="weekly-heading"
      className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 rounded-xl bg-primary/10 p-2 text-primary">
          <CalendarCheck className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <h2 id="weekly-heading" className="text-lg font-semibold text-foreground">
            My week
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Written by me, from the last seven days of my work.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="mt-5 space-y-2">
          <Skeleton className="h-5 w-3/4 rounded-lg" />
          <Skeleton className="h-16 w-full rounded-xl" />
        </div>
      ) : !report ? (
        <p className="mt-5 text-sm text-muted-foreground">
          I couldn't put my week together just now.{" "}
          <button type="button" className="font-medium text-primary underline" onClick={() => void load()}>
            Try again
          </button>
        </p>
      ) : report.answered === 0 && report.passed === 0 ? (
        <p className="mt-5 text-sm text-muted-foreground">
          I haven't done anything this week — nothing has come my way yet. Put me on drafting and
          I'll start writing replies for you to check.
        </p>
      ) : (
        <>
          <p className="mt-5 text-base leading-relaxed text-foreground">
            This week I answered <strong>{report.answered}</strong>{" "}
            {report.answered === 1 ? "question" : "questions"} and passed{" "}
            <strong>{report.passed}</strong> to you. I cost you{" "}
            <strong>{moneyText(report.cost, currency)}</strong>.
          </p>

          {report.learn.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">
              There was nothing I had to give up on this week.
            </p>
          ) : (
            <div className="mt-5">
              <p className="text-sm text-foreground">
                {report.learn.length}{" "}
                {report.learn.length === 1 ? "thing I couldn't answer" : "things I couldn't answer"}{" "}
                — teach me and I'll handle them next time:
              </p>
              <ul className="mt-3 space-y-2">
                {report.learn.map((item) => {
                  const open = teaching === item.question;
                  return (
                    <li
                      key={item.question}
                      className="rounded-xl border border-border/70 bg-muted/20 p-4"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <p className="min-w-0 flex-1 text-sm text-foreground">
                          &ldquo;{item.question}&rdquo;
                          {item.times > 1 ? (
                            <span className="text-muted-foreground"> (asked {item.times} times)</span>
                          ) : null}
                        </p>
                        {canConfigure ? (
                          <Button
                            size="sm"
                            variant={open ? "ghost" : "outline"}
                            onClick={() => {
                              setTeaching(open ? null : item.question);
                              setAnswer("");
                            }}
                          >
                            <PencilLine className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                            {open ? "Not now" : "Teach me the answer"}
                          </Button>
                        ) : null}
                      </div>

                      {open ? (
                        <div className="mt-3 space-y-3 rounded-xl border border-border/70 bg-card p-4">
                          <div className="space-y-1.5">
                            <Label htmlFor={`teach-${item.question}`}>
                              What should I say when they ask this?
                            </Label>
                            <Textarea
                              id={`teach-${item.question}`}
                              rows={3}
                              value={answer}
                              onChange={(e) => setAnswer(e.target.value)}
                              placeholder="Write it in your own words."
                              className="resize-y"
                            />
                          </div>
                          <Button size="sm" disabled={saving} onClick={() => void teach(item.question)}>
                            {saving ? (
                              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                            ) : null}
                            Save this answer
                          </Button>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {!canConfigure ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  Someone with the &ldquo;Configure AI&rdquo; permission can teach me these answers.
                </p>
              ) : null}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Unused import guard: Input is kept out deliberately. */
void Input;
