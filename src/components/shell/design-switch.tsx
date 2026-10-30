import { useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { ArrowLeftRight } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useOrg } from "@/lib/org-context";
import { useDesignAnswer } from "@/lib/new-design";
import { DESIGN_LABEL, INTRO_STEPS, routeInOtherDesign, type DesignName } from "@/lib/aiden-workspace";

/**
 * Batch 53: the avatar menu's design switch, in both shells. Classic offers
 * "Try Aiden Workspace", Aiden Workspace offers "Switch to Classic". Shown
 * only when the resolver says the switch would change something (the release
 * flag is on and no Super Admin override decides). Switching keeps the page
 * (routeInOtherDesign) and is remembered server-side for every device.
 */
export function useDesignSwitch(current: DesignName) {
  const answer = useDesignAnswer();
  const org = useOrg() as Partial<ReturnType<typeof useOrg>>;
  const navigate = useNavigate();
  const location = useRouterState({ select: (s) => s.location });
  const target: DesignName = current === "classic" ? "aiden_workspace" : "classic";
  const label = current === "classic" ? `Try ${DESIGN_LABEL.aiden_workspace}` : `Switch to ${DESIGN_LABEL.classic}`;

  async function run() {
    const next = routeInOtherDesign(
      location.pathname,
      (location.search ?? {}) as Record<string, unknown>,
      target,
    );
    await org.chooseDesign?.(target, current, location.pathname);
    void navigate({ to: next.to as never, search: next.search as never, replace: true });
  }

  return { visible: answer.switchVisible && typeof org.chooseDesign === "function", label, run };
}

export function DesignSwitchItem({ current, className }: { current: DesignName; className?: string }) {
  const sw = useDesignSwitch(current);
  if (!sw.visible) return null;
  return (
    <DropdownMenuItem onSelect={() => void sw.run()} className={className}>
      <ArrowLeftRight className="h-4 w-4" aria-hidden="true" />
      {sw.label}
    </DropdownMenuItem>
  );
}

/**
 * The first time someone lands in Aiden Workspace (only while the release
 * flag is on): three short steps, dismissible at any point, remembered on
 * the server. Nothing moves for someone who prefers reduced motion.
 */
export function AidenWorkspaceIntro() {
  const answer = useDesignAnswer();
  const org = useOrg() as Partial<ReturnType<typeof useOrg>>;
  const [step, setStep] = useState(0);
  const [closed, setClosed] = useState(false);
  const prefs = org.designPrefs ?? null;
  const open =
    !closed &&
    answer.design === "aiden_workspace" &&
    answer.source !== "today" &&
    prefs !== null &&
    !prefs.introSeenAt;
  if (!open) return null;

  const last = step === INTRO_STEPS.length - 1;
  const s = INTRO_STEPS[step]!;
  const finish = () => {
    setClosed(true);
    void org.markIntroSeen?.();
  };

  return (
    <Dialog open onOpenChange={(o) => (o ? null : finish())}>
      <DialogContent className="max-w-[26rem] gap-5 rounded-[20px] p-6 motion-reduce:animate-none motion-reduce:transition-none">
        <p className="text-sm font-semibold text-aiden-deep" aria-live="polite">
          Step {step + 1} of {INTRO_STEPS.length}
        </p>
        <DialogTitle className="font-display text-2xl font-extrabold text-foreground">{s.title}</DialogTitle>
        <DialogDescription className="text-body text-muted-foreground">{s.body}</DialogDescription>
        {step === 1 ? (
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="The menu">
            {["Home", "Inbox", "Campaigns", "Customers", "Automate", "Shop"].map((x) => (
              <li key={x} className="rounded-full bg-aiden-soft px-3 py-1 text-sm font-semibold text-aiden-deep">
                {x}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {!last ? (
            <Button type="button" variant="ghost" onClick={finish} className="mr-auto">
              Skip
            </Button>
          ) : null}
          {step > 0 ? (
            <Button type="button" variant="outline" onClick={() => setStep(step - 1)}>
              Back
            </Button>
          ) : null}
          <Button type="button" onClick={() => (last ? finish() : setStep(step + 1))}>
            {last ? "Got it" : "Next"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
