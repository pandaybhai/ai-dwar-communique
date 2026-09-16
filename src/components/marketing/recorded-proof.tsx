import { useState } from "react";
import { BookOpen, Info, UserCog } from "lucide-react";
import { cn } from "@/lib/utils";
import { trackMarketing } from "@/lib/marketing-analytics";
import type { PublicProof } from "@/lib/demo-proof";

/**
 * Replay of real AiDwar runs recorded against an internal test workspace that
 * contains only fictional business data. Every word in the reply bubbles comes
 * from `demo_proof_runs` — nothing here is written by hand, and nothing here
 * is a live customer conversation. Internal provenance (raw status, signals,
 * model, fixture note) stays in the database; this component shows only the
 * owner-friendly version.
 */

const TAB_LABEL: Record<string, string> = {
  grounded: "A question it can answer",
  handoff: "A question it can't",
};

type StatusCopy = { label: string; explanation: string };

const KNOWN: StatusCopy = {
  label: "Draft ready for review",
  explanation: "Answered using the demo catalogue and saved for review. No message was sent.",
};

const UNKNOWN: StatusCopy = {
  label: "Needs owner input",
  explanation:
    "No discount policy was provided, so AiDwar flagged the request for the owner. No message was sent.",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Deterministic IST formatting — identical on server and client. */
function when(value: string): string {
  const ist = new Date(new Date(value).getTime() + 5.5 * 60 * 60 * 1000);
  const day = ist.getUTCDate();
  const month = MONTHS[ist.getUTCMonth()];
  const year = ist.getUTCFullYear();
  let h = ist.getUTCHours();
  const m = String(ist.getUTCMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${day} ${month} ${year}, ${h}:${m} ${ampm}`;
}

function statusCopy(proof: PublicProof): StatusCopy {
  return proof.status === "ok" && !proof.escalation_signal ? KNOWN : UNKNOWN;
}

export function RecordedProof({ proof }: { proof: PublicProof[] }) {
  const [active, setActive] = useState(0);
  if (!proof.length) return null;
  const current = proof[Math.min(active, proof.length - 1)]!;

  return (
    <div>
      {proof.length > 1 ? <>
        <div role="tablist" aria-label="Recorded test cases" className="flex gap-1 rounded-t-2xl border border-b-0 border-border p-2 md:hidden">
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
        </> : null}
        <div className="md:hidden">
          <ProofCase proof={current} connected={proof.length > 1} />
        </div>
        <div className="hidden gap-4 md:grid md:grid-cols-2">
          {proof.map((item) => <ProofCase key={item.scenario} proof={item} />)}
        </div>
    </div>
  );
}

function ProofCase({ proof, connected = false }: { proof: PublicProof; connected?: boolean }) {
  const [showFacts, setShowFacts] = useState(false);
  const status = statusCopy(proof);
  return (
    <article className={cn("overflow-hidden border border-border bg-card shadow-sm", connected ? "rounded-b-2xl" : "rounded-2xl")}>
      <div className="space-y-3 bg-secondary/60 px-4 py-5">
        <div className="flex justify-end">
          <p className="max-w-[88%] rounded-2xl rounded-br-sm bg-primary/15 px-3.5 py-2.5 text-sm leading-6 text-foreground shadow-sm">{proof.question}</p>
        </div>
        {proof.answer ? <div className="flex justify-start"><div className="max-w-[90%] rounded-2xl rounded-bl-sm bg-card px-3.5 py-2.5 text-sm leading-6 text-foreground shadow-sm"><p className="whitespace-pre-wrap">{proof.answer}</p><p className="mt-1 text-right text-[11px] text-muted-foreground">Drafted</p></div></div> : null}
      </div>
      <div className="space-y-3 px-4 py-4">
        <p className="flex items-start gap-2 text-sm leading-6 text-foreground"><UserCog className="mt-0.5 size-4 shrink-0 text-primary" /><span><span className="font-semibold">{status.label}.</span> {status.explanation}</span></p>
        <button type="button" onClick={() => setShowFacts((v) => !v)} aria-expanded={showFacts} className="flex min-h-10 items-center gap-2 text-sm font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><BookOpen className="size-4" />{showFacts ? "Hide the source facts" : "View the source facts"}</button>
        {showFacts ? <ul className="space-y-2 rounded-xl bg-secondary/50 p-3 text-xs leading-5 text-muted-foreground">{proof.source_facts.map((fact) => <li key={fact.title}><span className="font-semibold text-foreground">{fact.title}</span><p className="mt-0.5 whitespace-pre-wrap">{fact.content}</p></li>)}</ul> : null}
        <p className="flex items-start gap-2 border-t border-border pt-3 text-[11px] leading-5 text-muted-foreground"><Info className="mt-0.5 size-3.5 shrink-0" /><span>Recorded test · fictional business data · {when(proof.captured_at)}</span></p>
      </div>
    </article>
  );
}
