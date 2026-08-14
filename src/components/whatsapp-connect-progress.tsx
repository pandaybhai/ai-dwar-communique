import { AlertTriangle, Check, CircleDashed, Loader2, X } from "lucide-react";

export const CONNECT_STEPS = [
  { key: "popup_opened", label: "Facebook window opened" },
  { key: "code_received", label: "Sign-up code received" },
  { key: "token_exchanged", label: "Secure token exchanged" },
  { key: "waba_subscribed", label: "Business account subscribed" },
  { key: "phone_registered", label: "Phone registration started" },
  { key: "events_reprocessed", label: "Pending messages reprocessed" },
] as const;

export type ConnectStepKey = (typeof CONNECT_STEPS)[number]["key"];
export type StepState = "idle" | "active" | "done" | "warning" | "error";
export type StepStates = Partial<Record<ConnectStepKey, StepState>>;

function Icon({ state }: { state: StepState }) {
  if (state === "done")
    return (
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
        <Check className="h-3.5 w-3.5" />
      </span>
    );
  if (state === "active")
    return (
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      </span>
    );
  if (state === "warning")
    return (
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-amber-500/15 text-amber-600">
        <AlertTriangle className="h-3.5 w-3.5" />
      </span>
    );
  if (state === "error")
    return (
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <X className="h-3.5 w-3.5" />
      </span>
    );
  return (
    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-muted-foreground">
      <CircleDashed className="h-3.5 w-3.5" />
    </span>
  );
}

/** Live checklist for the Embedded Signup flow — one row per stage. */
export function ConnectProgress({
  states,
  notes,
}: {
  states: StepStates;
  notes?: Partial<Record<ConnectStepKey, string>>;
}) {
  return (
    <ol className="space-y-3">
      {CONNECT_STEPS.map((step) => {
        const state = states[step.key] ?? "idle";
        const note = notes?.[step.key];
        return (
          <li key={step.key} className="flex items-start gap-3">
            <Icon state={state} />
            <div className="min-w-0 pt-0.5">
              <p
                className={
                  state === "idle"
                    ? "text-sm text-muted-foreground transition-colors duration-200"
                    : state === "error"
                      ? "text-sm font-medium text-destructive"
                      : state === "warning"
                        ? "text-sm font-medium text-amber-600"
                        : "text-sm font-medium text-foreground"
                }
              >
                {step.label}
              </p>
              {note ? <p className="mt-0.5 text-xs text-muted-foreground">{note}</p> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
