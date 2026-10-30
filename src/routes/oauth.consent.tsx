import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Check, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { aidwar } from "@/integrations/aidwar/client";
import { useAppSurface } from "@/lib/theme";
import { useDesignSurface } from "@/lib/new-design";
import {
  CONSENT_CAN,
  CONSENT_CANNOT,
  consentProcessingLine,
  decideConsent,
  loadConsent,
  validAuthorizationId,
  type ConsentAuth,
  type ConsentDetails,
  type ConsentStep,
} from "@/lib/oauth-consent";

const TITLE = "Connect an AI assistant — AiDwar";
const DESCRIPTION = "Allow an AI assistant to use your AiDwar workspace.";

/**
 * Batch 52: Supabase OAuth's Authorization Path. An AI app sends the merchant
 * here (also as //oauth/consent, which the server collapses); signed out,
 * they log in and come back with the request kept. Always the new design.
 */
export const Route = createFileRoute("/oauth/consent")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>): { authorization_id?: string } => {
    const id = validAuthorizationId(search["authorization_id"]);
    return id ? { authorization_id: id } : {};
  },
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ConsentPage,
});

function ConsentPage() {
  useAppSurface();
  useDesignSurface(true);
  const { authorization_id } = Route.useSearch();
  const [step, setStep] = useState<ConsentStep | null>(null);
  const [pending, setPending] = useState<"allow" | "deny" | null>(null);
  const auth = aidwar.auth as unknown as ConsentAuth;

  useEffect(() => {
    let live = true;
    void loadConsent(auth, authorization_id).then((next) => {
      if (!live) return;
      if (next.kind === "login" || next.kind === "redirect") {
        window.location.replace(next.kind === "login" ? next.to : next.url);
        return;
      }
      setStep(next);
    });
    return () => {
      live = false;
    };
  }, [authorization_id]);

  async function decide(decision: "allow" | "deny") {
    if (step?.kind !== "details") return;
    setPending(decision);
    const next = await decideConsent(auth, step.details.authorizationId, decision);
    if (next.kind === "redirect") {
      window.location.assign(next.url);
      return;
    }
    setPending(null);
    setStep(next);
  }

  async function switchAccount() {
    await aidwar.auth.signOut();
    if (authorization_id) window.location.replace(`/login?redirect=${encodeURIComponent(`/oauth/consent?authorization_id=${authorization_id}`)}`);
  }

  return <ConsentView step={step} pending={pending} onDecide={decide} onSwitchAccount={switchAccount} />;
}

export function ConsentView({
  step,
  pending = null,
  onDecide,
  onSwitchAccount,
}: {
  step: ConsentStep | null;
  pending?: "allow" | "deny" | null;
  onDecide?: (d: "allow" | "deny") => void;
  onSwitchAccount?: () => void;
}) {
  return (
    <main className="ob-stage flex min-h-[100dvh] items-center justify-center px-4 py-10 sm:py-14">
      <div className="w-full max-w-[30rem]">
        <div className="mb-7 text-center">
          <Link
            to="/"
            className="rounded-lg font-display text-[1.625rem] font-extrabold tracking-[-0.02em] text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden"
          >
            aidwar
          </Link>
        </div>
        <section className="rounded-[20px] border border-border bg-card p-6 shadow-lg sm:p-8" aria-live="polite">
          {step?.kind === "details" ? (
            <Details details={step.details} pending={pending} onDecide={onDecide} onSwitchAccount={onSwitchAccount} />
          ) : step?.kind === "error" ? (
            <div>
              <h1 className="font-display text-[clamp(1.5rem,4vw,1.875rem)] font-extrabold leading-[1.1] tracking-[-0.02em]">
                This link didn't work
              </h1>
              <p className="mt-3 text-body text-muted-foreground">{step.message}</p>
              <Button asChild variant="outline" className="mt-6 h-11 w-full">
                <Link to="/app">Go to AiDwar</Link>
              </Button>
            </div>
          ) : (
            <p className="flex items-center gap-3 text-body text-muted-foreground">
              <Loader2 className="size-5 motion-safe:animate-spin" aria-hidden="true" />
              Checking the request…
            </p>
          )}
        </section>
        <p className="mt-6 text-center text-sm text-muted-foreground">
          You can remove access any time in Settings, Connected AI apps.
        </p>
      </div>
    </main>
  );
}

function Details({
  details,
  pending,
  onDecide,
  onSwitchAccount,
}: {
  details: ConsentDetails;
  pending: "allow" | "deny" | null;
  onDecide?: ((d: "allow" | "deny") => void) | undefined;
  onSwitchAccount?: (() => void) | undefined;
}) {
  const initial = details.clientName.trim().charAt(0).toUpperCase() || "A";
  return (
    <div>
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-ink font-display text-xl font-extrabold text-ink-foreground"
        >
          {initial}
        </span>
        <span aria-hidden="true" className="h-px w-6 shrink-0 bg-border" />
        <span
          aria-hidden="true"
          className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-aiden-soft text-aiden-deep"
        >
          <ShieldCheck className="size-6" />
        </span>
      </div>
      <h1 className="mt-5 font-display text-[clamp(1.5rem,4.4vw,2rem)] font-extrabold leading-[1.08] tracking-[-0.02em] [overflow-wrap:anywhere]">
        {details.clientName} wants to use your AiDwar workspace
      </h1>
      {details.userEmail ? (
        <p className="mt-2 text-body text-muted-foreground [overflow-wrap:anywhere]">
          Signed in as <span className="font-semibold text-foreground">{details.userEmail}</span>.{" "}
          {onSwitchAccount ? (
            <button
              type="button"
              onClick={onSwitchAccount}
              className="rounded font-semibold text-aiden-deep underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden"
            >
              Not you?
            </button>
          ) : null}
        </p>
      ) : null}

      <h2 className="mt-6 text-[1.0625rem] font-semibold">It will be able to</h2>
      <ul className="mt-3 grid list-none gap-3 p-0">
        {CONSENT_CAN.map((line) => (
          <li key={line} className="flex items-start gap-2.5 text-body">
            <Check className="mt-1 size-4 shrink-0 text-aiden-deep" aria-hidden="true" />
            <span>{line}</span>
          </li>
        ))}
      </ul>
      <p className="mt-4 rounded-xl bg-warning-soft px-4 py-3 text-sm text-warning-soft-foreground">{CONSENT_CANNOT}</p>
      <p className="mt-4 text-sm text-muted-foreground [overflow-wrap:anywhere]">
        {consentProcessingLine(details.clientName)}{" "}
        <Link to="/privacy" className="rounded font-semibold text-aiden-deep underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden">
          How AiDwar handles it
        </Link>
      </p>
      <p className="mt-4 text-sm text-muted-foreground [overflow-wrap:anywhere]">
        It acts as you, with your permissions in each workspace. After you allow it, you go back to{" "}
        <span className="font-semibold text-foreground">{details.redirectDomain}</span>.
      </p>

      <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row">
        <Button
          type="button"
          variant="outline"
          className="h-12 flex-1 text-base"
          disabled={pending !== null}
          onClick={() => onDecide?.("deny")}
        >
          {pending === "deny" ? <Loader2 className="motion-safe:animate-spin" aria-hidden="true" /> : null}
          Deny
        </Button>
        <Button
          type="button"
          className="h-12 flex-1 text-base"
          disabled={pending !== null}
          onClick={() => onDecide?.("allow")}
        >
          {pending === "allow" ? <Loader2 className="motion-safe:animate-spin" aria-hidden="true" /> : null}
          Allow
        </Button>
      </div>
    </div>
  );
}
