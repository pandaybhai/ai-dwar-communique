import { useState } from "react";
import {
  ArrowRight,
  Check,
  LifeBuoy,
  Loader2,
  PhoneCall,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { EmbeddedSignupButton, type ConnectedAccount } from "@/components/whatsapp-embedded-signup";
import { PrimaryAction, StepHeading } from "@/components/onboarding/journey-shell";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { journeyApi } from "@/lib/onboarding-client";
import type { EsOutcome } from "@/lib/embedded-signup-outcome";

/**
 * Step 2 — Connect WhatsApp. Before Meta's window opens: what will happen and
 * what you need, so nothing in it is a surprise. After: either the number,
 * celebrated, or one named outcome with its own way forward — and a person
 * to call at every point.
 */
export function StepConnect({
  organizationId,
  business,
  connected,
  ownerPhone,
  onConnected,
  onContinue,
  onSkip,
}: {
  organizationId: string;
  business: string;
  connected: { display: string | null; name: string | null } | null;
  ownerPhone: string | null;
  onConnected: (account: ConnectedAccount | null) => Promise<void>;
  onContinue: () => void;
  onSkip: () => Promise<void>;
}) {
  const [outcome, setOutcome] = useState<EsOutcome | null>(null);
  const [skipping, setSkipping] = useState(false);

  if (connected) {
    return <Connected business={business} number={connected.display} onContinue={onContinue} />;
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[1.05fr_0.95fr]">
      <div>
        <StepHeading
          eyebrow="Connect WhatsApp"
          title={<>Put Aiden on {business}'s WhatsApp.</>}
          lead="Meta's own sign-up opens in a small window. It takes about two minutes, and your personal WhatsApp isn't touched."
        />

        <div
          className="ob-rise mt-8 max-w-xl"
          style={{ "--ob-delay": "80ms" } as React.CSSProperties}
        >
          {outcome ? <Recovery outcome={outcome} /> : null}

          <div className={outcome ? "mt-6" : ""}>
            <EmbeddedSignupButton
              orgId={organizationId}
              quiet
              label="Continue with Facebook"
              buttonClassName="h-14 w-full rounded-full bg-primary-strong px-8 text-base font-semibold text-primary-strong-foreground shadow-lg shadow-primary/20 hover:bg-primary-strong/90 sm:w-auto"
              onOpened={() => {
                void journeyApi({
                  action: "mark",
                  organization_id: organizationId,
                  step: "connect_opened",
                });
              }}
              onOutcome={setOutcome}
              onConnected={async (account) => {
                setOutcome(null);
                await onConnected(account);
              }}
            />
          </div>
          <p className="mt-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <ShieldCheck className="h-4 w-4 text-primary-strong" aria-hidden="true" />
            Official Meta sign-up. We never see your Facebook password.
          </p>

          <CallbackRequest
            organizationId={organizationId}
            ownerPhone={ownerPhone}
            where="connect"
            problem={outcome?.kind ?? null}
            prominent={Boolean(outcome)}
          />

          <button
            type="button"
            disabled={skipping}
            onClick={async () => {
              setSkipping(true);
              await onSkip();
              setSkipping(false);
            }}
            className="mt-6 text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            I'll connect my number later — show me Aiden first
          </button>
        </div>
      </div>

      <aside
        className="ob-rise space-y-4"
        style={{ "--ob-delay": "140ms" } as React.CSSProperties}
        aria-label="Before you start"
      >
        <div className="rounded-3xl border border-border bg-card p-6 sm:p-7">
          <h2 className="text-base font-semibold">What will happen</h2>
          <ol className="mt-4 space-y-4 text-sm">
            {[
              ["Log in with Facebook", "Any account that manages your business on Meta."],
              ["Choose your business", "Pick it, or create one — a name and a website are enough."],
              [
                "Add the number customers will message",
                "Meta checks it with a code by SMS or call.",
              ],
              ["You're live on WhatsApp", "We switch on incoming messages for you."],
            ].map(([title, hint], i) => (
              <li key={title} className="flex gap-3">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent text-xs font-bold text-accent-foreground">
                  {i + 1}
                </span>
                <span>
                  <span className="block font-medium">{title}</span>
                  <span className="block text-muted-foreground">{hint}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
        <div className="rounded-3xl border border-border bg-card p-6 sm:p-7">
          <h2 className="text-base font-semibold">What you'll need</h2>
          <ul className="mt-4 space-y-3 text-sm">
            <li className="flex gap-3">
              <Smartphone
                className="mt-0.5 h-4 w-4 shrink-0 text-primary-strong"
                aria-hidden="true"
              />
              <span>
                <span className="font-medium">A number that isn't on the WhatsApp app.</span>{" "}
                <span className="text-muted-foreground">
                  A new SIM or your office landline works. A number already on WhatsApp has to leave
                  the app first.
                </span>
              </span>
            </li>
            <li className="flex gap-3">
              <PhoneCall
                className="mt-0.5 h-4 w-4 shrink-0 text-primary-strong"
                aria-hidden="true"
              />
              <span>
                <span className="font-medium">That phone nearby</span>{" "}
                <span className="text-muted-foreground">for Meta's 6-digit code.</span>
              </span>
            </li>
            <li className="flex gap-3">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary-strong" aria-hidden="true" />
              <span>
                <span className="font-medium">A Facebook login.</span>{" "}
                <span className="text-muted-foreground">Nothing is posted to your profile.</span>
              </span>
            </li>
          </ul>
        </div>
      </aside>
    </div>
  );
}

/** One named outcome, its plain reason, and what to do — never just "something went wrong". */
export function Recovery({ outcome }: { outcome: EsOutcome }) {
  return (
    <div
      role="alert"
      className="ob-pop rounded-3xl border border-amber-500/40 bg-amber-500/10 p-5 sm:p-6"
      data-outcome={outcome.kind}
    >
      <p className="text-base font-semibold text-foreground">{outcome.title}</p>
      <p className="mt-1 text-sm text-foreground/80">{outcome.body}</p>
      {outcome.steps.length ? (
        <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-foreground/90">
          {outcome.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      ) : null}
      {outcome.detail ? (
        <p className="mt-3 text-xs text-muted-foreground">Meta said: {outcome.detail}</p>
      ) : null}
    </div>
  );
}

/** "Need help? We'll call you" — one tap tells the AiDwar team. */
export function CallbackRequest({
  organizationId,
  ownerPhone,
  where,
  problem,
  prominent = false,
}: {
  organizationId: string;
  ownerPhone: string | null;
  where: string;
  problem: string | null;
  prominent?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState(ownerPhone ?? "");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  if (state === "sent") {
    return (
      <p
        role="status"
        className="ob-pop mt-6 flex items-start gap-3 rounded-2xl bg-accent p-4 text-sm text-accent-foreground"
      >
        <LifeBuoy className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        Done — someone from AiDwar will call you shortly (10am–7pm IST). Your progress is saved.
      </p>
    );
  }

  return (
    <div className={`mt-6 rounded-2xl ${prominent ? "border border-border bg-card p-4" : ""}`}>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-2 text-sm font-semibold text-primary-strong underline-offset-4 hover:underline"
        >
          <LifeBuoy className="h-4 w-4" aria-hidden="true" />
          Need help? We'll call you
        </button>
      ) : (
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setState("sending");
            setError(null);
            const res = await journeyApi({
              action: "callback",
              organization_id: organizationId,
              phone,
              where,
              problem,
            });
            if (res.error) {
              setError(res.error);
              setState("idle");
            } else setState("sent");
          }}
        >
          <Label htmlFor={`ob-callback-${where}`}>The number we should call</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id={`ob-callback-${where}`}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="98765 43210"
              className="h-11 rounded-xl"
            />
            <button
              type="submit"
              disabled={state === "sending" || phone.replace(/\D/g, "").length < 10}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-foreground px-5 text-sm font-semibold text-background disabled:opacity-50"
            >
              {state === "sending" ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : null}
              Call me
            </button>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </form>
      )}
    </div>
  );
}

/** The number is live: one small, satisfying moment, then onward. */
function Connected({
  business,
  number,
  onContinue,
}: {
  business: string;
  number: string | null;
  onContinue: () => void;
}) {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center pt-6 text-center sm:pt-12">
      <span className="ob-pop ob-ring grid h-24 w-24 place-items-center rounded-full bg-primary-strong text-primary-strong-foreground">
        <svg viewBox="0 0 24 24" className="h-12 w-12" fill="none" aria-hidden="true">
          <path
            className="ob-check-path"
            d="M5 12.5l4.2 4.2L19 7"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <h1
        className="ob-rise mt-8 text-balance text-3xl font-bold tracking-tight sm:text-5xl"
        style={{ "--ob-delay": "200ms" } as React.CSSProperties}
      >
        {business} is on WhatsApp.
      </h1>
      <p
        className="ob-rise mt-4 text-lg text-muted-foreground"
        style={{ "--ob-delay": "280ms" } as React.CSSProperties}
        role="status"
      >
        {number ? (
          <>
            Customers who message <span className="font-semibold text-foreground">{number}</span>{" "}
            will reach Aiden.
          </>
        ) : (
          "Customers who message your number will reach Aiden."
        )}
      </p>
      <div
        className="ob-rise mt-10 w-full sm:w-auto"
        style={{ "--ob-delay": "360ms" } as React.CSSProperties}
      >
        <PrimaryAction type="button" onClick={onContinue} autoFocus>
          Meet Aiden <ArrowRight aria-hidden="true" />
        </PrimaryAction>
      </div>
    </div>
  );
}
