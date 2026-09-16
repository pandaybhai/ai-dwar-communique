import { useEffect, useId, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { readAttribution, trackMarketing } from "@/lib/marketing-analytics";
import {
  BUSINESS_TYPES,
  CONSENT_VERSION,
  ENQUIRY_BANDS,
  PRIMARY_NEEDS,
} from "@/lib/leads";

type Values = {
  business_type: string;
  enquiry_band: string;
  primary_need: string;
  name: string;
  business_name: string;
  phone: string;
  website: string;
  consent: boolean;
};

type FieldErrors = Partial<Record<"name" | "business_name" | "phone" | "consent", string>>;

const COUNTRY_CODES = [
  { value: "+91", label: "India +91" },
  { value: "+1", label: "US / Canada +1" },
  { value: "+44", label: "UK +44" },
  { value: "+61", label: "Australia +61" },
  { value: "+65", label: "Singapore +65" },
  { value: "+971", label: "UAE +971" },
  { value: "manual", label: "Other country code" },
] as const;

const EMPTY: Values = {
  business_type: "",
  enquiry_band: "",
  primary_need: "",
  name: "",
  business_name: "",
  phone: "",
  website: "",
  consent: false,
};

export function DemoForm({
  presetBusinessType,
  presetPrimaryNeed,
  focused = false,
  attached = false,
  onFocusChange,
  onComplete,
}: {
  presetBusinessType?: string;
  presetPrimaryNeed?: string;
  focused?: boolean;
  attached?: boolean;
  onFocusChange?: (focused: boolean) => void;
  onComplete?: () => void;
}) {
  const [values, setValues] = useState<Values>(EMPTY);
  const [countryCode, setCountryCode] = useState("+91");
  const [manualCode, setManualCode] = useState("");
  const [step, setStep] = useState<1 | 2>(1);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const started = useRef(false);
  const headingRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorId = useId();

  // The example a visitor picked upstream pre-fills step 1 — nobody repeats it.
  useEffect(() => {
    if (presetBusinessType) {
      setValues((v) => ({ ...v, business_type: presetBusinessType }));
    }
  }, [presetBusinessType]);

  useEffect(() => {
    if (presetPrimaryNeed) {
      setValues((v) => ({ ...v, primary_need: presetPrimaryNeed }));
    }
  }, [presetPrimaryNeed]);

  function set<K extends keyof Values>(key: K, value: Values[K]) {
    if (!started.current) {
      started.current = true;
      trackMarketing("demo_form_started");
    }
    setValues((v) => ({ ...v, [key]: value }));
    if (key in fieldErrors) {
      setFieldErrors((current) => {
        const next = { ...current };
        delete next[key as keyof FieldErrors];
        return next;
      });
    }
  }

  function clearPhoneError() {
    setFieldErrors((current) => {
      const next = { ...current };
      delete next.phone;
      return next;
    });
  }

  function goStep2() {
    if (!values.business_type || !values.enquiry_band || !values.primary_need) {
      setError("Please answer all three questions so the demo is relevant.");
      return;
    }
    setError(null);
    setStep(2);
    trackMarketing("demo_step_completed", {
      step: "1",
      business_type: values.business_type,
      enquiry_band: values.enquiry_band,
      primary_need: values.primary_need,
    });
    requestAnimationFrame(() => headingRef.current?.focus());
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (sending) return;
    const code = countryCode === "manual" ? manualCode.trim() : countryCode;
    const nationalDigits = values.phone.replace(/\D/g, "");
    const codeDigits = code.replace(/\D/g, "");
    const nextErrors: FieldErrors = {};
    if (values.name.trim().length < 2) nextErrors.name = "Please enter your name.";
    if (values.business_name.trim().length < 2) {
      nextErrors.business_name = "Please enter your business name.";
    }
    if (
      !/^\+[1-9]\d{0,3}$/.test(code) ||
      values.phone.trim().startsWith("+") ||
      codeDigits.length + nationalDigits.length < 10 ||
      codeDigits.length + nationalDigits.length > 15
    ) {
      nextErrors.phone = "Choose a valid country code and enter the number without the country code.";
    }
    if (!values.consent) {
      nextErrors.consent = "Please tick the box so we may contact you about this demo.";
    }
    if (Object.keys(nextErrors).length) {
      setFieldErrors(nextErrors);
      setError("Please check the highlighted details below.");
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }
    setSending(true);
    setError(null);

    let res: Response;
    try {
      res = await fetch("/api/public/demo-leads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...values,
          phone: `${code}${nationalDigits}`,
          consent_version: CONSENT_VERSION,
          landing_path: window.location.pathname,
          attribution: readAttribution(),
          company_website_confirm: "",
        }),
      });
    } catch {
      setSending(false);
      setError("We couldn't reach us just now. Your answers are safe — please try again.");
      return;
    }

    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setSending(false);
    if (!res.ok) {
      setError(body.error ?? "We couldn't save that just now. Please try again.");
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }
    // Success only after the enquiry is durably saved.
    setDone(true);
    onComplete?.();
    trackMarketing("demo_lead_submitted", {
      business_type: values.business_type,
      enquiry_band: values.enquiry_band,
      primary_need: values.primary_need,
    });
  }

  if (done) {
    return (
      <div
        role="status"
        className="rounded-3xl border border-primary/25 bg-primary/5 p-8 text-center sm:p-10"
      >
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Check className="size-6" />
        </div>
        <h3 className="mt-5 text-xl font-bold">We have your request</h3>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
          It is saved with our team. Someone from AiDwar will contact you on WhatsApp to arrange a
          demo built around your business.
        </p>
        {!focused ? (
          <p className="mt-4 text-sm text-muted-foreground">
            Want to look around first?{" "}
            <Link
              to="/signup"
              className="font-medium text-primary underline underline-offset-4"
              onClick={() => trackMarketing("signup_link_clicked", { placement: "after_submit" })}
            >
              Start free
            </Link>
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      onFocusCapture={() => {
        if (blurTimer.current) clearTimeout(blurTimer.current);
        onFocusChange?.(true);
      }}
      onBlurCapture={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        blurTimer.current = setTimeout(() => onFocusChange?.(false), 0);
      }}
      noValidate
      className={cn(
        "border border-border bg-card p-5 shadow-[var(--shadow-card)] sm:p-8",
        attached ? "rounded-b-2xl rounded-t-none" : "rounded-2xl",
      )}
    >
      {/* Honeypot: kept out of the accessibility tree and out of the tab order,
          so neither screen readers nor keyboard users ever reach it. */}
      <div aria-hidden="true" hidden className="hidden">
        <label htmlFor="company_website_confirm">Leave this empty</label>
        <input
          id="company_website_confirm"
          name="company_website_confirm"
          type="text"
          aria-hidden="true"
          tabIndex={-1}
          autoComplete="off"
        />
      </div>

      <div className="flex items-center gap-3">
        <p
          ref={headingRef}
          tabIndex={-1}
          className="text-xs font-semibold uppercase tracking-wide text-primary outline-none"
        >
          Step {step} of 2
        </p>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full bg-gradient-to-r from-primary to-teal-500 transition-all duration-300 motion-reduce:transition-none",
              step === 1 ? "w-1/2" : "w-full",
            )}
          />
        </div>
      </div>

      {step === 1 ? (
        <div className="mt-6 grid gap-6">
          <Choice
            legend="What kind of business do you run?"
            name="business_type"
            options={BUSINESS_TYPES}
            value={values.business_type}
            onChange={(v) => set("business_type", v)}
          />
          <Choice
            legend="How many WhatsApp enquiries do you get?"
            name="enquiry_band"
            options={ENQUIRY_BANDS}
            value={values.enquiry_band}
            onChange={(v) => set("enquiry_band", v)}
          />
          <Choice
            legend="What do you most want help with?"
            name="primary_need"
            options={PRIMARY_NEEDS}
            value={values.primary_need}
            onChange={(v) => set("primary_need", v)}
          />

          {error ? (
            <div ref={errorRef} tabIndex={-1} role="alert" className="text-sm text-destructive outline-none">
              {error}
            </div>
          ) : null}

          <Button
            type="button"
            size="lg"
            onClick={goStep2}
            className="rounded-full bg-gradient-to-r from-primary to-teal-500 transition-transform duration-200 hover:scale-[1.01] active:scale-[0.99] motion-reduce:transform-none"
          >
            Continue <ArrowRight className="size-4" />
          </Button>
        </div>
      ) : (
        <div className="mt-6 grid gap-5">
          <Field
            id="lead-name"
            label="Your name"
            value={values.name}
            onChange={(v) => set("name", v)}
            autoComplete="name"
            required
            error={fieldErrors.name}
          />
          <Field
            id="lead-business"
            label="Business name"
            value={values.business_name}
            onChange={(v) => set("business_name", v)}
            autoComplete="organization"
            required
            error={fieldErrors.business_name}
          />
          <div className="grid gap-1.5">
            <Label htmlFor="lead-phone">WhatsApp number</Label>
            <div className="grid grid-cols-[minmax(7.5rem,0.8fr)_minmax(0,1.2fr)] gap-2">
              <Select value={countryCode} onValueChange={(value) => {
                setCountryCode(value);
                clearPhoneError();
              }}>
                <SelectTrigger aria-label="Country code" className="h-12 min-w-0 rounded-xl text-base">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COUNTRY_CODES.map((country) => (
                    <SelectItem key={country.value} value={country.value} className="min-h-11 text-base">
                      {country.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                id="lead-phone"
                value={values.phone}
                onChange={(e) => set("phone", e.target.value)}
                placeholder="98765 43210"
                inputMode="tel"
                autoComplete="tel-national"
                aria-invalid={!!fieldErrors.phone}
                aria-describedby={fieldErrors.phone ? `${errorId}-phone` : undefined}
                className="h-12 min-w-0 rounded-xl text-base"
                required
              />
            </div>
            {countryCode === "manual" ? (
              <Input
                aria-label="Other country code"
                value={manualCode}
                onChange={(e) => {
                  setManualCode(e.target.value);
                  clearPhoneError();
                }}
                placeholder="Country code, e.g. +81"
                inputMode="tel"
                className="h-12 rounded-xl text-base"
              />
            ) : null}
            {fieldErrors.phone ? <p id={`${errorId}-phone`} className="text-sm text-destructive">{fieldErrors.phone}</p> : null}
          </div>
          <Field
            id="lead-website"
            label="Website or social page (optional)"
            value={values.website}
            onChange={(v) => set("website", v)}
            placeholder="yourstore.com"
            autoComplete="url"
          />

           <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-border p-4 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--primary)]"
              checked={values.consent}
              onChange={(e) => set("consent", e.target.checked)}
              required
            />
            <span className="text-muted-foreground">
              You may contact me on WhatsApp or phone about this demo request.{" "}
              <Link to="/privacy" className="text-primary underline underline-offset-4">
                Privacy policy
              </Link>
            </span>
          </label>
           {fieldErrors.consent ? <p className="text-sm text-destructive">{fieldErrors.consent}</p> : null}

          {error ? (
            <div ref={errorRef} tabIndex={-1} role="alert" className="text-sm text-destructive outline-none">
              {error}
            </div>
          ) : null}

          <div className="flex flex-col gap-3 sm:flex-row-reverse">
            <Button
              type="submit"
              size="lg"
              disabled={sending}
              className="flex-1 rounded-full bg-gradient-to-r from-primary to-teal-500 transition-transform duration-200 hover:scale-[1.01] active:scale-[0.99] motion-reduce:transform-none"
            >
              {sending ? <Loader2 className="size-4 animate-spin" /> : null}
              {sending ? "Sending…" : "Request my demo"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="rounded-full sm:w-auto"
              onClick={() => {
                setStep(1);
                setError(null);
              }}
            >
              <ArrowLeft className="size-4" /> Back
            </Button>
          </div>

           <p className="text-center text-xs text-muted-foreground">
             No account needed.
             {!focused ? (
               <>
                 {" "}Prefer to explore alone?{" "}
                 <Link
                   to="/signup"
                   className="text-primary underline underline-offset-4"
                   onClick={() => trackMarketing("signup_link_clicked", { placement: "form_footer" })}
                 >
                   Start free
                 </Link>
               </>
             ) : null}
           </p>
        </div>
      )}
    </form>
  );
}

function Choice({
  legend,
  name,
  options,
  value,
  onChange,
}: {
  legend: string;
  name: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <fieldset>
      <legend className="text-sm font-semibold text-foreground">{legend}</legend>
      <div className="mt-3 grid grid-cols-1 gap-2 min-[430px]:grid-cols-2">
        {options.map((o) => (
          <label
            key={o.value}
            className={cn(
              "flex min-h-11 cursor-pointer items-center rounded-xl border px-3 py-2 text-sm transition-colors duration-200 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary has-[:focus-visible]:ring-offset-2",
              value === o.value
                ? "border-primary bg-primary/10 font-medium text-primary"
                : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
            )}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              className="sr-only"
            />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  error,
  ...rest
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "id">) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        className="h-12 rounded-xl text-base"
        {...rest}
      />
      {error ? <p id={`${id}-error`} className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
