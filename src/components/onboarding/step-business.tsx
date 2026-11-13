import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Globe, Loader2, MessageCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PrimaryAction, StepHeading } from "@/components/onboarding/journey-shell";
import { journeyApi, type PeekReply, type SiteBrand } from "@/lib/onboarding-client";
import { nameFromHost, normaliseSiteInput } from "@/lib/site-peek";

/**
 * Step 1 — Your business. The moment the website is a real address we take
 * a quick look (site-peek) and show the business back to the owner — its
 * name, its logo, its colour — so the first thing they see is that AiDwar
 * already knows them.
 *
 * Batch 78: the website is optional — a clear choice, "Yes, here's my
 * website" (the path above, unchanged) or "I don't have a website — I'll
 * tell Aiden on WhatsApp" (the business name alone; Aiden asks four quick
 * questions on WhatsApp). Every account without a workspace lands here, so
 * one stuck at "add your website" can now finish without one.
 */
export function StepBusiness({
  existingName,
  existingUrl,
  onBrand,
  onSubmit,
}: {
  existingName: string | null;
  existingUrl: string | null;
  /** The colour as soon as we know it, so the whole screen takes it on. */
  onBrand: (color: string | null) => void;
  onSubmit: (input: {
    name: string;
    url: string | null;
    about: string | null;
    brand: SiteBrand | null;
    noWebsite?: boolean;
  }) => Promise<string | null>;
}) {
  // Batch 78: nothing chosen yet (unless a website is already on file).
  const [choice, setChoice] = useState<"site" | "none" | null>(existingUrl ? "site" : null);
  const [site, setSite] = useState(existingUrl ?? "");
  const [brand, setBrand] = useState<SiteBrand | null>(null);
  const [peeking, setPeeking] = useState(false);
  const [peekNote, setPeekNote] = useState<string | null>(null);
  const [name, setName] = useState(existingName ?? "");
  const [nameTouched, setNameTouched] = useState(Boolean(existingName));
  const noSite = choice === "none";
  const [logoFailed, setLogoFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastPeek = useRef<string | null>(null);

  const url = normaliseSiteInput(site);

  // A quick look 600 ms after the address stops changing.
  useEffect(() => {
    if (choice !== "site" || !url || url === lastPeek.current) return;
    const timer = window.setTimeout(() => {
      lastPeek.current = url;
      setPeeking(true);
      setPeekNote(null);
      void journeyApi<PeekReply>({ action: "peek", url }).then((res) => {
        if (lastPeek.current !== url) return;
        setPeeking(false);
        if (res.data?.brand) {
          setBrand(res.data.brand);
          setLogoFailed(false);
          onBrand(res.data.brand.color);
          if (!nameTouched) setName(res.data.brand.name || nameFromHost(res.data.brand.host));
        } else {
          setBrand(null);
          setPeekNote(res.error ?? null);
          if (!nameTouched) {
            try {
              setName(nameFromHost(new URL(url).hostname));
            } catch {
              /* keep what they typed */
            }
          }
        }
      });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [url, choice, nameTouched, onBrand]);

  const ready = name.trim().length >= 2 && (noSite || (choice === "site" && Boolean(url)));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || pending) return;
    setPending(true);
    setError(null);
    const failed = await onSubmit({
      name: name.trim(),
      url: noSite ? null : url,
      about: null,
      brand: noSite ? null : brand,
      noWebsite: noSite,
    });
    setPending(false);
    if (failed) setError(failed);
  }

  const greeting = brand?.name || (name.trim().length >= 2 ? name.trim() : null);

  return (
    <form onSubmit={submit} className="grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-start">
      <div>
        <StepHeading
          eyebrow="Your business"
          title={
            brand && !noSite && greeting ? (
              <>Hello, {greeting}.</>
            ) : (
              "Let's put Aiden to work for your business."
            )
          }
          lead={
            noSite
              ? "No website? No problem. Aiden will ask you four quick questions on WhatsApp — what you sell, your timings, payments and returns."
              : choice === "site"
                ? "Your website is all he needs to learn what you sell, your prices and your answers. Paste it below."
                : "Do you have a website? Either way, you'll be set up in a few minutes."
          }
        />

        <div
          className="ob-rise mt-8 max-w-xl space-y-5"
          style={{ "--ob-delay": "80ms" } as React.CSSProperties}
        >
          <div
            className="grid gap-3 sm:grid-cols-2"
            role="radiogroup"
            aria-label="Do you have a website?"
            data-testid="website-choice"
          >
            <ChoiceCard
              icon={Globe}
              selected={choice === "site"}
              title="Yes, here's my website"
              hint="Aiden reads it in about 2 minutes."
              onPick={() => {
                setChoice("site");
                setError(null);
              }}
              testId="choice-site"
            />
            <ChoiceCard
              icon={MessageCircle}
              selected={noSite}
              title="I don't have a website"
              hint="I'll tell Aiden on WhatsApp — 4 quick questions."
              onPick={() => {
                setChoice("none");
                setBrand(null);
                onBrand(null);
                setError(null);
              }}
              testId="choice-none"
            />
          </div>

          {choice === "site" ? (
            <div className="space-y-2">
              <Label htmlFor="ob-site" className="text-base">
                Your business website
              </Label>
              <div className="relative">
                <Globe
                  className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  id="ob-site"
                  value={site}
                  onChange={(e) => setSite(e.target.value)}
                  inputMode="url"
                  autoComplete="url"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="yourbusiness.in"
                  className="h-14 rounded-2xl pl-12 text-lg"
                  aria-describedby="ob-site-note"
                  autoFocus
                />
                {peeking ? (
                  <Loader2
                    className="absolute right-4 top-1/2 h-5 w-5 -translate-y-1/2 animate-spin text-muted-foreground"
                    aria-label="Looking you up"
                  />
                ) : null}
              </div>
              <p id="ob-site-note" className="text-sm text-muted-foreground" aria-live="polite">
                {peekNote ??
                  (peeking
                    ? "Looking you up…"
                    : "We only read public pages. Nothing is posted anywhere.")}
              </p>
            </div>
          ) : null}

          {choice ? (
            <div className="space-y-2">
              <Label htmlFor="ob-name" className="text-base">
                Business name
              </Label>
              <Input
                id="ob-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameTouched(true);
                }}
                placeholder="As your customers know it"
                className="h-12 rounded-xl text-base"
                autoComplete="organization"
              />
              <p className="text-sm text-muted-foreground">
                Aiden uses this name when he talks to your customers.
              </p>
            </div>
          ) : null}

          {error ? (
            <p
              role="alert"
              className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger-soft-foreground"
            >
              {error}
            </p>
          ) : null}

          <div className="flex flex-col gap-4 pt-2 sm:flex-row sm:items-center">
            <PrimaryAction type="submit" disabled={!ready || pending}>
              {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              {brand && !noSite ? "That's us — continue" : "Continue"}
              {pending ? null : <ArrowRight aria-hidden="true" />}
            </PrimaryAction>
          </div>
        </div>
      </div>

      {/* The business, recognised. */}
      <div className="hidden lg:block" aria-live="polite">
        {brand && !noSite ? (
          <BrandCard
            brand={brand}
            name={name}
            logoFailed={logoFailed}
            onLogoError={() => setLogoFailed(true)}
          />
        ) : (
          <div
            className="ob-rise rounded-3xl border border-dashed border-border bg-card/50 p-8 text-muted-foreground"
            style={{ "--ob-delay": "160ms" } as React.CSSProperties}
          >
            <p className="text-sm font-medium text-foreground">What happens next</p>
            {noSite ? (
              <ol className="mt-4 space-y-3 text-sm" data-testid="next-no-site">
                <li>1. Aiden asks you 4 quick questions on WhatsApp.</li>
                <li>2. Send a photo of your price list, if you have one.</li>
                <li>3. You ask him a customer question and watch him answer.</li>
                <li>4. You connect your business WhatsApp number.</li>
              </ol>
            ) : (
              <ol className="mt-4 space-y-3 text-sm">
                <li>1. Aiden reads your site — products, prices, answers.</li>
                <li>2. You connect your business WhatsApp number.</li>
                <li>3. You ask him a customer question and watch him answer.</li>
                <li>4. You choose: he drafts for you, or he replies on his own.</li>
              </ol>
            )}
            <p className="mt-6 text-sm">About five minutes, start to finish.</p>
          </div>
        )}
      </div>
      {brand && !noSite ? (
        <div className="lg:hidden" aria-hidden="true">
          <BrandCard
            brand={brand}
            name={name}
            logoFailed={logoFailed}
            onLogoError={() => setLogoFailed(true)}
            compact
          />
        </div>
      ) : null}
    </form>
  );
}

function BrandCard({
  brand,
  name,
  logoFailed,
  onLogoError,
  compact = false,
}: {
  brand: SiteBrand;
  name: string;
  logoFailed: boolean;
  onLogoError: () => void;
  compact?: boolean;
}) {
  const shown = name.trim() || brand.name || nameFromHost(brand.host);
  const initial = shown.charAt(0).toUpperCase() || "A";
  return (
    <div
      className={`ob-pop overflow-hidden rounded-3xl border border-border bg-card shadow-lg ${compact ? "" : "max-w-md"}`}
    >
      <div className="h-2" style={{ background: "var(--ob-business, var(--primary))" }} />
      <div className={compact ? "flex items-center gap-4 p-5" : "p-8"}>
        <div
          className={`grid shrink-0 place-items-center overflow-hidden rounded-2xl border border-border bg-background ${compact ? "h-14 w-14" : "h-20 w-20"}`}
        >
          {brand.logoUrl?.startsWith("https://") && !logoFailed ? (
            <img
              src={brand.logoUrl}
              alt=""
              className="h-full w-full object-contain p-2"
              onError={onLogoError}
            />
          ) : (
            <span
              className="text-2xl font-bold"
              style={{ color: "var(--ob-business, var(--primary))" }}
            >
              {initial}
            </span>
          )}
        </div>
        <div className={compact ? "min-w-0" : "mt-6"}>
          <p className={`font-bold tracking-tight ${compact ? "truncate text-lg" : "text-2xl"}`}>
            {shown}
          </p>
          <p className="mt-1 truncate text-sm text-muted-foreground">
            {brand.host.replace(/^www\./, "")}
          </p>
          {!compact && brand.description ? (
            <p className="mt-4 line-clamp-3 text-sm text-muted-foreground">{brand.description}</p>
          ) : null}
          {!compact ? (
            <p className="mt-6 inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: "var(--ob-business, var(--primary))" }}
                aria-hidden="true"
              />
              Aiden will start reading this the moment you continue
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Batch 78: one of the two big "Do you have a website?" cards. */
function ChoiceCard({
  icon: Icon,
  selected,
  title,
  hint,
  onPick,
  testId,
}: {
  icon: typeof Globe;
  selected: boolean;
  title: string;
  hint: string;
  onPick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-testid={testId}
      onClick={onPick}
      className={`flex min-h-16 items-start gap-3 rounded-2xl border-2 p-4 text-left transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/25 ${
        selected ? "border-primary bg-primary/5" : "border-border bg-card hover:border-primary/50"
      }`}
    >
      <span
        aria-hidden="true"
        className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${
          selected ? "bg-primary text-primary-foreground" : "bg-muted text-foreground/80"
        }`}
      >
        {selected ? <Check className="h-5 w-5" /> : <Icon className="h-5 w-5" />}
      </span>
      <span>
        <span className="block text-base font-semibold">{title}</span>
        <span className="mt-0.5 block text-sm text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}
