import { useMemo, useRef, useState } from "react";
import { CheckCircle2, Download, FileSpreadsheet, Upload } from "lucide-react";
import { toast } from "sonner";
import { callApi } from "@/lib/whatsapp-client";
import { downloadCsv, parseCsv, toCsv } from "@/lib/csv";
import { normalizePhone, toWaId } from "@/lib/phone";
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

type Mapping = Record<string, string>; // column index -> field key ("phone" | "name" | "tags" | "attr:<name>" | "ignore")
type ErrorRow = { row: number; phone: string; reason: string };
type Results = { created: number; updated: number; skipped: number; errors: ErrorRow[] };

const MAX_ROWS = 10000;
const CHUNK = 200;

const SAMPLE_CSV = toCsv([
  ["phone", "name", "tags", "city", "last_purchase"],
  ["+919876543210", "Priya Sharma", "vip,repeat-buyer", "Hyderabad", "2026-07-15"],
  ["+919812345678", "Rahul Verma", "new-customer", "Mumbai", ""],
  ["+919898765432", "Anjali Patel", "vip", "Delhi", "2026-08-01"],
]);

const FORMAT_TIPS = [
  "Phone must include the country code (+91…).",
  "Tags are comma-separated inside quotes, e.g. \"vip,repeat-buyer\".",
  "Extra columns become custom attributes automatically.",
];

function FormatTips({ className = "" }: { className?: string }) {
  return (
    <ul className={`space-y-1 text-xs text-muted-foreground ${className}`}>
      {FORMAT_TIPS.map((tip) => (
        <li key={tip} className="flex items-start gap-2">
          <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary" />
          <span>{tip}</span>
        </li>
      ))}
    </ul>
  );
}

export function ImportContactsDialog({
  organizationId,
  onImported,
}: {
  organizationId: string;
  onImported: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [filename, setFilename] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Mapping>({});
  const [consent, setConsent] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Results | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const phoneColumn = useMemo(
    () => Object.entries(mapping).find(([, v]) => v === "phone")?.[0] ?? null,
    [mapping],
  );

  function reset() {
    setStep(1);
    setFilename("");
    setHeaders([]);
    setRows([]);
    setMapping({});
    setConsent(false);
    setProgress(0);
    setResults(null);
    setRunning(false);
  }

  async function handleFile(file: File) {
    const text = await file.text();
    const parsed = parseCsv(text);
    if (parsed.length < 2) {
      toast.error("That file doesn't have any data rows.");
      return;
    }
    const head = parsed[0] ?? [];
    const body = parsed.slice(1, MAX_ROWS + 1);
    const guess: Mapping = {};
    head.forEach((h, i) => {
      const key = h.trim().toLowerCase();
      if (/phone|mobile|number|whatsapp/.test(key)) guess[String(i)] = "phone";
      else if (/name/.test(key)) guess[String(i)] = "name";
      else if (/tag/.test(key)) guess[String(i)] = "tags";
      else guess[String(i)] = "ignore";
    });
    setFilename(file.name);
    setHeaders(head);
    setRows(body);
    setMapping(guess);
    setStep(2);
    if (parsed.length - 1 > MAX_ROWS) {
      toast.warning(`Only the first ${MAX_ROWS.toLocaleString()} rows will be imported.`);
    }
  }

  async function runImport() {
    if (!phoneColumn) return;
    setRunning(true);
    setStep(4);
    setProgress(0);

    const start = await callApi<{ import_id: string }>("/api/contacts/import", {
      body: {
        action: "start",
        organization_id: organizationId,
        filename,
        total_rows: rows.length,
        consent: true,
      },
    });
    if (start.error || !start.data) {
      setRunning(false);
      toast.error(start.error ?? "We couldn't start the import.");
      setStep(3);
      return;
    }
    const importId = start.data.import_id;

    const attrColumns = Object.entries(mapping).filter(([, v]) => v.startsWith("attr:"));
    const nameColumn = Object.entries(mapping).find(([, v]) => v === "name")?.[0] ?? null;
    const tagsColumn = Object.entries(mapping).find(([, v]) => v === "tags")?.[0] ?? null;

    const seen = new Set<string>();
    const errors: ErrorRow[] = [];
    const payloadRows: {
      row_number: number;
      phone: string;
      name: string;
      tags: string[];
      attributes: Record<string, string>;
    }[] = [];

    rows.forEach((r, index) => {
      const rowNumber = index + 2;
      const rawPhone = (r[Number(phoneColumn)] ?? "").trim();
      const normalized = normalizePhone(rawPhone);
      const digits = toWaId(normalized);
      if (digits.length < 8 || digits.length > 15) {
        errors.push({ row: rowNumber, phone: rawPhone, reason: "Invalid phone number" });
        return;
      }
      if (seen.has(normalized)) {
        errors.push({ row: rowNumber, phone: normalized, reason: "Duplicate row in file" });
        return;
      }
      seen.add(normalized);
      const attributes: Record<string, string> = {};
      for (const [idx, key] of attrColumns) {
        const value = (r[Number(idx)] ?? "").trim();
        if (value) attributes[key.slice(5)] = value;
      }
      payloadRows.push({
        row_number: rowNumber,
        phone: normalized,
        name: nameColumn ? (r[Number(nameColumn)] ?? "").trim() : "",
        tags: tagsColumn
          ? (r[Number(tagsColumn)] ?? "")
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
          : [],
        attributes,
      });
    });

    let created = 0;
    let updated = 0;
    for (let i = 0; i < payloadRows.length; i += CHUNK) {
      const chunk = payloadRows.slice(i, i + CHUNK);
      const res = await callApi<{ created: number; updated: number; errors: ErrorRow[] }>(
        "/api/contacts/import",
        { body: { action: "chunk", organization_id: organizationId, rows: chunk } },
      );
      if (res.error || !res.data) {
        for (const row of chunk) {
          errors.push({ row: row.row_number, phone: row.phone, reason: res.error ?? "Import failed" });
        }
      } else {
        created += res.data.created;
        updated += res.data.updated;
        errors.push(...(res.data.errors ?? []));
      }
      setProgress(Math.round(((i + chunk.length) / payloadRows.length) * 100));
    }

    const summary: Results = { created, updated, skipped: errors.length, errors };
    await callApi("/api/contacts/import", {
      body: {
        action: "finish",
        organization_id: organizationId,
        import_id: importId,
        created_count: created,
        updated_count: updated,
        skipped_count: errors.length,
        error_report: errors.slice(0, 500),
        status: "completed",
      },
    });

    setResults(summary);
    setRunning(false);
    setProgress(100);
    setStep(5);
    onImported();
  }

  const preview = rows.slice(0, 5);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" className="rounded-full">
          <Upload className="mr-2 h-4 w-4" />
          Import CSV
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import contacts</DialogTitle>
          <DialogDescription>
            Step {Math.min(step, 5)} of 5 — upload, map columns, confirm consent, import.
          </DialogDescription>
        </DialogHeader>

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
            className={`rounded-2xl border-2 border-dashed p-10 text-center transition-colors duration-200 ${
              dragging ? "border-primary bg-primary/5" : "border-border bg-muted/30"
            }`}
          >
            <FileSpreadsheet className="mx-auto h-10 w-10 text-primary" />
            <p className="mt-4 text-sm font-medium text-foreground">
              Drag & drop your CSV here
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Up to {MAX_ROWS.toLocaleString()} rows. A phone column is required.
            </p>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
              }}
            />
            <Button
              variant="outline"
              className="mt-5 rounded-full"
              onClick={() => inputRef.current?.click()}
            >
              Choose a file
            </Button>

            <div className="mt-6 border-t border-border/60 pt-5">
              <p className="text-xs text-muted-foreground">
                Not sure about the format? Start with our template.
              </p>
              <Button
                variant="link"
                className="mt-1 h-auto p-0 text-sm font-medium text-primary"
                onClick={() => downloadCsv("sample_contacts.csv", SAMPLE_CSV)}
              >
                <Download className="mr-1.5 h-3.5 w-3.5" />
                Download sample CSV
              </Button>
              <FormatTips className="mt-4 text-left" />
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {filename} · {rows.length.toLocaleString()} rows
            </p>
            <FormatTips />

            <div className="space-y-3">
              {headers.map((h, i) => (
                <div key={i} className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <div className="w-full truncate text-sm font-medium text-foreground sm:w-48">
                    {h || `Column ${i + 1}`}
                  </div>
                  <Select
                    value={mapping[String(i)] ?? "ignore"}
                    onValueChange={(v) => setMapping((prev) => ({ ...prev, [String(i)]: v }))}
                  >
                    <SelectTrigger className="sm:max-w-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ignore">Ignore</SelectItem>
                      <SelectItem value="phone">Phone (required)</SelectItem>
                      <SelectItem value="name">Name</SelectItem>
                      <SelectItem value="tags">Tags (comma separated)</SelectItem>
                      <SelectItem value={`attr:${(h || `column_${i + 1}`).trim()}`}>
                        Custom attribute “{(h || `column_${i + 1}`).trim()}”
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>

            <div className="overflow-x-auto rounded-xl border border-border/70">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    {headers.map((h, i) => (
                      <th key={i} className="px-3 py-2 font-medium text-muted-foreground">
                        {h || `Column ${i + 1}`}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.map((r, ri) => (
                    <tr key={ri} className="border-t border-border/60">
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

            <div className="flex justify-between">
              <Button variant="ghost" className="rounded-full" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button className="rounded-full" disabled={!phoneColumn} onClick={() => setStep(3)}>
                Continue
              </Button>
            </div>
            {!phoneColumn ? (
              <p className="text-xs text-destructive">Map one column to Phone to continue.</p>
            ) : null}
          </div>
        ) : null}

        {step === 3 ? (
          <div className="space-y-5">
            <div className="rounded-2xl border border-border/70 bg-muted/30 p-5">
              <div className="flex items-start gap-3">
                <Checkbox
                  id="consent"
                  checked={consent}
                  onCheckedChange={(v) => setConsent(v === true)}
                  className="mt-0.5"
                />
                <Label htmlFor="consent" className="text-sm leading-relaxed">
                  I confirm these contacts have opted in to receive WhatsApp messages from my
                  business.
                </Label>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                This attestation is recorded in your workspace activity log.
              </p>
            </div>
            <div className="flex justify-between">
              <Button variant="ghost" className="rounded-full" onClick={() => setStep(2)}>
                Back
              </Button>
              <Button className="rounded-full" disabled={!consent} onClick={() => void runImport()}>
                Start import
              </Button>
            </div>
          </div>
        ) : null}

        {step === 4 ? (
          <div className="space-y-4 py-6 text-center">
            <p className="text-sm font-medium text-foreground">Importing your contacts…</p>
            <Progress value={progress} />
            <p className="text-xs text-muted-foreground">{progress}% complete</p>
            {!running && progress === 0 ? null : null}
          </div>
        ) : null}

        {step === 5 && results ? (
          <div className="space-y-5">
            <div className="flex items-center gap-3 rounded-2xl border border-primary/20 bg-primary/5 p-4">
              <CheckCircle2 className="h-6 w-6 text-primary" />
              <p className="text-sm font-medium text-foreground">Import complete</p>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: "Created", value: results.created },
                { label: "Updated", value: results.updated },
                { label: "Skipped", value: results.skipped },
              ].map((s) => (
                <div key={s.label} className="rounded-2xl border border-border/70 bg-card p-4 text-center shadow-sm">
                  <p className="text-2xl font-bold text-foreground">{s.value.toLocaleString()}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{s.label}</p>
                </div>
              ))}
            </div>
            {results.errors.length ? (
              <Button
                variant="outline"
                className="w-full rounded-full"
                onClick={() =>
                  downloadCsv(
                    `import-errors-${Date.now()}.csv`,
                    toCsv([
                      ["row", "phone", "reason"],
                      ...results.errors.map((e) => [e.row, e.phone, e.reason]),
                    ]),
                  )
                }
              >
                <Download className="mr-2 h-4 w-4" /> Download error report
              </Button>
            ) : null}
            <Button
              className="w-full rounded-full"
              onClick={() => {
                setOpen(false);
                reset();
              }}
            >
              Done
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
