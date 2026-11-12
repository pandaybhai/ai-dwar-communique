import { forwardRef, useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { afterLeadSubmit, checkStartForm, signupSearchFrom } from "@/lib/start-page";
import { writeStartPrefill } from "@/lib/start-prefill";
import { fbclidForLead, fireFromServer } from "@/lib/meta-pixel";
import { readAttribution } from "@/lib/marketing-analytics";
import type { BrowserMetaEvent } from "@/lib/meta-events";
import { StartQuestions } from "@/components/start/start-questions";
import type { Customers, Sells } from "@/lib/start-qualify";

/**
 * Batch 72: step 1 of the two-step sign-up — name (optional on the sticky
 * bar) and WhatsApp number → /api/public/demo-leads (source landing_start),
 * then /signup with both prefilled from this tab's storage. The number never
 * goes in a URL. A repeat number (or a busy network) still continues.
 *
 * Batch 75: once the lead is saved, the same card (the sticky bar: a sheet)
 * asks two one-tap questions — what they sell, how many customers — saved to
 * that lead through its signed cookie, then /signup exactly as before. Both
 * are required (no skip). A hidden honeypot field catches bots.
 */
export const StartLeadForm = forwardRef<
  HTMLFormElement,
  {
    variant: "hero" | "final" | "bar";
    className?: string;
    /** Batch 73: the sticky bar's button shimmers now and then until the visitor interacts. */
    shimmer?: boolean;
  }
>(function StartLeadForm({ variant, className, shimmer }, ref) {
  const id = useId();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<{ field: "name" | "phone" | null; text: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [honeypot, setHoneypot] = useState("");
  // Batch 75: after the lead is saved, the two questions (then /signup).
  const [asked, setAsked] = useState<{ name: string; phone: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const bar = variant === "bar";

  async function toSignup(person: { name: string; phone: string }) {
    writeStartPrefill(person);
    await navigate({ to: "/signup", search: signupSearchFrom(window.location.search) as never });
  }

  // Batch 75 (required): /signup only after both answers are picked.
  async function answer(answers: { sells: Sells; customers: Customers }) {
    if (!asked || saving || !answers.sells || !answers.customers) return;
    setSaving(true);
    try {
      const res = await fetch("/api/public/start-qualify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(answers),
      });
      const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      fireFromServer((out["meta"] as BrowserMetaEvent | null | undefined) ?? null);
    } catch {
      // both answers were given; a busy network never strands the visitor
    }
    await toSignup(asked);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (sending) return;
    const checked = checkStartForm({ name: bar ? "" : name, phone });
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
        body: JSON.stringify({
          source: "landing_start",
          name: checked.name || undefined,
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
    const next = afterLeadSubmit(res ? res.status : null);
    if (next === "error") {
      setSending(false);
      setError({ field: "phone", text: String(body["error"] ?? "Please check your number.") });
      return;
    }
    // Saved, a repeat, or the network was busy: the visitor carries on.
    fireFromServer((body["meta"] as BrowserMetaEvent | null | undefined) ?? null);
    const person = { name: checked.name, phone: checked.phone };
    setSending(false);
    // Batch 75: the two questions are required before /signup — whether the
    // lead request was saved, repeated or went unanswered (a busy network).
    setAsked(person);
  }

  const field =
    "h-12 w-full rounded-xl border border-border-strong bg-background text-base text-foreground placeholder:text-muted-foreground outline-none transition focus-visible:border-success focus-visible:ring-4 focus-visible:ring-success/20";

  return (
    <form
      ref={ref}
      onSubmit={submit}
      noValidate
      className={cn(bar ? "flex flex-wrap items-center gap-2" : "relative space-y-3", className)}
      aria-label="Start your free trial"
      data-testid={`start-form-${variant}`}
      data-step={asked ? "questions" : "details"}
    >
      {asked && !bar ? (
        <StartQuestions onDone={(a) => void answer(a)} busy={saving} />
      ) : (
        <>
          {/* Batch 75: a field no person sees or fills; a bot that fills it is told "ok" and nothing is saved. */}
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
          {!bar ? (
            <div>
              <label
                htmlFor={`${id}-name`}
                className="mb-1.5 block text-sm font-semibold text-foreground"
              >
                Your name
              </label>
              <input
                id={`${id}-name`}
                name="name"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Asha Rao"
                className={cn(field, "px-4")}
                aria-invalid={error?.field === "name" || undefined}
              />
            </div>
          ) : null}
          <div className={bar ? "min-w-0 flex-1" : undefined}>
            <label
              htmlFor={`${id}-phone`}
              className={bar ? "sr-only" : "mb-1.5 block text-sm font-semibold text-foreground"}
            >
              WhatsApp number
            </label>
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
                inputMode="tel"
                autoComplete="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="98765 43210"
                className={cn(field, "pl-16 pr-4")}
                aria-invalid={error?.field === "phone" || undefined}
                aria-describedby={error ? `${id}-error` : undefined}
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={sending}
            className={cn(
              "inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-success px-5 text-base font-bold text-success-foreground shadow-[0_10px_28px_-12px_var(--success)] transition hover:bg-success/90 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-success/30 disabled:opacity-80",
              bar ? "shrink-0" : "w-full",
              shimmer !== undefined && "s73-shimmer",
            )}
            data-shimmer={shimmer === undefined ? undefined : shimmer ? "on" : "off"}
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Start free trial
            {!bar && !sending ? <ArrowRight className="h-4 w-4" aria-hidden="true" /> : null}
          </button>
          {error ? (
            <p
              id={`${id}-error`}
              role="alert"
              className={cn(
                "text-sm font-medium text-destructive",
                bar && "basis-full px-1 text-xs",
              )}
            >
              {error.text}
            </p>
          ) : null}
          {!bar ? (
            <>
              <p className="text-center text-sm font-medium text-foreground/80">
                Free trial · No card · Live in 10 minutes
              </p>
              <p className="text-center text-xs text-muted-foreground">
                By continuing you agree we may contact you on WhatsApp about your trial.{" "}
                <Link to="/privacy" className="underline underline-offset-2">
                  Privacy
                </Link>
              </p>
            </>
          ) : null}
        </>
      )}
      {asked && bar ? <QuestionsSheet onDone={(a) => void answer(a)} busy={saving} /> : null}
    </form>
  );
});

/**
 * The sticky bar's two questions: a bottom sheet on a phone, a centred card
 * on a desktop (portalled — the bar itself is transformed, so it can't hold a
 * full-screen layer).
 */
function QuestionsSheet({
  onDone,
  busy,
}: {
  onDone: (answers: { sells: Sells; customers: Customers }) => void;
  busy: boolean;
}) {
  const id = useId();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 md:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className="w-full max-w-md rounded-t-3xl bg-background p-5 text-foreground shadow-2xl motion-safe:animate-in motion-safe:slide-in-from-bottom-4 motion-safe:duration-300 md:rounded-3xl md:p-6"
        style={{ paddingBottom: "calc(1.25rem + env(safe-area-inset-bottom))" }}
      >
        <h2 id={`${id}-title`} className="mb-3 text-lg font-bold">
          Almost there
        </h2>
        <StartQuestions onDone={onDone} busy={busy} />
      </div>
    </div>,
    document.body,
  );
}
