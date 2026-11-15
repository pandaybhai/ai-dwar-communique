import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useNavigate } from "@tanstack/react-router";
import { Check, ChevronDown, Eye, EyeOff, Lock, Mail, ShieldCheck, X } from "lucide-react";
import {
  EMPTY_VALUES,
  EXIT,
  EXIT_SEEN_KEY,
  FIELD_ORDER,
  ORDER,
  SAVED_KEY,
  SAVED_TTL_MS,
  allErrors,
  fieldError,
  hasTyped,
  passwordStrength,
  revealRest,
  savedSubset,
  type CheckoutField,
  type CheckoutValues,
} from "@/lib/page-999";
import {
  PAY_FAILED,
  PHASE_TEXT,
  runCheckout,
  type CheckoutDeps,
  type CheckoutOutcome,
  type GatewaySession,
  type Phase,
} from "@/lib/checkout-999-flow";
import { cn } from "@/lib/utils";

/**
 * Batch 80/81: the one-screen checkout, Shiprocket-style. A full-height sheet
 * on a phone (swipe down or ✕ to close), a right panel on desktop, over the
 * /999 page — no page change, no nav, no footer, no outbound links.
 *
 * Batch 81, fewest steps:
 *  - phone first: the WhatsApp number is the only field at first; on a valid
 *    number the name and email slide in;
 *  - no password: the account is made on the server and this browser is
 *    signed in; "Set a password" is offered after paying (or emailed);
 *  - an email or number that already has an account: "Welcome back" and a
 *    one-time log-in link by email — never a dead end;
 *  - the business name is asked after paying, on the success screen;
 *  - leaving with something typed shows one gentle "Your setup is saved"
 *    screen, once per session; the back button is never touched.
 * What was typed is kept for 2 hours in this browser (never a password —
 * there is none). runCheckout (checkout-999-flow.ts) does the work.
 */

type Stage =
  | { kind: "form" }
  | { kind: "working"; phase: Phase }
  | { kind: "failed"; message: string }
  | { kind: "existing"; sentTo: string | null }
  | { kind: "exit" }
  | { kind: "success"; firstName: string; organizationId: string | null };

const LABELS: Record<CheckoutField, string> = {
  phone: "WhatsApp number",
  name: "Your name",
  email: "Email",
};

function loadSaved(): CheckoutValues {
  try {
    const raw = window.localStorage.getItem(SAVED_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<CheckoutValues> & { at?: number }) : {};
    if (!v.at || Date.now() - v.at > SAVED_TTL_MS) return { ...EMPTY_VALUES };
    return {
      phone: typeof v.phone === "string" ? v.phone : "",
      name: typeof v.name === "string" ? v.name : "",
      email: typeof v.email === "string" ? v.email : "",
    };
  } catch {
    return { ...EMPTY_VALUES };
  }
}

/* --------------------------------------------------- real outside calls --- */

async function realDeps(): Promise<CheckoutDeps> {
  const [{ aidwar }, pixel] = await Promise.all([
    import("@/integrations/aidwar/client"),
    import("@/lib/meta-pixel"),
  ]);
  const post = async (path: string, body: Record<string, unknown>, token?: string) => {
    const res = await fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body: json };
  };
  return {
    saveLead: async (body) => {
      const r = await post("/api/public/checkout-999", body);
      return {
        ok: r.status === 200 && r.body["ok"] === true,
        error: typeof r.body["error"] === "string" ? (r.body["error"] as string) : undefined,
        field: typeof r.body["field"] === "string" ? (r.body["field"] as string) : undefined,
      };
    },
    session: async () => {
      const { data } = await aidwar.auth.getSession();
      const s = data.session;
      return s ? { userId: s.user.id, token: s.access_token } : null;
    },
    // Batch 81: the server makes the account (no password typed) or emails an
    // existing one a log-in link.
    account: async ({ phone, name, email }) => {
      const r = await post("/api/public/checkout-999", { phone, name, email, action: "account" });
      if (r.status === 200 && r.body["status"] === "created") {
        return {
          status: "created",
          token_hash: String(r.body["token_hash"]),
          user_id: String(r.body["user_id"]),
        };
      }
      if (r.status === 200 && r.body["status"] === "existing") {
        return {
          status: "existing",
          sent_to: typeof r.body["sent_to"] === "string" ? (r.body["sent_to"] as string) : null,
        };
      }
      return {
        status: "error",
        error:
          typeof r.body["error"] === "string"
            ? (r.body["error"] as string)
            : "We couldn't create your account. Please try again.",
        ...(typeof r.body["field"] === "string" ? { field: r.body["field"] as string } : {}),
      };
    },
    // The one-time token → this browser's own session (existing auth API).
    signInWithToken: async (tokenHash) => {
      const { data, error } = await aidwar.auth.verifyOtp({
        token_hash: tokenHash,
        type: "magiclink",
      });
      // Batch 71: the cookie banner waits until a sign-up has been sent.
      pixel.signupSubmitted();
      const s = data.session;
      return !error && s ? { userId: s.user.id, token: s.access_token } : null;
    },
    startPay: (token, body) =>
      post("/api/public/checkout-999", body, token) as ReturnType<CheckoutDeps["startPay"]>,
    // The onboarding's own create path (create_organization → begin → the
    // WhatsApp setup session); no website yet — Aiden asks on WhatsApp.
    createWorkspace: async (name) => {
      const [{ beginBusiness }, client, { callApi }, { logActivity }] = await Promise.all([
        import("@/lib/onboarding-begin"),
        import("@/lib/onboarding-client"),
        import("@/lib/whatsapp-client"),
        import("@/lib/activity"),
      ]);
      const begun = await beginBusiness(
        null,
        { name, url: null, about: null, brand: null, noWebsite: true },
        {
          createOrganization: async (orgName) => {
            const { data, error } = await aidwar.rpc("create_organization", { org_name: orgName });
            return { id: (data as string | null) ?? null, error };
          },
          onCreated: async (orgId, orgName) => {
            await logActivity("organization.created", orgId, { name: orgName });
          },
          journey: async (payload) => client.journeyApi<{ source_id?: string }>(payload),
          startSession: (body) =>
            callApi("/api/onboarding/start", {
              body: { ...body, attribution: client.takeAttribution() },
            }),
        },
      );
      return begun.ok ? { orgId: begun.orgId } : { error: begun.error };
    },
    openGateway: async (session: GatewaySession) => {
      try {
        const { load } = await import("@cashfreepayments/cashfree-js");
        const cf = await load({ mode: session.mode });
        if (!cf) return { error: "The payment window couldn't load. Please try again." };
        const result = await cf.checkout({
          paymentSessionId: session.payment_session_id,
          redirectTarget: "_modal",
        });
        return { error: result?.error?.message ?? null };
      } catch (e) {
        return { error: e instanceof Error ? e.message : "The payment window couldn't load." };
      }
    },
    confirm: async (paymentId) => {
      const { confirmCashfreeReturn } = await import("@/lib/cashfree-checkout");
      return confirmCashfreeReturn(paymentId);
    },
    onRegistered: (userId, phone) => pixel.trackRegistration(userId, phone, "landing_999"),
    onAddPaymentInfo: (meta) => {
      pixel.fireFromServer(meta);
    },
  };
}

/* ------------------------------------------------------------- pieces --- */

function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error: string | null;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[14px] font-semibold text-[#04100b]">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-err`} role="alert" className="mt-1.5 text-[13px] font-medium text-[#c2410c]">
          {error}
        </p>
      ) : hint ? (
        <div id={`${id}-hint`} className="mt-1.5 text-[12.5px] text-[#04100b]/55">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

const inputClass = (bad: boolean, ok: boolean) =>
  cn(
    "h-14 w-full rounded-2xl border bg-white px-4 text-[17px] text-[#04100b] outline-none transition-[border-color,box-shadow] placeholder:text-[#04100b]/35",
    "focus:border-[#10b981] focus:shadow-[0_0_0_4px_rgba(16,185,129,0.18)]",
    bad
      ? "border-[#ea580c] shadow-[0_0_0_4px_rgba(234,88,12,0.12)]"
      : ok
        ? "border-[#10b981]/60"
        : "border-[#04100b]/15",
  );

function Confetti() {
  const colors = ["#3ee6a0", "#fbbf24", "#60a5fa", "#f472b6", "#ffffff", "#10b981"];
  return (
    <div className="p9-confetti" aria-hidden="true">
      {Array.from({ length: 34 }, (_, i) => (
        <i
          key={i}
          style={{
            left: `${(i * 37) % 100}%`,
            background: colors[i % colors.length],
            ["--d" as string]: `${(i % 7) * 70}ms`,
            ["--x" as string]: `${((i * 53) % 120) - 60}px`,
            ["--r" as string]: `${360 + ((i * 97) % 540)}deg`,
          }}
        />
      ))}
    </div>
  );
}

/** Batch 81: paid — name the business, optionally set a password, then setup. */
function Success({
  firstName,
  organizationId,
  email,
}: {
  firstName: string;
  organizationId: string | null;
  email: string;
}) {
  const navigate = useNavigate();
  const uid = useId();
  const [business, setBusiness] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const strength = passwordStrength(password);

  async function finish() {
    setBusy(true);
    setNote(null);
    const { aidwar } = await import("@/integrations/aidwar/client");
    const name = business.trim().replace(/\s+/g, " ");
    if (organizationId && name.length >= 2) {
      // An owner may rename their own workspace (the org guard keeps every
      // billing column as it is).
      await aidwar.from("organizations").update({ name }).eq("id", organizationId);
    }
    if (password) {
      if (password.length < 8) {
        setBusy(false);
        setNote("Use at least 8 characters — or leave it empty and set one later.");
        return;
      }
      const { error } = await aidwar.auth.updateUser({ password });
      if (error) {
        setBusy(false);
        setNote("We couldn't save that password. You can set one later from the emailed link.");
        return;
      }
    }
    void navigate({ to: "/app/start", search: { step: "connect" } });
  }

  async function emailLink() {
    const { aidwar } = await import("@/integrations/aidwar/client");
    const { error } = await aidwar.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/set-password`,
    });
    setNote(error ? "We couldn't send it just now." : `Sent to ${email}. You can set it any time.`);
  }

  return (
    <div
      className="absolute inset-0 z-20 overflow-y-auto bg-[#04100b] px-6 pb-10 pt-12 text-white"
      data-testid="checkout-success"
    >
      <Confetti />
      <div className="relative mx-auto max-w-sm">
        <svg viewBox="0 0 96 96" className="mx-auto h-20 w-20" aria-hidden="true">
          <circle
            cx="48"
            cy="48"
            r="42"
            fill="none"
            stroke="#3ee6a0"
            strokeWidth="5"
            pathLength={1}
            className="p9-check-circle"
          />
          <path
            d="m30 49 12 12 25-26"
            fill="none"
            stroke="#3ee6a0"
            strokeWidth="6"
            strokeLinecap="round"
            strokeLinejoin="round"
            pathLength={1}
            className="p9-check-mark"
          />
        </svg>
        <h2 className="mt-5 text-center text-[1.9rem] font-extrabold leading-tight tracking-[-0.03em]">
          You're live-ready{firstName ? `, ${firstName}` : ""}!
        </h2>
        <p className="mt-1 text-center text-[15px] text-white/70">
          Payment confirmed. Two quick things, then we connect your WhatsApp.
        </p>

        <label htmlFor={`${uid}-biz`} className="mt-7 block text-[14px] font-semibold">
          What's your business called?
        </label>
        <input
          id={`${uid}-biz`}
          value={business}
          onChange={(e) => setBusiness(e.target.value)}
          autoComplete="organization"
          autoCapitalize="words"
          placeholder="As customers know it"
          className="mt-1.5 h-14 w-full rounded-2xl border border-white/15 bg-white/[0.06] px-4 text-[17px] text-white outline-none placeholder:text-white/35 focus:border-[#3ee6a0]"
        />

        <label htmlFor={`${uid}-pw`} className="mt-5 block text-[14px] font-semibold">
          Set a password <span className="font-normal text-white/55">(optional)</span>
        </label>
        <div className="relative mt-1.5">
          <input
            id={`${uid}-pw`}
            type={showPw ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            placeholder="For log-in with your email"
            className="h-14 w-full rounded-2xl border border-white/15 bg-white/[0.06] px-4 pr-14 text-[17px] text-white outline-none placeholder:text-white/35 focus:border-[#3ee6a0]"
          />
          <button
            type="button"
            onClick={() => setShowPw((s) => !s)}
            aria-label={showPw ? "Hide password" : "Show password"}
            className="absolute right-2 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-xl text-white/60"
          >
            {showPw ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
          </button>
        </div>
        {password ? <p className="mt-1.5 text-[12.5px] text-white/60">{strength.label}</p> : null}
        <button
          type="button"
          onClick={() => void emailLink()}
          className="mt-2 inline-flex min-h-11 items-center gap-1.5 text-[13.5px] font-semibold text-[#3ee6a0] underline-offset-2 hover:underline"
        >
          <Mail className="h-4 w-4" aria-hidden="true" /> Email me a link to set it later
        </button>
        {note ? (
          <p role="status" className="mt-2 text-[13px] text-white/75">
            {note}
          </p>
        ) : null}

        <button
          type="button"
          onClick={() => void finish()}
          disabled={busy}
          className="p9-cta mt-6 w-full text-[17px]"
          data-testid="success-continue"
        >
          {busy ? "Saving…" : "Continue to setup →"}
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- sheet --- */

export function Checkout999({
  open,
  onClose,
  returningPaymentId,
  adminTestPrice = null,
  resumed = false,
}: {
  open: boolean;
  /** `typed`: something was typed and not paid — the page's bar becomes "Finish setup". */
  onClose: (state: { typed: boolean; paid: boolean }) => void;
  /** Back from a payment page Cashfree redirected to: confirm this one. */
  returningPaymentId?: string | null;
  /** Batch 80b: an admin's ₹1 live test (the server refuses anyone else). */
  adminTestPrice?: 1 | null;
  /** Batch 81: back from the emailed log-in link (/999?resume=1). */
  resumed?: boolean;
}) {
  const uid = useId();
  const [values, setValues] = useState<CheckoutValues>(EMPTY_VALUES);
  const [loaded, setLoaded] = useState(false);
  const [touched, setTouched] = useState<Partial<Record<CheckoutField, boolean>>>({});
  const [serverError, setServerError] = useState<Partial<Record<CheckoutField, string>>>({});
  const [stage, setStage] = useState<Stage>({ kind: "form" });
  const [notice, setNotice] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [shake, setShake] = useState(0);
  const [honeypot, setHoneypot] = useState("");
  const panel = useRef<HTMLDivElement | null>(null);
  const deps = useRef<Promise<CheckoutDeps> | null>(null);
  const getDeps = () => (deps.current ??= realDeps());

  // What they typed before (this browser, 2 hours), once.
  useEffect(() => {
    setValues(loadSaved());
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try {
      window.localStorage.setItem(
        SAVED_KEY,
        JSON.stringify({ ...savedSubset(values), at: Date.now() }),
      );
    } catch {
      // private mode: kept in memory only
    }
  }, [values, loaded]);

  // Already signed in (an AiDwar account in this browser, or back from the link)?
  useEffect(() => {
    if (!open) return;
    void import("@/integrations/aidwar/client")
      .then(async ({ aidwar }) => {
        const { data } = await aidwar.auth.getSession();
        setSignedIn(data.session?.user.email ?? null);
      })
      .catch(() => setSignedIn(null));
  }, [open]);

  const paid = stage.kind === "success";
  const working = stage.kind === "working";

  /** ✕, Escape, the scrim or a swipe down: the save screen once, then close. */
  const requestClose = useCallback(() => {
    if (working) return;
    if (paid) return;
    let seen = false;
    try {
      seen = window.sessionStorage.getItem(EXIT_SEEN_KEY) === "1";
    } catch {
      seen = true;
    }
    if (hasTyped(values) && !seen && stage.kind !== "exit") {
      try {
        window.sessionStorage.setItem(EXIT_SEEN_KEY, "1");
      } catch {
        // shown once anyway (this mount)
      }
      setStage({ kind: "exit" });
      return;
    }
    if (stage.kind === "exit") setStage({ kind: "form" });
    onClose({ typed: hasTyped(values), paid: false });
  }, [working, paid, values, stage.kind, onClose]);

  // Focus, Escape and the page underneath while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const body = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const t = setTimeout(() => {
      const first = FIELD_ORDER.map((f) =>
        panel.current?.querySelector<HTMLInputElement>(`#${CSS.escape(`${uid}-${f}`)}`),
      ).find((el) => el && !el.value);
      (first ?? panel.current?.querySelector<HTMLElement>("button[data-close]"))?.focus({
        preventScroll: true,
      });
    }, 60);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
      if (e.key === "Tab" && panel.current) {
        const items = panel.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]):not([tabindex="-1"]), input:not([tabindex="-1"]), [href]',
        );
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.body.style.overflow = body;
      document.removeEventListener("keydown", onKey);
      prev?.focus?.({ preventScroll: true });
    };
  }, [open, requestClose, uid]);

  const done = useCallback((firstName: string, organizationId: string | null) => {
    setStage({ kind: "success", firstName, organizationId });
    try {
      window.localStorage.removeItem(SAVED_KEY);
    } catch {
      // nothing kept
    }
  }, []);

  // Back from Cashfree's own page (a redirect instead of the popup).
  useEffect(() => {
    if (!open || !returningPaymentId) return;
    let live = true;
    setStage({ kind: "working", phase: "confirming" });
    void (async () => {
      const d = await getDeps();
      let status = await d.confirm(returningPaymentId);
      for (let i = 0; i < 4 && status === "pending" && live; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        status = await d.confirm(returningPaymentId);
      }
      if (!live) return;
      if (status === "paid") done(values.name.split(" ")[0] ?? "", null);
      else setStage({ kind: "failed", message: PAY_FAILED });
    })();
    return () => {
      live = false;
    };
    // Once per returning payment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, returningPaymentId]);

  const errors = allErrors(values, { signedIn: Boolean(signedIn) });
  const shownError = (f: CheckoutField): string | null =>
    serverError[f] ?? (touched[f] ? (errors[f] ?? null) : null);
  const revealed = revealRest(values);

  const set = (f: CheckoutField) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v =
      f === "phone" ? e.target.value.replace(/[^\d+\s-]/g, "").slice(0, 16) : e.target.value;
    setValues((cur) => ({ ...cur, [f]: v }));
    setServerError((cur) => ({ ...cur, [f]: undefined }));
  };
  const blur = (f: CheckoutField) => () => {
    if (values[f].trim()) setTouched((t) => ({ ...t, [f]: true }));
  };

  async function pay() {
    if (working) return;
    setNotice(null);
    setTouched(Object.fromEntries(FIELD_ORDER.map((f) => [f, true])));
    const firstBad = FIELD_ORDER.find((f) =>
      fieldError(f, values, { signedIn: Boolean(signedIn) }),
    );
    if (firstBad) {
      setShake((n) => n + 1);
      panel.current
        ?.querySelector<HTMLInputElement>(`#${CSS.escape(`${uid}-${firstBad}`)}`)
        ?.focus();
      return;
    }
    setStage({ kind: "working", phase: "saving" });
    let outcome: CheckoutOutcome;
    try {
      outcome = await runCheckout({ ...values, honeypot }, await getDeps(), {
        report: (phase) => setStage({ kind: "working", phase }),
        signedIn: Boolean(signedIn),
        adminTestPrice,
      });
    } catch {
      outcome = { kind: "error", message: "Something went wrong. Please try again." };
    }
    switch (outcome.kind) {
      case "paid":
        done(outcome.firstName, outcome.organizationId);
        return;
      case "already":
        done(outcome.firstName, null);
        return;
      case "field":
        setStage({ kind: "form" });
        setServerError({ [outcome.field]: outcome.error });
        setShake((n) => n + 1);
        return;
      case "existing":
        setStage({ kind: "existing", sentTo: outcome.sentTo });
        return;
      case "failed":
        setStage({ kind: "failed", message: outcome.message });
        return;
      case "error":
        setStage({ kind: "form" });
        setNotice(outcome.message);
    }
  }

  const fields = FIELD_ORDER.filter((f) => f === "phone" || revealed).filter(
    (f) => !(signedIn && f === "email"),
  );

  const input = (f: CheckoutField) => {
    const id = `${uid}-${f}`;
    const err = shownError(f);
    const ok = Boolean(touched[f]) && !errors[f] && !serverError[f];
    const common = {
      id,
      name: f,
      value: values[f],
      onChange: set(f),
      onBlur: blur(f),
      disabled: working,
      "aria-invalid": err ? true : undefined,
      "aria-describedby": err ? `${id}-err` : f === "phone" ? `${id}-hint` : undefined,
      className: inputClass(Boolean(err), ok || (f === "phone" && revealed)),
    } as const;
    if (f === "phone") {
      return (
        <div className="relative">
          <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 rounded-lg bg-[#f1f5f2] px-2 py-1 text-[15px] font-bold text-[#04100b]">
            +91
          </span>
          <input
            {...common}
            type="tel"
            inputMode="numeric"
            autoComplete="tel-national"
            placeholder="98123 45670"
            className={cn(common.className, "pl-[4.5rem] tracking-wide")}
          />
          {revealed ? (
            <Check
              className="absolute right-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[#10b981]"
              aria-hidden="true"
            />
          ) : null}
        </div>
      );
    }
    return (
      <div className="relative">
        <input
          {...common}
          type={f === "email" ? "email" : "text"}
          inputMode={f === "email" ? "email" : "text"}
          autoComplete={f === "name" ? "name" : "email"}
          autoCapitalize={f === "email" ? "none" : "words"}
          spellCheck={false}
          placeholder={f === "name" ? "Asha Rao" : "you@business.com"}
        />
        {ok ? (
          <Check
            className="absolute right-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[#10b981]"
            aria-hidden="true"
          />
        ) : null}
      </div>
    );
  };

  const price = adminTestPrice === 1 ? 1 : 999;

  return (
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-[60]" data-testid="checkout-999">
          <motion.div
            key="scrim"
            className="absolute inset-0 bg-[#020806]/60 backdrop-blur-[3px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={requestClose}
            aria-hidden="true"
          />
          <motion.div
            key="panel"
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${uid}-title`}
            className="absolute inset-x-0 bottom-0 top-2 flex flex-col overflow-hidden rounded-t-[1.75rem] bg-[#f7f6f1] shadow-[0_-30px_80px_-20px_rgba(0,0,0,0.5)] sm:inset-y-0 sm:left-auto sm:right-0 sm:top-0 sm:w-[460px] sm:rounded-none sm:rounded-l-[1.75rem]"
            initial={{ y: "100%", x: 0 }}
            animate={{ y: 0, x: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 32, stiffness: 380, mass: 0.8 }}
            drag={working || paid ? false : "y"}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={(_e, info) => {
              if (info.offset.y > 120 || info.velocity.y > 700) requestClose();
            }}
          >
            {paid ? (
              <Success
                firstName={stage.firstName}
                organizationId={stage.organizationId}
                email={values.email}
              />
            ) : null}

            {/* header: no nav, only ✕ */}
            <div className="flex items-center gap-2 px-5 pb-2 pt-3 sm:pt-5">
              <span
                aria-hidden="true"
                className="absolute left-1/2 top-2 h-1.5 w-10 -translate-x-1/2 rounded-full bg-[#04100b]/15 sm:hidden"
              />
              <Lock className="mt-2 h-4 w-4 text-[#10b981]" aria-hidden="true" />
              <h2 id={`${uid}-title`} className="mt-2 text-[15px] font-bold text-[#04100b]">
                Secure checkout
              </h2>
              <button
                type="button"
                data-close
                onClick={requestClose}
                disabled={working}
                aria-label="Close checkout"
                className="ml-auto mt-1 grid h-11 w-11 place-items-center rounded-full text-[#04100b]/70 transition-colors hover:bg-[#04100b]/5 disabled:opacity-40"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {adminTestPrice === 1 ? (
              <p
                data-testid="admin-test-banner"
                className="mx-4 mb-2 rounded-xl bg-[#fef3c7] px-3 py-2 text-[13px] font-semibold text-[#92400e]"
              >
                Admin test · charges ₹1 on the live gateway (Super Admins only — anyone else is
                refused). Excluded from revenue; Meta gets it only as a Test Events call.
              </p>
            ) : null}

            {/* order summary, pinned */}
            <div className="mx-4 rounded-2xl bg-[#04100b] text-white">
              <button
                type="button"
                onClick={() => setSummaryOpen((o) => !o)}
                aria-expanded={summaryOpen}
                className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
              >
                <span className="grid h-10 w-10 flex-none place-items-center rounded-xl bg-[#3ee6a0] text-[13px] font-extrabold text-[#022c1b]">
                  Ai
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-bold">
                    {ORDER.title} · {ORDER.line}
                  </span>
                  <span className="block text-[13px] text-white/60">Total today ₹{price}</span>
                </span>
                <ChevronDown
                  className={cn(
                    "h-5 w-5 text-white/60 transition-transform",
                    summaryOpen && "rotate-180",
                  )}
                  aria-hidden="true"
                />
              </button>
              {summaryOpen ? (
                <ul className="space-y-1.5 border-t border-white/10 px-4 py-3 text-[13.5px] text-white/75">
                  {[
                    "1 WhatsApp number · 2 team members",
                    "Aiden replies 24×7 — 300 answers a month",
                    "Shared inbox, campaigns & templates",
                    "Messages: you pay Meta directly, zero markup",
                  ].map((t) => (
                    <li key={t} className="flex gap-2">
                      <Check
                        className="mt-0.5 h-4 w-4 flex-none text-[#3ee6a0]"
                        aria-hidden="true"
                      />
                      {t}
                    </li>
                  ))}
                  <li className="flex justify-between border-t border-white/10 pt-2 font-semibold text-white">
                    <span>Total today</span>
                    <span>₹{price}</span>
                  </li>
                </ul>
              ) : null}
            </div>

            {stage.kind === "exit" ? (
              /* Batch 81: one gentle save screen (once per session). */
              <div
                className="flex flex-1 flex-col items-center justify-center px-6 text-center"
                data-testid="exit-intent"
              >
                <span className="grid h-16 w-16 place-items-center rounded-full bg-[#e7f8f0] text-[#047857]">
                  <ShieldCheck className="h-8 w-8" aria-hidden="true" />
                </span>
                <h3 className="mt-5 text-[1.6rem] font-extrabold tracking-[-0.03em] text-[#04100b]">
                  {EXIT.title}
                </h3>
                <p className="mt-2 text-[16px] text-[#04100b]/70">{EXIT.body}</p>
                <button
                  type="button"
                  onClick={() => setStage({ kind: "form" })}
                  className="p9-cta mt-7 w-full max-w-xs text-[17px]"
                  data-testid="exit-continue"
                >
                  {EXIT.continue}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setStage({ kind: "form" });
                    onClose({ typed: true, paid: false });
                  }}
                  className="mt-3 min-h-11 px-4 text-[15px] font-semibold text-[#04100b]/60"
                  data-testid="exit-close"
                >
                  {EXIT.close}
                </button>
              </div>
            ) : stage.kind === "existing" ? (
              /* Batch 81: the email or number already has an account. */
              <div
                className="flex flex-1 flex-col items-center justify-center px-6 text-center"
                data-testid="welcome-back"
              >
                <span className="grid h-16 w-16 place-items-center rounded-full bg-[#e7f8f0] text-[#047857]">
                  <Mail className="h-8 w-8" aria-hidden="true" />
                </span>
                <h3 className="mt-5 text-[1.6rem] font-extrabold tracking-[-0.03em] text-[#04100b]">
                  Welcome back{values.name ? `, ${values.name.split(" ")[0]}` : ""}!
                </h3>
                <p className="mt-2 text-[16px] leading-relaxed text-[#04100b]/70">
                  {stage.sentTo
                    ? `You already have an AiDwar account. We've emailed a one-time log-in link to ${stage.sentTo} — open it on this phone and you'll land right back here to pay.`
                    : "You already have an AiDwar account. Log in with your email and password to continue."}
                </p>
                <p className="mt-2 text-[13.5px] text-[#04100b]/55">Your details are saved.</p>
                <button
                  type="button"
                  onClick={() => void pay()}
                  className="p9-cta mt-7 w-full max-w-xs text-[16px]"
                >
                  Resend the link
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setValues((v) => ({ ...v, email: "" }));
                    setStage({ kind: "form" });
                  }}
                  className="mt-3 min-h-11 px-4 text-[15px] font-semibold text-[#04100b]/60"
                >
                  Use a different email
                </button>
              </div>
            ) : (
              <form
                className="flex min-h-0 flex-1 flex-col"
                noValidate
                onSubmit={(e) => {
                  e.preventDefault();
                  void pay();
                }}
              >
                <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-4 [overscroll-behavior:contain]">
                  {resumed && signedIn ? (
                    <p className="mb-4 rounded-2xl bg-[#e7f8f0] px-4 py-3 text-[14px] font-medium text-[#065f46]">
                      Welcome back — you're signed in. Tap Pay to finish.
                    </p>
                  ) : signedIn ? (
                    <p className="mb-4 rounded-2xl bg-white px-4 py-3 text-[14px] text-[#04100b]/70">
                      Signed in as <span className="font-semibold text-[#04100b]">{signedIn}</span>
                    </p>
                  ) : null}

                  <div key={shake} className={cn("space-y-4", shake > 0 && "p9-shake")}>
                    <AnimatePresence initial={false}>
                      {fields.map((f) => (
                        <motion.div
                          key={f}
                          initial={f === "phone" ? false : { opacity: 0, y: 14, height: 0 }}
                          animate={{ opacity: 1, y: 0, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ type: "spring", damping: 28, stiffness: 320 }}
                        >
                          <Field
                            id={`${uid}-${f}`}
                            label={LABELS[f]}
                            error={shownError(f)}
                            hint={
                              f === "phone"
                                ? revealed
                                  ? "Your invoice and setup help come here."
                                  : "Start with your WhatsApp number — that's where Aiden works."
                                : f === "email"
                                  ? "For your invoice and log-in. No password needed now."
                                  : undefined
                            }
                          >
                            {input(f)}
                          </Field>
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  </div>
                  {/* A hidden field no person fills (bots do). */}
                  <div
                    aria-hidden="true"
                    className="absolute -left-[9999px] top-0 h-px w-px overflow-hidden"
                  >
                    <label>
                      Company website
                      <input
                        tabIndex={-1}
                        autoComplete="off"
                        name="company_website_confirm"
                        value={honeypot}
                        onChange={(e) => setHoneypot(e.target.value)}
                      />
                    </label>
                  </div>
                </div>

                {/* trust + pay, always in reach */}
                <div className="border-t border-[#04100b]/10 bg-white/80 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur">
                  {stage.kind === "failed" || notice ? (
                    <div
                      role="alert"
                      data-testid="checkout-alert"
                      className="mb-3 flex gap-2.5 rounded-2xl border border-[#fdba74] bg-[#fff7ed] px-3.5 py-3 text-[14px] font-medium leading-snug text-[#9a3412]"
                    >
                      <span
                        aria-hidden="true"
                        className="mt-0.5 grid h-5 w-5 flex-none place-items-center rounded-full bg-[#ea580c] text-[12px] font-extrabold text-white"
                      >
                        !
                      </span>
                      <span>
                        {stage.kind === "failed" ? stage.message : notice}
                        {stage.kind === "failed" ? (
                          <span className="mt-0.5 block text-[12.5px] font-normal text-[#9a3412]/80">
                            Your account is saved and nothing was charged. Everything you typed is
                            still here.
                          </span>
                        ) : null}
                      </span>
                    </div>
                  ) : null}
                  <div className="mb-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-[12px] font-medium text-[#04100b]/60">
                    <span className="inline-flex items-center gap-1">
                      <Lock className="h-3.5 w-3.5 text-[#10b981]" aria-hidden="true" /> Secured by
                      Cashfree
                    </span>
                    <span className="inline-flex gap-1" aria-label="UPI, cards and netbanking">
                      {["UPI", "Cards", "Netbanking"].map((m) => (
                        <span
                          key={m}
                          className="rounded-md border border-[#04100b]/12 bg-white px-1.5 py-0.5 text-[11px] font-bold text-[#04100b]/75"
                        >
                          {m}
                        </span>
                      ))}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <ShieldCheck className="h-3.5 w-3.5 text-[#10b981]" aria-hidden="true" />{" "}
                      7-day money-back
                    </span>
                    <span>Cancel anytime</span>
                  </div>
                  <button
                    type="submit"
                    disabled={working}
                    aria-busy={working || undefined}
                    className="p9-cta w-full text-[17px] disabled:cursor-progress disabled:opacity-90"
                    data-testid="pay-999"
                  >
                    {working ? (
                      <span className="inline-flex items-center gap-2.5">
                        <span
                          className="h-4 w-4 animate-spin rounded-full border-2 border-[#022c1b]/30 border-t-[#022c1b]"
                          aria-hidden="true"
                        />
                        {PHASE_TEXT[stage.phase]}
                      </span>
                    ) : !revealed ? (
                      "Continue →"
                    ) : stage.kind === "failed" ? (
                      `Try again · Pay ₹${price} →`
                    ) : adminTestPrice === 1 ? (
                      "Pay ₹1 → (admin test)"
                    ) : (
                      ORDER.pay
                    )}
                  </button>
                  <p className="mt-2 text-center text-[11.5px] leading-snug text-[#04100b]/50">
                    By paying you agree to AiDwar's Terms and Privacy Policy (aidwar.in/terms). Meta
                    bills your messages directly.
                  </p>
                  <p className="sr-only" aria-live="polite">
                    {working ? PHASE_TEXT[stage.phase] : ""}
                  </p>
                </div>
              </form>
            )}
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}

export default Checkout999;
