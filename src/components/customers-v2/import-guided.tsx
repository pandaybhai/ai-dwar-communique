import { useMemo, useRef, useState, type CSSProperties } from "react";
import { Check, CheckCircle2, Download, FileSpreadsheet } from "lucide-react";
import { toast } from "sonner";
import { downloadCsv } from "@/lib/csv";
import {
  FORMAT_TIPS,
  MAX_ROWS,
  SAMPLE_CSV,
  attrKey,
  errorReportCsv,
  phoneColumnOf,
  readImportCsv,
  runContactImport,
  type Mapping,
  type Results,
} from "@/lib/contact-import";
import {
  IMPORT_CONSENT_HELPER,
  IMPORT_CONSENT_LABEL,
  stayedOptedOutLine,
} from "@/components/contacts/import-contacts-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { NumberTicker } from "@/components/design-v2";
import { IMPORT_STEPS, IMPORT_STEP_HINTS, guidedStep } from "./customers-v2";
import { importCopy as t } from "./copy";

const FIELD_NAMES: Record<string, string> = t.field;

/**
 * Batch 48: the import as three guided steps (upload, match columns with a
 * preview, confirm with the consent box). The work is the classic import's
 * own (src/lib/contact-import.ts, the same /api/contacts/import calls); only
 * the steps are drawn differently.
 */
export function GuidedImportDialog({
  organizationId,
  onImported,
  label = t.trigger,
}: {
  organizationId: string;
  onImported: () => void;
  /** Batch 57: the button's words (the page head and the empty list both open it). */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  // The classic steps: 1 upload, 2 map, 3 consent, 4 importing, 5 done.
  const [step, setStep] = useState(1);
  const [filename, setFilename] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Mapping>({});
  // Batch 36: ticked by default — the merchant unticks when unsure.
  const [consent, setConsent] = useState(true);
  const [startFlows, setStartFlows] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Results | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const phoneColumn = useMemo(() => phoneColumnOf(mapping), [mapping]);
  const shown = guidedStep(step);

  function reset() {
    setStep(1);
    setFilename("");
    setHeaders([]);
    setRows([]);
    setMapping({});
    setConsent(true);
    setStartFlows(false);
    setProgress(0);
    setResults(null);
    setRunning(false);
  }

  async function handleFile(file: File) {
    const parsed = readImportCsv(await file.text());
    if (!parsed) {
      toast.error(t.noRows);
      return;
    }
    setFilename(file.name);
    setHeaders(parsed.headers);
    setRows(parsed.rows);
    setMapping(parsed.mapping);
    setStep(2);
    if (parsed.truncated) {
      toast.warning(t.tooMany(MAX_ROWS));
    }
  }

  async function runImport() {
    if (!phoneColumn) return;
    setRunning(true);
    setStep(4);
    setProgress(0);
    const run = await runContactImport({
      organizationId,
      filename,
      rows,
      mapping,
      consent,
      startFlows,
      onProgress: setProgress,
    });
    if ("startError" in run) {
      setRunning(false);
      toast.error(run.startError);
      setStep(3);
      return;
    }
    setResults(run.results);
    setRunning(false);
    setProgress(100);
    setStep(5);
    onImported();
  }

  const columnName = (i: string) => headers[Number(i)] || t.column(Number(i));
  const used = (field: string) =>
    Object.entries(mapping)
      .filter(([, v]) => v === field)
      .map(([i]) => columnName(i));
  const attrCount = Object.values(mapping).filter((v) => v.startsWith("attr:")).length;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (running) return;
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" className="phone:h-11">
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl font-extrabold">{t.title}</DialogTitle>
          <DialogDescription>{t.step(shown, IMPORT_STEP_HINTS[shown - 1]!)}</DialogDescription>
        </DialogHeader>

        <ol className="m-0 grid list-none grid-cols-3 gap-2 p-0" aria-label={t.stepsLabel}>
          {IMPORT_STEPS.map((label, i) => {
            const n = i + 1;
            const done = n < shown || step === 5;
            const on = n === shown && step !== 5;
            return (
              <li
                key={label}
                aria-current={on ? "step" : undefined}
                className={cn(
                  "flex min-w-0 items-center gap-2 rounded-full px-2.5 py-1.5 text-sm font-semibold transition-colors duration-300",
                  on
                    ? "bg-aiden-soft text-aiden-deep"
                    : done
                      ? "text-foreground"
                      : "text-muted-foreground",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold",
                    done
                      ? "bg-ink text-ink-foreground"
                      : on
                        ? "bg-surface text-aiden-deep"
                        : "bg-bubble-in",
                  )}
                >
                  {done ? (
                    <Check className="h-3.5 w-3.5 animate-in zoom-in-50 duration-300 ease-out motion-reduce:animate-none" />
                  ) : (
                    n
                  )}
                </span>
                <span className="truncate">{label}</span>
              </li>
            );
          })}
        </ol>

        {step === 1 ? (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files?.[0];
              if (file) void handleFile(file);
            }}
            className={cn(
              "nd-rise rounded-[20px] border-2 border-dashed p-8 text-center transition-colors duration-200 phone:p-5",
              dragging ? "border-aiden bg-aiden-soft" : "border-line bg-ground",
            )}
          >
            <FileSpreadsheet className="mx-auto h-10 w-10 text-aiden-deep" aria-hidden="true" />
            <p className="mt-4 font-semibold text-foreground">{t.drop}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t.limits(MAX_ROWS)}</p>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              aria-label={t.fileLabel}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
              }}
            />
            <Button className="mt-5 phone:h-11" onClick={() => inputRef.current?.click()}>
              {t.choose}
            </Button>
            <div className="mt-6 border-t border-line pt-5 text-left">
              <Button
                variant="link"
                className="h-auto p-0 font-semibold text-aiden-deep phone:min-h-11"
                onClick={() => downloadCsv("sample_contacts.csv", SAMPLE_CSV)}
              >
                <Download className="mr-1.5 h-4 w-4" aria-hidden="true" />
                {t.sample}
              </Button>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                {FORMAT_TIPS.map((tip) => (
                  <li key={tip}>{tip}</li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="nd-rise flex flex-col gap-4">
            <p className="m-0 text-sm text-muted-foreground">
              {t.rowsIntro(filename, rows.length)}
            </p>
            <div className="flex flex-col divide-y divide-line rounded-[18px] border border-line">
              {headers.map((h, i) => {
                const key = attrKey(h, i);
                const value = mapping[String(i)] ?? "ignore";
                const sample = rows.find((r) => (r[i] ?? "").trim())?.[i]?.trim();
                return (
                  <div
                    key={i}
                    className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center"
                  >
                    <div className="min-w-0 sm:w-56">
                      <p className="m-0 truncate font-semibold text-foreground">
                        {h || t.column(i)}
                      </p>
                      <p className="m-0 truncate text-sm text-muted-foreground">
                        {sample ? t.example(sample) : t.emptyColumn}
                      </p>
                    </div>
                    <div className="flex flex-1 flex-col gap-1">
                      <Select
                        value={value}
                        onValueChange={(v) => setMapping((prev) => ({ ...prev, [String(i)]: v }))}
                      >
                        <SelectTrigger
                          className="sm:max-w-xs phone:h-11"
                          aria-label={t.holds(h || t.column(i))}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={`attr:${key}`}>{t.option.attr}</SelectItem>
                          <SelectItem value="phone">{t.option.phone}</SelectItem>
                          <SelectItem value="name">{t.option.name}</SelectItem>
                          <SelectItem value="tags">{t.option.tags}</SelectItem>
                          <SelectItem value="ignore">{t.option.ignore}</SelectItem>
                        </SelectContent>
                      </Select>
                      {value.startsWith("attr:") ? (
                        <p className="m-0 text-sm text-aiden-deep">{t.savedAs(key)}</p>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="overflow-x-auto rounded-[18px] border border-line">
              <table className="w-full border-collapse text-sm">
                <caption className="sr-only">{t.previewCaption}</caption>
                <thead>
                  <tr>
                    {headers.map((h, i) => (
                      <th
                        key={i}
                        scope="col"
                        className="border-b border-line px-3 py-2 text-left font-semibold text-muted-foreground"
                      >
                        {h || t.column(i)}
                        <span className="block text-xs font-medium text-aiden-deep">
                          {(() => {
                            const v = mapping[String(i)] ?? "ignore";
                            return v === "ignore" ? t.leftOut : (FIELD_NAMES[v] ?? t.extra);
                          })()}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 5).map((r, ri) => (
                    <tr key={ri} className="border-b border-line last:border-b-0">
                      {headers.map((_, ci) => (
                        <td key={ci} className="max-w-[160px] truncate px-3 py-2">
                          {r[ci] ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {!phoneColumn ? (
              <p className="m-0 text-sm text-danger-soft-foreground" role="status">
                {t.needPhone}
              </p>
            ) : null}
            <div className="flex justify-between gap-2">
              <Button variant="ghost" className="phone:h-11" onClick={() => setStep(1)}>
                {t.back}
              </Button>
              <Button className="phone:h-11" disabled={!phoneColumn} onClick={() => setStep(3)}>
                {t.next}
              </Button>
            </div>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="nd-rise flex flex-col gap-4">
            <dl className="m-0 grid gap-1 rounded-[18px] bg-ground p-4 text-[0.9375rem]">
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t.summary.file}</dt>
                <dd className="m-0 truncate">{filename}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t.summary.rows}</dt>
                <dd className="tabular m-0">{rows.length.toLocaleString()}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t.summary.phoneFrom}</dt>
                <dd className="m-0 truncate">{used("phone").join(", ")}</dd>
              </div>
              {used("name").length ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{t.summary.nameFrom}</dt>
                  <dd className="m-0 truncate">{used("name").join(", ")}</dd>
                </div>
              ) : null}
              {used("tags").length ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{t.summary.tagsFrom}</dt>
                  <dd className="m-0 truncate">{used("tags").join(", ")}</dd>
                </div>
              ) : null}
              {attrCount ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{t.summary.extras}</dt>
                  <dd className="tabular m-0">{attrCount}</dd>
                </div>
              ) : null}
            </dl>

            <div className="rounded-[18px] border border-line p-4">
              <div className="flex items-start gap-3">
                <Checkbox
                  id="nd-import-consent"
                  checked={consent}
                  onCheckedChange={(v) => setConsent(v === true)}
                  className="mt-0.5"
                />
                <div className="flex flex-col gap-1">
                  <Label htmlFor="nd-import-consent" className="text-[0.9375rem] leading-relaxed">
                    {IMPORT_CONSENT_LABEL}
                  </Label>
                  <p className="m-0 text-sm text-muted-foreground">{IMPORT_CONSENT_HELPER}</p>
                </div>
              </div>
              <p className="m-0 mt-3 text-sm text-muted-foreground">
                {consent ? t.consentOn : t.consentOff}
              </p>
              <div className="mt-4 flex items-start gap-3">
                <Checkbox
                  id="nd-import-flows"
                  checked={startFlows}
                  onCheckedChange={(v) => setStartFlows(v === true)}
                  className="mt-0.5"
                />
                <Label htmlFor="nd-import-flows" className="text-[0.9375rem] leading-relaxed">
                  {t.startFlows}
                </Label>
              </div>
            </div>
            <div className="flex justify-between gap-2">
              <Button variant="ghost" className="phone:h-11" onClick={() => setStep(2)}>
                {t.back}
              </Button>
              <Button className="phone:h-11" onClick={() => void runImport()}>
                {t.start(rows.length)}
              </Button>
            </div>
          </div>
        ) : null}

        {step === 4 ? (
          <div className="flex flex-col gap-3 py-6 text-center" role="status">
            <p className="m-0 font-semibold text-foreground">{t.running}</p>
            <Progress value={progress} aria-label={t.progressLabel} />
            <p className="m-0 text-sm text-muted-foreground">{t.percent(progress)}</p>
          </div>
        ) : null}

        {step === 5 && results ? (
          <div className="flex flex-col gap-4">
            <div className="nd-rise flex items-center gap-3 rounded-[18px] bg-aiden-soft p-4 text-aiden-deep">
              <CheckCircle2 className="h-6 w-6" aria-hidden="true" />
              <p className="m-0 font-semibold">{t.done}</p>
            </div>
            <dl className="m-0 grid grid-cols-3 gap-3">
              {[
                { label: t.results.created, value: results.created },
                { label: t.results.updated, value: results.updated },
                { label: t.results.skipped, value: results.skipped },
              ].map((s, i) => (
                <div
                  key={s.label}
                  className="nd-rise rounded-[18px] border border-line p-4 text-center phone:p-3"
                  style={{ "--d": i + 1 } as CSSProperties}
                >
                  <dd className="tabular m-0 font-display text-2xl font-semibold">
                    <NumberTicker value={s.value} />
                  </dd>
                  <dt className="mt-1 text-sm text-muted-foreground">{s.label}</dt>
                </div>
              ))}
            </dl>
            {results.stayedOptedOut > 0 ? (
              <p className="m-0 text-sm text-muted-foreground">
                {stayedOptedOutLine(results.stayedOptedOut)}
              </p>
            ) : null}
            {results.errors.length ? (
              <Button
                variant="outline"
                className="phone:h-11"
                onClick={() =>
                  downloadCsv(`import-errors-${Date.now()}.csv`, errorReportCsv(results.errors))
                }
              >
                <Download className="mr-2 h-4 w-4" aria-hidden="true" /> {t.errorReport}
              </Button>
            ) : null}
            <Button
              className="phone:h-11"
              onClick={() => {
                setOpen(false);
                reset();
              }}
            >
              {t.close}
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
