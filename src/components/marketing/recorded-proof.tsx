import { useState } from "react";
import { BookOpen, CheckCheck, Info, UserCog } from "lucide-react";
import { cn } from "@/lib/utils";
import { trackMarketing } from "@/lib/marketing-analytics";
import type { PublicProof } from "@/lib/demo-proof";

/**
 * Replay of real AiDwar runs recorded against an internal test workspace that
 * contains only fictional business data. Every word in the reply bubbles comes
 * from `demo_proof_runs` — nothing here is written by hand, and nothing here
 * is a live customer conversation.
 */

const TAB_LABEL: Record<string, string> = {
  grounded: "A question it can answer",
  handoff: "A question it can't",
};

function when(value: string): string {
  return new Date(value).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function RecordedProof({ proof }: { proof: PublicProof[] }) {
  const [active, setActive] = useState(0);
  const [showFacts, setShowFacts] = useState(false);
  if (!proof.length) return null;
  const current = proof[Math.min(active, proof.length - 1)]!;

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-secondary/40 px-4 py-2.5">
        <p className="text-xs font-semibold uppercase tracking-wide text-primary">
          Replay of a real test
        </p>
        <p className="text-[11px] text-muted-foreground">Fictional business data</p>
      </div>

      {proof.length > 1 ? (
        <div role="tablist" aria-label="Recorded test cases" className="flex gap-1 border-b border-border p-2">
          {proof.map((item, index) => (
            <button
              key={item.scenario}
              role="tab"
              type="button"
              aria-selected={index === active}
              onClick={() => {
                setActive(index);
                trackMarketing("proof_engaged", { example: item.scenario });
              }}
              className={cn(
                "min-h-10 flex-1 rounded-xl px-3 text-sm font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                index === active
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              {TAB_LABEL[item.scenario] ?? item.scenario}
            </button>
          ))}
        </div>
      ) : null}

      <div className="space-y-3 bg-[#ece5dd] px-4 py-5 dark:bg-muted">
        <div className="flex justify-end">
          <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-[#d9fdd3] px-3.5 py-2.5 text-sm leading-6 text-neutral-900 shadow-sm">
            {current.question}
          </p>
        </div>
        {current.answer ? (
          <div className="flex justify-start">
            <div className="max-w-[88%] rounded-2xl rounded-bl-sm bg-white px-3.5 py-2.5 text-sm leading-6 text-neutral-900 shadow-sm">
              <p className="whitespace-pre-wrap">{current.answer}</p>
              <p className="mt-1 flex items-center justify-end gap-1 text-[11px] text-neutral-500">
                Drafted <CheckCheck className="size-3.5" />
              </p>
            </div>
          </div>
        ) : null}
      </div>

      <div className="space-y-3 px-4 py-4">
        <p className="flex items-start gap-2 text-sm leading-6 text-foreground">
          <UserCog className="mt-0.5 size-4 shrink-0 text-primary" />
          <span>{current.workflow_state}</span>
        </p>

        <button
          type="button"
          onClick={() => setShowFacts((v) => !v)}
          aria-expanded={showFacts}
          className="flex min-h-10 items-center gap-2 text-sm font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <BookOpen className="size-4" />
          {showFacts ? "Hide" : "Show"} everything the AI was given
        </button>
        {showFacts ? (
          <ul className="space-y-2 rounded-xl bg-secondary/50 p-3 text-xs leading-5 text-muted-foreground">
            {current.source_facts.map((fact) => (
              <li key={fact.title}>
                <span className="font-semibold text-foreground">{fact.title}</span>
                <p className="mt-0.5 whitespace-pre-wrap">{fact.content}</p>
              </li>
            ))}
          </ul>
        ) : null}

        <p className="flex items-start gap-2 border-t border-border pt-3 text-xs leading-5 text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Recorded {when(current.captured_at)} in an internal AiDwar test workspace holding only
            fictional products. No customer data, and no message was sent to anyone. Result recorded
            as <span className="font-medium text-foreground">{current.status}</span>
            {current.escalation_signal ? ` (${current.escalation_signal})` : ""}.
          </span>
        </p>
      </div>
    </div>
  );
}
