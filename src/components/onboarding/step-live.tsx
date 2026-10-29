import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Loader2, PenLine, Zap } from "lucide-react";
import { StepHeading } from "@/components/onboarding/journey-shell";
import { journeyApi } from "@/lib/onboarding-client";
import { cn } from "@/lib/utils";

type Mode = "draft" | "replying";

const CHOICES: Array<{
  mode: Mode;
  title: string;
  body: string;
  badge?: string;
  icon: typeof Zap;
}> = [
  {
    mode: "draft",
    title: "Draft",
    body: "Aiden writes every reply and waits. You read it in the Inbox and send it with one tap — or change a word first.",
    badge: "Best for your first days",
    icon: PenLine,
  },
  {
    mode: "replying",
    title: "Replying",
    body: "Aiden answers customers himself, day and night. When he isn't sure, he hands the chat to you and tells you on WhatsApp.",
    icon: Zap,
  },
];

/**
 * Step 4 — Go live. One decision, one tap: Draft (Aiden suggests, you
 * approve) or Replying (Aiden answers). Goes through the same mode switch as
 * the Employee page; whatever the database says no to (no credits, no test
 * yet) comes back in its own words with the way forward.
 */
export function StepLive({
  organizationId,
  business,
  connected,
  currentMode,
  onLive,
  onNeedsTest,
  onConnect,
}: {
  organizationId: string;
  business: string;
  connected: boolean;
  currentMode: string;
  onLive: (mode: Mode) => void;
  onNeedsTest: () => void;
  onConnect: () => void;
}) {
  const [busy, setBusy] = useState<Mode | null>(null);
  const [problem, setProblem] = useState<{
    text: string;
    billing?: boolean;
    needsTest?: boolean;
  } | null>(null);

  async function choose(mode: Mode) {
    if (busy) return;
    setBusy(mode);
    setProblem(null);
    const res = await journeyApi<{ ok: boolean; mode: string }>({
      action: "go_live",
      organization_id: organizationId,
      mode,
    });
    setBusy(null);
    if (res.data?.ok) {
      onLive(mode);
      return;
    }
    const raw = (res.raw ?? {}) as Record<string, unknown>;
    if (raw["needs_test"]) {
      setProblem({
        text: "Ask Aiden one customer question first, so you've seen how he answers before he replies on his own.",
        needsTest: true,
      });
      return;
    }
    setProblem({
      text: res.error ?? "We couldn't switch Aiden on. Please try again.",
      billing: raw["billing"] === true,
    });
  }

  return (
    <div>
      <StepHeading
        eyebrow="Go live"
        title={<>How should Aiden start at {business}?</>}
        lead="You can change this any time from the AI employee page."
      />

      {!connected ? (
        <p
          className="ob-rise mt-6 max-w-2xl rounded-2xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
          style={{ "--ob-delay": "60ms" } as React.CSSProperties}
        >
          Your WhatsApp number isn't connected yet — Aiden starts the moment it is.{" "}
          <button
            type="button"
            onClick={onConnect}
            className="font-semibold text-primary underline-offset-4 hover:underline"
          >
            Connect it now
          </button>
        </p>
      ) : null}

      <div
        role="group"
        aria-label="How Aiden replies"
        className="mt-8 grid max-w-4xl gap-4 sm:grid-cols-2"
      >
        {CHOICES.map((choice, i) => {
          const selected = currentMode === choice.mode;
          const Icon = choice.icon;
          return (
            <button
              key={choice.mode}
              type="button"
              aria-pressed={selected}
              disabled={Boolean(busy)}
              onClick={() => void choose(choice.mode)}
              className={cn(
                "ob-choice ob-rise group flex flex-col items-start rounded-3xl border-2 bg-card p-6 text-left shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-wait sm:p-7",
                selected ? "border-primary" : "border-border hover:border-primary/60",
              )}
              style={{ "--ob-delay": `${100 + i * 80}ms` } as React.CSSProperties}
            >
              <span className="flex w-full items-center justify-between gap-3">
                <span className="grid h-11 w-11 place-items-center rounded-2xl bg-primary/10 text-primary">
                  {busy === choice.mode ? (
                    <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  )}
                </span>
                {choice.badge ? (
                  <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
                    {choice.badge}
                  </span>
                ) : null}
              </span>
              <span className="mt-5 text-2xl font-bold tracking-tight">{choice.title}</span>
              <span className="mt-2 text-sm text-muted-foreground">{choice.body}</span>
              <span className="mt-6 text-sm font-semibold text-primary">
                {busy === choice.mode ? "Switching on…" : `Start in ${choice.title}`}
              </span>
            </button>
          );
        })}
      </div>

      {problem ? (
        <div
          role="alert"
          className="ob-pop mt-6 max-w-2xl rounded-2xl border border-warning-border bg-warning-soft p-4 text-sm"
        >
          <p>{problem.text}</p>
          {problem.needsTest ? (
            <button
              type="button"
              onClick={onNeedsTest}
              className="mt-2 font-semibold text-primary underline-offset-4 hover:underline"
            >
              Try Aiden now
            </button>
          ) : null}
          {problem.billing ? (
            <Link
              to="/app/billing"
              className="mt-2 inline-block font-semibold text-primary underline-offset-4 hover:underline"
            >
              Add credits or pick a plan
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
