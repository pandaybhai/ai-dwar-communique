import { AlertTriangle, CheckCircle2, Globe2 } from "lucide-react";
import { addedCountryLine, skippedRowsLine, type ImportPlan } from "@/lib/contact-import";

/** How many skipped rows the preview lists before "and N more". */
export const SKIPPED_SHOWN = 5;

/**
 * Batch 66: the import preview's phone check, in both designs — how many
 * numbers get the workspace's default country code and which rows will be
 * skipped, and why. The plan is planImportRows' (the very rows the import
 * sends); nothing is saved here.
 */
export function ImportPhoneCheck({
  plan,
  code,
  error,
  loading,
  variant,
}: {
  plan: ImportPlan | null;
  code: string | null;
  error: string | null;
  loading: boolean;
  variant: "classic" | "new";
}) {
  const fresh = variant === "new";
  const box = fresh
    ? "flex flex-col gap-2 rounded-[18px] border border-line p-4 text-[0.9375rem]"
    : "space-y-2 rounded-xl border border-border/70 p-4 text-sm";
  const muted = fresh ? "m-0 text-sm text-muted-foreground" : "text-xs text-muted-foreground";

  if (loading)
    return (
      <div className={box} role="status" data-testid="import-phone-check">
        <p className={muted}>Checking phone numbers…</p>
      </div>
    );
  if (error || !code || !plan)
    return (
      <div
        className={`${box} ${fresh ? "bg-danger-soft text-danger-soft-foreground" : "border-destructive/40 text-destructive"}`}
        role="alert"
        data-testid="import-phone-check"
      >
        <p className="m-0 flex items-center gap-2 font-medium">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          {error ?? "We couldn't check the phone numbers."}
        </p>
      </div>
    );

  const skipped = plan.errors;
  const ready = plan.rows.length;
  return (
    <div className={box} data-testid="import-phone-check">
      <p className={`m-0 flex items-center gap-2 font-medium text-foreground`}>
        <CheckCircle2
          className={`h-4 w-4 shrink-0 ${fresh ? "text-aiden-deep" : "text-primary"}`}
          aria-hidden
        />
        {ready.toLocaleString()} {ready === 1 ? "number is" : "numbers are"} ready to import
      </p>
      {plan.addedCountry > 0 ? (
        <p className="m-0 flex items-start gap-2 text-foreground">
          <Globe2
            className={`mt-[0.2em] h-4 w-4 shrink-0 ${fresh ? "text-aiden-deep" : "text-primary"}`}
            aria-hidden
          />
          <span>
            <strong className="font-semibold">{addedCountryLine(plan.addedCountry, code)}</strong>{" "}
            <span className="text-muted-foreground">
              (10-digit numbers get your default country code, set in Settings &gt; Workspace)
            </span>
          </span>
        </p>
      ) : null}
      {skipped.length ? (
        <div className="flex flex-col gap-1">
          <p
            className={`m-0 flex items-center gap-2 font-medium ${fresh ? "text-danger-soft-foreground" : "text-destructive"}`}
          >
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
            {skippedRowsLine(skipped.length)}
          </p>
          <ul
            className="m-0 flex list-none flex-col gap-1 p-0"
            aria-label="Rows that will be skipped"
          >
            {skipped.slice(0, SKIPPED_SHOWN).map((e) => (
              <li
                key={`${e.row}-${e.phone}`}
                className={`flex flex-wrap gap-x-2 ${fresh ? "text-sm" : "text-xs"}`}
              >
                <span className="font-medium text-foreground">Row {e.row}</span>
                <span className="font-mono text-foreground">{e.phone || "(empty)"}</span>
                <span className="text-muted-foreground">{e.reason}</span>
              </li>
            ))}
          </ul>
          {skipped.length > SKIPPED_SHOWN ? (
            <p className={muted}>
              and {(skipped.length - SKIPPED_SHOWN).toLocaleString()} more. The full list is in the
              error report after the import.
            </p>
          ) : null}
        </div>
      ) : null}
      <p className={muted}>Nothing is saved without a country code.</p>
    </div>
  );
}
