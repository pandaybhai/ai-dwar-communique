import { forwardRef, useEffect, useId, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Coffee,
  Gem,
  GraduationCap,
  Loader2,
  MoreHorizontal,
  Scissors,
  Shirt,
  ShoppingBag,
  Users,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fbclidForLead, fireFromServer } from "@/lib/meta-pixel";
import { readAttribution } from "@/lib/marketing-analytics";
import type { BrowserMetaEvent } from "@/lib/meta-events";
import { CUSTOMERS, SELLS, type Customers, type Sells } from "@/lib/start-qualify";
import { SKIP_AFTER_MS } from "@/lib/lead-verify";
import { displayPhone } from "@/lib/phone";
import { useFunnel, useToSignup } from "@/components/start/use-start-funnel";
import {
  afterDetailsSent,
  back,
  checkDetails,
  funnelStore,
  pickCustomers,
  pickSells,
  progressOf,
  type Funnel,
  type IssuedVerify,
} from "@/lib/start-funnel";

/**
 * Batch 78: the /start card — questions first, number last, then WhatsApp
 * verification. Step 1 "What do you sell?" (7 cards) and step 2 "How many
 * customers?" (3 cards) are one tap each: picked and on to the next. Step 3
 * is name, business name and WhatsApp number (+91 chip, numeric keypad),
 * "Verify on WhatsApp →". Nothing is saved before step 3. Then "Open WhatsApp
 * to verify" (wa.me to AiDwar's number with "VERIFY V-XXXX" typed in); the
 * page notices the message by itself (useStartVerification) and goes to
 * /signup prefilled. After a minute "Continue without verifying" appears, so
 * nobody is stuck. The hero card and the final card share one store
 * (funnelStore), so the visitor carries on wherever they left off.
 */

const SELL_ICONS: Record<Sells, LucideIcon> = {
  jewellery: Gem,
  fashion: Shirt,
  food_cafe: Coffee,
  online_store: ShoppingBag,
  clinic_salon: Scissors,
  education: GraduationCap,
  other: MoreHorizontal,
};

export const StartLeadForm = forwardRef<
  HTMLFormElement,
  { variant: "hero" | "final"; className?: string }
>(function StartLeadForm({ variant, className }, ref) {
  const id = useId();
  const f = useFunnel();
  const toSignup = useToSignup();
  const [error, setError] = useState<{ field: "name" | "business" | "phone"; text: string } | null>(
    null,
  );
  const [sending, setSending] = useState(false);
  const [honeypot, setHoneypot] = useState("");
  const heading = useRef<HTMLHeadingElement | null>(null);
  const progress = progressOf(f.step);

  // Only the card the visitor is using moves focus when the step changes.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (f.active === variant) heading.current?.focus({ preventScroll: true });
  }, [f.step, f.active, variant]);

  const update = (next: (x: Funnel) => Funnel) =>
    funnelStore.set((x) => ({ ...next(x), active: variant }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (f.step !== "details" || sending) return;
    const checked = checkDetails({ name: f.name, business: f.business, phone: f.phone });
    if (!checked.ok) {
      setError({ field: checked.field, text: checked.error });
      return;
    }
    setError(null);
    setSending(true);
    let res: Response | null = null;
    try {
      res = await fetch("/api/public/demo-leads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          source: "landing_start",
          sells: f.sells,
          customers: f.customers,
          name: checked.name,
          business_name: checked.business,
          phone: checked.phone,
          landing_path: "/start",
          attribution: readAttribution(),
          company_website_confirm: honeypot,
          ...fbclidForLead(),
        }),
      });
    } catch {
      res = null;
    }
    const body = res ? ((await res.json().catch(() => ({}))) as Record<string, unknown>) : {};
    if (res && res.status === 400) {
      setSending(false);
      setError({ field: "phone", text: String(body["error"] ?? "Please check your details.") });
      return;
    }
    fireFromServer((body["meta"] as BrowserMetaEvent | null | undefined) ?? null);
    const verify = (body["verify"] as IssuedVerify | null | undefined) ?? null;
    setSending(false);
    const next = afterDetailsSent(
      { ...funnelStore.get(), name: checked.name, business: checked.business },
      checked.phone,
      verify,
      Date.now(),
    );
    funnelStore.set({ ...next, active: variant });
    // No code (busy network, verification unavailable): on to sign-up, unverified.
    if (!verify) await toSignup(next);
  }

  const field =
    "h-12 w-full rounded-xl border border-border-strong bg-background text-base text-foreground placeholder:text-muted-foreground outline-none transition focus-visible:border-success focus-visible:ring-4 focus-visible:ring-success/20";

  return (
    <form
      ref={ref}
      onSubmit={submit}
      noValidate
      className={cn("relative", className)}
      aria-label="Start your free trial"
      data-testid={`start-form-${variant}`}
      data-step={f.step}
    >
      {/* Thin progress bar: 1/3, 2/3, 3/3. */}
      <div className="mb-4 flex items-center gap-3">
        <div
          className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label="Progress"
          aria-valuemin={1}
          aria-valuemax={3}
          aria-valuenow={progress}
          aria-valuetext={`Step ${progress} of 3`}
        >
          <div
            className="h-full rounded-full bg-success transition-[width] duration-300 ease-out motion-reduce:transition-none"
            style={{ width: `${(progress / 3) * 100}%` }}
          />
        </div>
        <span className="text-xs font-semibold tabular-nums text-muted-foreground">
          {progress}/3
        </span>
      </div>

      {f.step === "sells" ? (
        <Step key="sells">
          <h2
            ref={heading}
            tabIndex={-1}
            className="mb-3 text-lg font-bold tracking-tight outline-none"
          >
            What do you sell?
          </h2>
          <div
            className="grid grid-cols-2 gap-2.5"
            role="radiogroup"
            aria-label="What do you sell?"
          >
            {SELLS.map((o, i) => (
              <TapCard
                key={o.value}
                icon={SELL_ICONS[o.value]}
                label={o.label}
                selected={f.sells === o.value}
                wide={i === SELLS.length - 1}
                onPick={() => update((x) => pickSells(x, o.value))}
                testId={`sells-${o.value}`}
              />
            ))}
          </div>
          <Promise />
        </Step>
      ) : f.step === "customers" ? (
        <Step key="customers">
          <BackLink onBack={() => update(back)} />
          <h2
            ref={heading}
            tabIndex={-1}
            className="mb-3 text-lg font-bold tracking-tight outline-none"
          >
            How many customers do you have?
          </h2>
          <div
            className="grid gap-2.5"
            role="radiogroup"
            aria-label="How many customers do you have?"
          >
            {CUSTOMERS.map((o) => (
              <TapCard
                key={o.value}
                icon={Users}
                label={o.label}
                selected={f.customers === o.value}
                onPick={() => update((x) => pickCustomers(x, o.value as Customers))}
                testId={`customers-${o.value}`}
              />
            ))}
          </div>
          <Promise />
        </Step>
      ) : f.step === "details" ? (
        <Step key="details" className="space-y-3">
          <BackLink onBack={() => update(back)} />
          <h2 ref={heading} tabIndex={-1} className="text-lg font-bold tracking-tight outline-none">
            Where should we send your free trial?
          </h2>
          {/* A field no person sees or fills; a bot that fills it is told "ok" and nothing is saved. */}
          <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
            <label htmlFor={`${id}-company-site`}>Company website (leave empty)</label>
            <input
              id={`${id}-company-site`}
              name="company_website_confirm"
              type="text"
              tabIndex={-1}
              autoComplete="off"
              value={honeypot}
              onChange={(e) => setHoneypot(e.target.value)}
            />
          </div>
          <Field id={`${id}-name`} label="Your name">
            <input
              id={`${id}-name`}
              name="name"
              autoComplete="name"
              value={f.name}
              onChange={(e) => funnelStore.set((x) => ({ ...x, name: e.target.value }))}
              placeholder="Asha Rao"
              className={cn(field, "px-4")}
              aria-invalid={error?.field === "name" || undefined}
              aria-describedby={error?.field === "name" ? `${id}-error` : undefined}
            />
          </Field>
          <Field id={`${id}-business`} label="Business name">
            <input
              id={`${id}-business`}
              name="business_name"
              autoComplete="organization"
              value={f.business}
              onChange={(e) => funnelStore.set((x) => ({ ...x, business: e.target.value }))}
              placeholder="Asha Jewels"
              className={cn(field, "px-4")}
              aria-invalid={error?.field === "business" || undefined}
              aria-describedby={error?.field === "business" ? `${id}-error` : undefined}
            />
          </Field>
          <Field id={`${id}-phone`} label="WhatsApp number">
            <div className="relative">
              <span
                aria-hidden="true"
                className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 rounded-lg bg-success-soft px-2 py-1.5 text-sm font-semibold text-success-soft-foreground"
              >
                +91
              </span>
              <input
                id={`${id}-phone`}
                name="phone"
                type="tel"
                inputMode="numeric"
                autoComplete="tel-national"
                value={f.phone}
                onChange={(e) => funnelStore.set((x) => ({ ...x, phone: e.target.value }))}
                placeholder="98123 45670"
                className={cn(field, "pl-16 pr-4")}
                aria-invalid={error?.field === "phone" || undefined}
                aria-describedby={error?.field === "phone" ? `${id}-error` : undefined}
              />
            </div>
          </Field>
          {error ? (
            <p id={`${id}-error`} role="alert" className="text-sm font-medium text-destructive">
              {error.text}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={sending}
            className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-success px-5 text-base font-bold text-success-foreground shadow-[0_10px_28px_-12px_var(--success)] transition hover:bg-success/90 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-success/30 disabled:opacity-80"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Verify on WhatsApp
            {!sending ? <ArrowRight className="h-4 w-4" aria-hidden="true" /> : null}
          </button>
          <p className="text-center text-sm font-medium text-foreground/80">
            Free trial · No card · We&apos;ll confirm your number on WhatsApp
          </p>
          <p className="text-center text-xs text-muted-foreground">
            By continuing you agree we may contact you on WhatsApp about your trial.{" "}
            <Link to="/privacy" className="underline underline-offset-2">
              Privacy
            </Link>
          </p>
        </Step>
      ) : f.step === "verify" ? (
        <VerifyScreen f={f} headingRef={heading} />
      ) : (
        <Step key="verified" className="py-4 text-center" data-testid="start-verified">
          <p
            ref={heading}
            tabIndex={-1}
            className="text-2xl font-extrabold outline-none"
            role="status"
          >
            {f.verifyState === "verified" ? "✅ Verified" : "Almost there"}
          </p>
          <p className="mt-2 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Taking you to sign-up…
          </p>
        </Step>
      )}
    </form>
  );
});

/** Batch 72's promise line, under the two taps. */
function Promise() {
  return (
    <p className="mt-3 text-center text-sm font-medium text-foreground/80">
      Free trial · No card · Live in 10 minutes
    </p>
  );
}

function Step({
  children,
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { "data-testid"?: string }) {
  return (
    <div
      {...rest}
      className={cn(
        "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-3 motion-safe:duration-300",
        className,
      )}
    >
      {children}
    </div>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-semibold text-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

function BackLink({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="-ml-1 mb-1 inline-flex min-h-9 items-center gap-1 rounded-lg px-1 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success/40"
    >
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> Back
    </button>
  );
}

/** A big tap card: one tap = picked (scale + check) and on to the next step. */
function TapCard({
  icon: Icon,
  label,
  selected,
  wide,
  onPick,
  testId,
}: {
  icon: LucideIcon;
  label: string;
  selected: boolean;
  wide?: boolean;
  onPick: () => void;
  testId: string;
}) {
  const [pressed, setPressed] = useState(false);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected || pressed}
      data-testid={testId}
      onClick={() => {
        if (pressed) return;
        setPressed(true);
        // Long enough to see the check; then the next step.
        window.setTimeout(onPick, 160);
      }}
      className={cn(
        "relative flex min-h-14 items-center gap-3 rounded-2xl border-2 px-3.5 text-left text-[0.95rem] font-semibold transition duration-200 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-success/25 motion-safe:active:scale-[0.97]",
        wide && "col-span-2",
        selected || pressed
          ? "border-success bg-success-soft text-foreground motion-safe:scale-[1.03]"
          : "border-border-strong bg-background text-foreground hover:border-success/60",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid h-9 w-9 shrink-0 place-items-center rounded-xl transition",
          selected || pressed
            ? "bg-success text-success-foreground"
            : "bg-muted text-foreground/80",
        )}
      >
        {selected || pressed ? <Check className="h-5 w-5" /> : <Icon className="h-5 w-5" />}
      </span>
      <span className="leading-tight">{label}</span>
    </button>
  );
}

/** "Open WhatsApp to verify" — the page notices the message by itself. */
function VerifyScreen({
  f,
  headingRef,
}: {
  f: Funnel;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  const toSignup = useToSignup();
  const [now, setNow] = useState(() => Date.now());
  const [renewing, setRenewing] = useState(false);
  const [renewError, setRenewError] = useState<string | null>(null);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const canSkip = f.verifyShownAt !== null && now - f.verifyShownAt >= SKIP_AFTER_MS;
  const expired = f.verifyState === "expired";

  async function renew() {
    setRenewing(true);
    setRenewError(null);
    try {
      const res = await fetch("/api/public/start-verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action: "new_code" }),
      });
      const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const verify = (out["verify"] as IssuedVerify | undefined) ?? null;
      if (!res.ok || !verify) {
        setRenewError(String(out["error"] ?? "We couldn't make a new code. Please try again."));
      } else {
        funnelStore.set((x) => ({
          ...x,
          verify,
          verifyState: "waiting",
          verifyShownAt: Date.now(),
        }));
      }
    } catch {
      setRenewError("We couldn't make a new code. Please try again.");
    }
    setRenewing(false);
  }

  return (
    <Step key="verify" className="space-y-4" data-testid="start-verify">
      <div>
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="text-lg font-bold tracking-tight outline-none"
        >
          One last step: confirm your number
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Send one message from{" "}
          <span className="font-semibold text-foreground">{displayPhone(f.savedPhone ?? "")}</span>{" "}
          — it&apos;s free.
        </p>
      </div>
      {expired ? (
        <div className="space-y-3 rounded-xl bg-muted/60 p-3 text-sm" role="status">
          <p>That code has expired.</p>
          <button
            type="button"
            onClick={() => void renew()}
            disabled={renewing}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border-strong px-4 font-semibold"
          >
            {renewing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Get a new code
          </button>
          {renewError ? <p className="text-destructive">{renewError}</p> : null}
        </div>
      ) : (
        <>
          <a
            href={f.verify?.wa_link}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="verify-whatsapp"
            className="flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-[#25D366] px-5 text-lg font-bold text-[#052e16] shadow-[0_14px_34px_-14px_#25D366] transition hover:brightness-105 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-success/30"
          >
            <WhatsAppGlyph /> Open WhatsApp to verify
          </a>
          <p className="text-center text-sm font-medium text-foreground/80">
            Tap send in WhatsApp — we&apos;ll do the rest.
          </p>
          <p
            className="flex items-center justify-center gap-2 text-xs text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            Waiting for your message{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.7rem] text-foreground">
              {f.verify?.message}
            </code>
          </p>
        </>
      )}
      {canSkip || expired ? (
        <p className="text-center text-xs text-muted-foreground" data-testid="verify-skip">
          Having trouble?{" "}
          <button
            type="button"
            className="font-semibold text-foreground underline underline-offset-2"
            onClick={() => void toSignup(funnelStore.get())}
          >
            Continue without verifying
          </button>
        </p>
      ) : null}
    </Step>
  );
}

function WhatsAppGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden="true" fill="currentColor">
      <path d="M12.04 2a9.9 9.9 0 0 0-8.5 15l-1.4 5 5.1-1.34A9.9 9.9 0 1 0 12.04 2Zm0 18.1a8.2 8.2 0 0 1-4.18-1.15l-.3-.18-3.03.8.81-2.95-.2-.3a8.2 8.2 0 1 1 6.9 3.78Zm4.5-6.15c-.25-.12-1.46-.72-1.69-.8-.23-.08-.39-.12-.55.12-.16.25-.63.8-.78.96-.14.16-.29.18-.53.06a6.7 6.7 0 0 1-3.32-2.9c-.25-.43.25-.4.72-1.33.08-.16.04-.3-.02-.42l-.75-1.8c-.2-.47-.4-.4-.55-.41h-.47a.9.9 0 0 0-.65.3 2.74 2.74 0 0 0-.85 2.04 4.76 4.76 0 0 0 1 2.53 10.9 10.9 0 0 0 4.17 3.68c1.55.67 2.16.73 2.94.61.47-.07 1.46-.6 1.66-1.18.2-.58.2-1.07.15-1.18-.06-.1-.22-.16-.47-.28Z" />
    </svg>
  );
}
