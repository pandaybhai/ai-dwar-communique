import { useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Upload } from "lucide-react";
import { toast } from "sonner";
import { callApi } from "@/lib/whatsapp-client";
import { downloadCsv, parseCsv, toCsv } from "@/lib/csv";
import {
  CATALOG_TEMPLATE_CSV,
  IMPORT_FIELDS,
  detectMapping,
  parsePrice,
  type ImportError,
  type ImportField,
  type ImportResults,
  type ImportWarning,

} from "@/lib/catalog";
import { Button } from "@/components/ui/button";
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
} from "@/components/ui/dialog";

const MAX_ROWS = 10000;
const CHUNK = 100;

type Mapping = Record<string, ImportField>;

const STEPS = ["Upload", "Match columns", "Preview", "Import"];

export function ImportProductsDialog({
  organizationId,
  open,
  onOpenChange,
  onImported,
}: {
  organizationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  const [step, setStep] = useState(1);
  const [filename, setFilename] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Mapping>({});
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ImportResults | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const titleColumn = useMemo(
    () => Object.entries(mapping).find(([, field]) => field === "title")?.[0] ?? null,
    [mapping],
  );

  const validation = useMemo(() => {
    if (titleColumn === null) return { valid: 0, blank: 0, badPrice: 0 };
    const priceColumn = Object.entries(mapping).find(([, f]) => f === "price")?.[0] ?? null;
    let valid = 0;
    let blank = 0;
    let badPrice = 0;
    for (const row of rows) {
      const title = (row[Number(titleColumn)] ?? "").trim();
      if (!title) {
        blank += 1;
        continue;
      }
      valid += 1;
      if (priceColumn !== null) {
        const raw = (row[Number(priceColumn)] ?? "").trim();
        if (raw && parsePrice(raw) === null) badPrice += 1;
      }
    }
    return { valid, blank, badPrice };
  }, [rows, mapping, titleColumn]);

  function reset() {
    setStep(1);
    setFilename("");
    setHeaders([]);
    setRows([]);
    setMapping({});
    setProgress(0);
    setRunning(false);
    setResults(null);
  }

  async function readFile(file: File) {
    setReading(true);
    try {
      let table: string[][] = [];
      if (/\.xlsx?$/i.test(file.name)) {
        const XLSX = await import("xlsx");
        const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
        const sheetName = workbook.SheetNames[0];
        const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
        if (!sheet) throw new Error("That spreadsheet has no sheets.");
        table = XLSX.utils
          .sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: "" })
          .map((r) => (r as unknown[]).map((c) => String(c ?? "")));
      } else {
        table = parseCsv(await file.text());
      }

      const [headerRow, ...dataRows] = table;
      if (!headerRow || !dataRows.length) {
        toast.error("That file has no rows we can read.");
        return;
      }
      if (dataRows.length > MAX_ROWS) {
        toast.error(`Imports are limited to ${MAX_ROWS.toLocaleString()} rows per file.`);
        return;
      }
      setFilename(file.name);
      setHeaders(headerRow.map((h) => h.trim()));
      setRows(dataRows);
      setMapping(detectMapping(headerRow.map((h) => h.trim())));
      setStep(2);
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "We couldn't read that file. Try a CSV.",
      );
    } finally {
      setReading(false);
    }
  }

  function rowPayload(row: string[], index: number) {
    const payload: Record<string, string | number> = { row_number: index + 2 };
    for (const [column, field] of Object.entries(mapping)) {
      if (field === "ignore") continue;
      payload[field] = (row[Number(column)] ?? "").trim();
    }
    return payload;
  }

  async function runImport() {
    setRunning(true);
    setProgress(0);
    setStep(4);

    const start = await callApi<{ import_id: string }>("/api/catalog/import", {
      body: {
        action: "start",
        organization_id: organizationId,
        filename,
        total_rows: rows.length,
      },
    });
    if (start.error || !start.data) {
      setRunning(false);
      toast.error(start.error ?? "We couldn't start the import.");
      setStep(3);
      return;
    }
    const importId = start.data.import_id;

    let created = 0;
    let updated = 0;
    let warned = 0;
    const errors: ImportError[] = [];
    const warnings: ImportWarning[] = [];

    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK).map((row, offset) => rowPayload(row, i + offset));
      const { data, error } = await callApi<{
        created: number;
        updated: number;
        warned: number;
        errors: ImportError[];
        warnings: ImportWarning[];
      }>("/api/catalog/import", {
        body: {
          action: "chunk",
          organization_id: organizationId,
          import_id: importId,
          rows: chunk,
        },
      });
      if (error || !data) {
        await callApi("/api/catalog/import", {
          body: { action: "fail", organization_id: organizationId, import_id: importId },
        });
        setRunning(false);
        toast.error(error ?? "The import stopped partway. Nothing after this row was imported.");
        setResults({ created, updated, warned, failed: errors.length, errors, warnings });
        return;
      }
      created += data.created;
      updated += data.updated;
      warned += data.warned ?? 0;
      errors.push(...(data.errors ?? []));
      warnings.push(...(data.warnings ?? []));
      setProgress(Math.round(Math.min(i + CHUNK, rows.length) / rows.length * 100));
    }

    const finish = await callApi("/api/catalog/import", {
      body: { action: "finish", organization_id: organizationId, import_id: importId },
    });
    if (finish.error) toast.error(finish.error);

    setResults({ created, updated, warned, failed: errors.length, errors, warnings });
    setRunning(false);
    onImported();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Upload products</DialogTitle>
          <DialogDescription>
            Bring in a spreadsheet of products — we'll match the columns for you.
          </DialogDescription>
        </DialogHeader>

        <ol className="mb-2 flex flex-wrap gap-2 text-xs">
          {STEPS.map((label, index) => (
            <li
              key={label}
              className={`rounded-full px-3 py-1 transition-colors duration-200 ${
                step === index + 1
                  ? "bg-primary text-primary-foreground"
                  : step > index + 1
                    ? "bg-primary/10 text-primary"
                    : "bg-muted text-muted-foreground"
              }`}
            >
              {index + 1}. {label}
            </li>
          ))}
        </ol>

        {/* ---------------- 1. upload ---------------- */}
        {step === 1 ? (
          <div className="space-y-4">
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
                if (file) void readFile(file);
              }}
              className={`rounded-2xl border-2 border-dashed p-10 text-center transition-colors duration-200 ${
                dragging ? "border-primary bg-primary/5" : "border-border/70"
              }`}
            >
              <FileSpreadsheet className="mx-auto h-10 w-10 text-primary" />
              <p className="mt-4 text-sm font-medium text-foreground">
                Drag a CSV or Excel file here
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Up to {MAX_ROWS.toLocaleString()} products per file.
              </p>
              <input
                ref={inputRef}
                type="file"
                accept=".csv,.xlsx,.xls,text/csv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void readFile(file);
                  e.target.value = "";
                }}
              />
              <Button
                variant="outline"
                className="mt-5"
                disabled={reading}
                onClick={() => inputRef.current?.click()}
              >
                <Upload className="mr-2 h-4 w-4" /> Choose a file
              </Button>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => downloadCsv("aidwar-product-template.csv", CATALOG_TEMPLATE_CSV)}
            >
              <Download className="mr-2 h-4 w-4" /> Download the template
            </Button>
          </div>
        ) : null}

        {/* ---------------- 2. mapping ---------------- */}
        {step === 2 ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {filename} — {rows.length.toLocaleString()} rows. Change anything we matched wrongly.
            </p>
            <div className="space-y-3">
              {headers.map((header, index) => (
                <div key={`${header}-${index}`} className="grid items-center gap-3 sm:grid-cols-2">
                  <div className="min-w-0">
                    <Label className="truncate">{header || `Column ${index + 1}`}</Label>
                    <p className="truncate text-xs text-muted-foreground">
                      {(rows[0]?.[index] ?? "").slice(0, 60) || "—"}
                    </p>
                  </div>
                  <Select
                    value={mapping[String(index)] ?? "ignore"}
                    onValueChange={(value) =>
                      setMapping((m) => ({ ...m, [String(index)]: value as ImportField }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {IMPORT_FIELDS.map((field) => (
                        <SelectItem key={field.key} value={field.key}>
                          {field.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
            {titleColumn === null ? (
              <p className="flex items-center gap-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4" /> Pick which column holds the product name.
              </p>
            ) : null}
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button disabled={titleColumn === null} onClick={() => setStep(3)}>
                Preview
              </Button>
            </div>
          </div>
        ) : null}

        {/* ---------------- 3. preview ---------------- */}
        {step === 3 ? (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <SummaryCard label="Ready to import" value={validation.valid} tone="good" />
              <SummaryCard label="Blank rows skipped" value={validation.blank} tone="muted" />
              <SummaryCard label="Prices we couldn't read" value={validation.badPrice} tone="warn" />
            </div>
            <div className="overflow-x-auto rounded-xl border border-border/70">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    {IMPORT_FIELDS.filter(
                      (f) => f.key !== "ignore" && Object.values(mapping).includes(f.key),
                    ).map((f) => (
                      <th key={f.key} className="whitespace-nowrap px-3 py-2 font-medium">
                        {f.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 10).map((row, rowIndex) => (
                    <tr key={rowIndex} className="border-t border-border/60">
                      {IMPORT_FIELDS.filter(
                        (f) => f.key !== "ignore" && Object.values(mapping).includes(f.key),
                      ).map((f) => {
                        const column = Object.entries(mapping).find(([, v]) => v === f.key)?.[0];
                        return (
                          <td key={f.key} className="max-w-[200px] truncate px-3 py-2">
                            {column === undefined ? "" : (row[Number(column)] ?? "")}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              Rows with a SKU update the matching product; the rest are matched on the product name.
            </p>
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep(2)}>
                Back
              </Button>
              <Button disabled={validation.valid === 0} onClick={() => void runImport()}>
                Import {validation.valid.toLocaleString()} products
              </Button>
            </div>
          </div>
        ) : null}

        {/* ---------------- 4. import ---------------- */}
        {step === 4 ? (
          <div className="space-y-4">
            {running ? (
              <>
                <Progress value={progress} />
                <p className="text-sm text-muted-foreground">
                  Importing your products… {progress}%
                </p>
              </>
            ) : results ? (
              <>
                <div className="rounded-2xl border border-border/70 bg-card p-6 text-center">
                  <CheckCircle2 className="mx-auto h-10 w-10 text-primary" />
                  <p className="mt-4 text-lg font-semibold text-foreground">Import finished</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {results.created.toLocaleString()} added, {results.updated.toLocaleString()}{" "}
                    updated
                    {results.failed ? `, ${results.failed.toLocaleString()} couldn't be saved` : ""}
                    .
                  </p>
                </div>
                {results.failed ? (
                  <div className="space-y-3">
                    <div className="max-h-40 space-y-1 overflow-y-auto rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-xs">
                      {results.errors.slice(0, 20).map((e) => (
                        <p key={`${e.row}-${e.product}`}>
                          Row {e.row}: {e.product || "—"} — {e.reason}
                        </p>
                      ))}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        downloadCsv(
                          "product-import-errors.csv",
                          toCsv([
                            ["row", "product", "reason"],
                            ...results.errors.map((e) => [e.row, e.product, e.reason]),
                          ]),
                        )
                      }
                    >
                      <Download className="mr-2 h-4 w-4" /> Download the error report
                    </Button>
                  </div>
                ) : null}
                <div className="flex justify-end">
                  <Button
                    onClick={() => {
                      reset();
                      onOpenChange(false);
                    }}
                  >
                    Done
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "good" | "warn" | "muted";
}) {
  const toneClass =
    tone === "good"
      ? "text-primary"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : "text-muted-foreground";
  return (
    <div className="rounded-xl border border-border/70 bg-card p-4">
      <p className={`text-2xl font-semibold ${toneClass}`}>{value.toLocaleString()}</p>
      <p className="mt-1 text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
