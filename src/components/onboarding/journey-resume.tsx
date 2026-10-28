import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { EXITED_KEY, journeyApi, readStorage, type JourneyStateReply } from "@/lib/onboarding-client";
import { JOURNEY_STEPS, STEP_LABELS, stepIndex, type JourneyStep } from "@/lib/onboarding-journey";

/**
 * Batch 40: an owner part-way through the first-run journey who comes back
 * to the app goes straight back to their step. After "Save & exit" (this
 * browser session) they stay, and Home shows where they stopped instead.
 * Workspaces that never started the journey (everyone before Batch 40) see
 * nothing; neither do team members, who can't set Aiden up.
 */
export function JourneyResume({ organizationId, isOwner }: { organizationId: string | null; isOwner: boolean }) {
  const navigate = useNavigate();
  const [step, setStep] = useState<JourneyStep | null>(null);

  useEffect(() => {
    if (!organizationId || !isOwner) return;
    let live = true;
    void journeyApi<JourneyStateReply>({ action: "state", organization_id: organizationId }).then((res) => {
      const state = res.data?.state;
      if (!live || !state?.active || state.step === "done") return;
      if (readStorage("session", EXITED_KEY(organizationId)) === "1") setStep(state.step);
      else void navigate({ to: "/app/start", search: { step: state.step }, replace: true });
    });
    return () => {
      live = false;
    };
  }, [organizationId, isOwner, navigate]);

  if (!step) return null;
  return (
    <div className="mb-6 flex flex-col gap-4 rounded-2xl border border-border bg-card p-5 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-sm font-semibold">
          Step {stepIndex(step) + 1} of {JOURNEY_STEPS.length}: {STEP_LABELS[step]}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">Your setup is saved. Pick up exactly where you left off.</p>
      </div>
      <Link
        to="/app/start"
        search={{ step }}
        className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-primary-strong px-5 text-sm font-semibold text-primary-strong-foreground"
      >
        Continue setup <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </Link>
    </div>
  );
}
