import { useCallback, useEffect, useState } from "react";
import { Loader2, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/empty-state";
import { callApi } from "@/lib/whatsapp-client";
import { useOrg } from "@/lib/org-context";
import { MAX_CC, ccNumber, parseCcNumbers } from "@/lib/public-api-cc";

type CopiesState = { available: boolean; max: number; numbers: string[] };

const blanks = (numbers: string[]) => Array.from({ length: MAX_CC }, (_, i) => numbers[i] ?? "");

/**
 * Settings → API & webhooks (Batch 61): "Also send every API template message
 * to" — up to 3 of the shop's own numbers that get a copy of every template
 * the API sends (unless the request has its own `cc`). Reads and saves through
 * /api/developer/copies (public_api.manage: owner and admin; audit-logged).
 * Both designs show it: ApiSettingsTab renders it.
 */
export function ApiCopiesCard() {
  const { active } = useOrg();
  const orgId = active?.organization.id ?? null;
  const [state, setState] = useState<CopiesState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<string[]>(blanks([]));
  const [problem, setProblem] = useState<string | null>(null);
  const [badBox, setBadBox] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) return;
    const r = await callApi<CopiesState>(`/api/developer/copies?organization_id=${orgId}`, {
      method: "GET",
    });
    if (r.error || !r.data) {
      setError(r.error ?? "We couldn't load the copy numbers.");
      return;
    }
    setState(r.data);
    setValues(blanks(r.data.numbers));
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    // Name the box the person typed in, whatever boxes are empty around it.
    const bad = values.findIndex((v) => v.trim() !== "" && !ccNumber(v));
    if (bad >= 0) {
      setBadBox(bad);
      setProblem(
        `Number ${bad + 1} isn't a valid WhatsApp number. Include the country code, e.g. +919812345678.`,
      );
      return;
    }
    setBadBox(null);
    const entered = values.map((v) => v.trim()).filter(Boolean);
    const checked = parseCcNumbers(entered, {
      field: "The copy list",
      label: (i) => `Number ${i + 1}`,
    });
    if (!checked.ok) {
      setProblem(checked.error);
      return;
    }
    setProblem(null);
    setSaving(true);
    const r = await callApi<{ numbers: string[] }>("/api/developer/copies", {
      body: { organization_id: orgId, numbers: checked.numbers },
    });
    setSaving(false);
    if (r.error || !r.data) {
      toast.error(r.error ?? "We couldn't save the copy numbers.");
      return;
    }
    setValues(blanks(r.data.numbers));
    setState((s) => (s ? { ...s, numbers: r.data!.numbers } : s));
    toast.success(r.data.numbers.length ? "Copy numbers saved" : "Copies switched off");
  };

  if (error) return <ErrorState message={error} />;
  if (!state) return <Skeleton className="h-56 w-full rounded-2xl" />;

  return (
    <section
      className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm sm:p-8"
      aria-labelledby="api-copies-title"
    >
      <div className="flex items-start gap-3">
        <Users className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0">
          <h2 id="api-copies-title" className="text-base font-semibold text-foreground">
            Copies to your team
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Your staff get the same message as the customer — the same invoice PDF, text and buttons
            — once WhatsApp accepts the customer's message.
          </p>
        </div>
      </div>

      {!state.available ? (
        <p className="mt-5 rounded-xl border border-border/70 bg-muted/40 p-4 text-sm text-muted-foreground">
          Copies aren't set up on this server yet. Ask AiDwar support to switch them on.
        </p>
      ) : (
        <form onSubmit={save} className="mt-5 space-y-4" noValidate>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-foreground">
              Also send every API template message to
            </legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {values.map((value, i) => (
                <div key={i} className="space-y-1">
                  <Label htmlFor={`api-cc-${i}`} className="sr-only">
                    Copy number {i + 1}
                  </Label>
                  <Input
                    id={`api-cc-${i}`}
                    inputMode="tel"
                    autoComplete="off"
                    placeholder={i === 0 ? "+919812345678" : "Another number (optional)"}
                    value={value}
                    maxLength={20}
                    aria-invalid={badBox === i || undefined}
                    aria-describedby={badBox === i ? "api-cc-problem" : undefined}
                    onChange={(e) =>
                      setValues((all) => all.map((v, j) => (j === i ? e.target.value : v)))
                    }
                  />
                </div>
              ))}
            </div>
          </fieldset>
          {problem ? (
            <p id="api-cc-problem" className="text-sm text-destructive" role="alert">
              {problem}
            </p>
          ) : null}
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            <li>Up to {MAX_CC} numbers, each with its country code (+91…).</li>
            <li>
              Each copy is a separate WhatsApp message, charged by Meta at the template's category
              rate (utility, marketing or authentication) — like any other message.
            </li>
            <li>
              Used for every API template message unless the request sends its own{" "}
              <code className="font-mono">cc</code> (an empty <code className="font-mono">cc</code>{" "}
              means no copies). Leave all boxes empty to switch copies off.
            </li>
          </ul>
          <Button type="submit" className="rounded-full" disabled={saving}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save copy numbers
          </Button>
        </form>
      )}
    </section>
  );
}
