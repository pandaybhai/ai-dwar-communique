import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Eye, EyeOff, Loader2, MailCheck } from "lucide-react";
import { AuthShell } from "@/components/auth-shell";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PrimaryAction } from "@/components/onboarding/journey-shell";
import { aidwar } from "@/integrations/aidwar/client";
import { keepAttribution } from "@/lib/onboarding-client";

const TITLE = "Create your account — AiDwar";
const DESCRIPTION =
  "Create an AiDwar account and have an AI employee answering on your WhatsApp in five minutes.";

/**
 * Where the signup came from. Kept as intent only — the plan is never assigned
 * here; the purchase step later decides that.
 */
const ATTRIBUTION_KEYS = ["plan", "utm_source", "utm_medium", "utm_campaign", "ref"] as const;
type AttributionKey = (typeof ATTRIBUTION_KEYS)[number];
type SignupSearch = { redirect?: string } & Partial<Record<AttributionKey, string>>;

/**
 * Batch 40: Google sign-in is built but off until the Supabase Google
 * provider is configured and the founder says yes (it is a new way accounts
 * are created): set VITE_AIDWAR_GOOGLE_SIGNIN=on to show it.
 */
const GOOGLE_SIGNIN = import.meta.env["VITE_AIDWAR_GOOGLE_SIGNIN"] === "on";

export const Route = createFileRoute("/signup")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>): SignupSearch => {
    const out: SignupSearch = {};
    const r = search["redirect"];
    if (typeof r === "string" && r.startsWith("/")) out.redirect = r;
    for (const key of ATTRIBUTION_KEYS) {
      const value = search[key];
      if (typeof value === "string" && value.trim()) out[key] = value.trim().slice(0, 120);
    }
    return out;
  },
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
    ],
  }),
  component: SignupPage,
});

/** Aiden recognises the owner by this number: a 10-digit Indian mobile becomes +91, anything else must be full E.164. */
export function signupPhone(raw: string): string | null {
  const text = raw.trim();
  const digits = text.replace(/\D/g, "");
  const phone = text.startsWith("+")
    ? `+${digits}`
    : digits.length === 10
      ? `+91${digits}`
      : digits
        ? `+${digits}`
        : "";
  return /^\+\d{10,15}$/.test(phone) ? phone : null;
}

function SignupPage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const { redirect } = search;
  const goNext = () =>
    redirect
      ? navigate({ href: redirect, replace: true })
      : navigate({ to: "/app", replace: true });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [resent, setResent] = useState(false);

  // Held until the workspace is created — localStorage, so the tab the
  // confirmation email opens still has it.
  useEffect(() => {
    const attribution: Record<string, string> = {};
    for (const key of ATTRIBUTION_KEYS) {
      const value = search[key];
      if (value) attribution[key] = value;
    }
    keepAttribution(attribution);
  }, [search]);

  useEffect(() => {
    aidwar.auth.getSession().then(({ data }) => {
      if (data.session) void goNext();
    });
  }, [redirect]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    if (password.length < 8) {
      setError("Use at least 8 characters for your password.");
      return;
    }
    const phone = signupPhone(String(form.get("phone") ?? ""));
    if (!phone) {
      setError("Enter your WhatsApp number — 10 digits for India, or with the country code.");
      return;
    }
    setPending(true);
    setError(null);
    const { data, error: err } = await aidwar.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/login`,
        data: { phone },
      },
    });
    setPending(false);
    if (err) {
      setError(err.message);
      return;
    }
    if (data.session) {
      void goNext();
      return;
    }
    setSentTo(email);
  }

  async function google() {
    setError(null);
    const { error: err } = await aidwar.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/app/start` },
    });
    if (err) setError(err.message);
  }

  if (sentTo) {
    const gmail = /@(gmail|googlemail)\.com$/i.test(sentTo);
    return (
      <AuthShell
        title="Check your email"
        subtitle="One tap and you're in."
        footer={
          <Link to="/login" className="font-medium text-primary-strong hover:underline">
            Back to log in
          </Link>
        }
      >
        <div className="ob-pop text-center">
          <span className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-accent text-accent-foreground">
            <MailCheck className="h-8 w-8" aria-hidden="true" />
          </span>
          <p className="mt-5 text-sm text-muted-foreground">
            We sent a confirmation link to{" "}
            <span className="font-semibold text-foreground">{sentTo}</span>. Open it on this device
            and you'll land straight in your setup.
          </p>
          {gmail ? (
            <a
              href="https://mail.google.com/mail/u/0/#search/from%3Aaidwar"
              target="_blank"
              rel="noreferrer"
              className="mt-6 inline-flex h-12 w-full items-center justify-center rounded-full bg-primary-strong px-6 text-sm font-semibold text-primary-strong-foreground"
            >
              Open Gmail
            </a>
          ) : null}
          <button
            type="button"
            disabled={resent}
            onClick={async () => {
              const { error: err } = await aidwar.auth.resend({ type: "signup", email: sentTo });
              if (err) setError(err.message);
              else setResent(true);
            }}
            className="mt-4 text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:no-underline"
          >
            {resent ? "Sent again — check spam too" : "Didn't get it? Send again"}
          </button>
          {error ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Your AI employee on WhatsApp"
      subtitle="Create your account. Five minutes from now, Aiden is answering your customers."
      footer={
        <>
          Already have an account?{" "}
          <Link to="/login" className="font-medium text-primary-strong hover:underline">
            Log in
          </Link>
        </>
      }
    >
      {GOOGLE_SIGNIN ? (
        <>
          <button
            type="button"
            onClick={() => void google()}
            className="flex h-12 w-full items-center justify-center gap-3 rounded-full border border-border bg-background text-sm font-semibold transition-colors hover:bg-muted"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
              <path
                fill="#4285F4"
                d="M23.5 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.57-5.17 3.57-8.81z"
              />
              <path
                fill="#34A853"
                d="M12 24c3.24 0 5.95-1.07 7.93-2.9l-3.88-3c-1.07.72-2.45 1.15-4.05 1.15-3.12 0-5.76-2.1-6.7-4.94H1.3v3.1A12 12 0 0 0 12 24z"
              />
              <path
                fill="#FBBC05"
                d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6h-4a12 12 0 0 0 0 10.8l4-3.1z"
              />
              <path
                fill="#EA4335"
                d="M12 4.77c1.76 0 3.34.6 4.58 1.8l3.43-3.43A11.5 11.5 0 0 0 12 0 12 12 0 0 0 1.3 6.6l4 3.1C6.24 6.87 8.88 4.77 12 4.77z"
              />
            </svg>
            Continue with Google
          </button>
          <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            or with email
            <span className="h-px flex-1 bg-border" />
          </div>
        </>
      ) : null}
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor="email">Work email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@yourbusiness.in"
            className="h-12 rounded-xl text-base"
            autoFocus
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <div className="relative">
            <Input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              required
              autoComplete="new-password"
              placeholder="At least 8 characters"
              className="h-12 rounded-xl pr-12 text-base"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-2 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full text-muted-foreground hover:text-foreground"
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? (
                <EyeOff className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Eye className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="phone">Your WhatsApp number</Label>
          <Input
            id="phone"
            name="phone"
            type="tel"
            required
            autoComplete="tel"
            inputMode="tel"
            placeholder="98765 43210"
            className="h-12 rounded-xl text-base"
            aria-describedby="phone-hint"
          />
          <p id="phone-hint" className="text-xs text-muted-foreground">
            Aiden messages you here when a customer needs a person. It isn't the number customers
            will write to.
          </p>
        </div>
        {error ? (
          <p
            role="alert"
            className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}
        <PrimaryAction type="submit" className="!w-full" disabled={pending}>
          {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          Create my account
        </PrimaryAction>
        <p className="text-center text-xs text-muted-foreground">
          By continuing you agree to our{" "}
          <Link to="/terms" className="underline underline-offset-2 hover:text-foreground">
            terms
          </Link>{" "}
          and{" "}
          <Link to="/privacy" className="underline underline-offset-2 hover:text-foreground">
            privacy policy
          </Link>
          .
        </p>
      </form>
    </AuthShell>
  );
}
