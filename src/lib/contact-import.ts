import { parseCsv, toCsv } from "@/lib/csv";
import { normalizePhone, toWaId } from "@/lib/phone";
import { callApi } from "@/lib/whatsapp-client";

/**
 * The contact import's own logic (Batch 36), moved unchanged out of
 * ImportContactsDialog in Batch 48 so the classic dialog and the new design's
 * guided import run exactly the same steps: read the file and guess the
 * columns, then start → chunks of 200 → finish on /api/contacts/import.
 */

/** column index -> field key ("phone" | "name" | "tags" | "attr:<name>" | "ignore") */
export type Mapping = Record<string, string>;
export type ErrorRow = { row: number; phone: string; reason: string };
export type Results = {
  created: number;
  updated: number;
  skipped: number;
  /** Batch 36: contacts the customer opted out of — never changed by an import. */
  stayedOptedOut: number;
  errors: ErrorRow[];
};
type ChunkReply = {
  created: number;
  updated: number;
  opted_in?: number;
  stayed_opted_out?: number;
  errors: ErrorRow[];
};

export const MAX_ROWS = 10000;
export const CHUNK = 200;

export const SAMPLE_CSV = toCsv([
  ["phone", "name", "tags", "city", "last_purchase"],
  ["+919876543210", "Priya Sharma", "vip,repeat-buyer", "Hyderabad", "2026-07-15"],
  ["+919812345678", "Rahul Verma", "new-customer", "Mumbai", ""],
  ["+919898765432", "Anjali Patel", "vip", "Delhi", "2026-08-01"],
]);

/** Column header → attributes jsonb key (lowercased, underscored). */
export function attrKey(header: string, index: number): string {
  const slug = header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || `column_${index + 1}`;
}

export const FORMAT_TIPS = [
  "Phone must include the country code (+91…).",
  'Tags are comma-separated inside quotes, e.g. "vip,repeat-buyer".',
  "Extra columns become custom attributes automatically.",
];

export type ParsedImport = {
  headers: string[];
  rows: string[][];
  mapping: Mapping;
  /** The file had more than MAX_ROWS data rows; only the first ones are kept. */
  truncated: boolean;
};

/** A CSV's text → its header, up to MAX_ROWS rows and a first guess at each column; null without data rows. */
export function readImportCsv(text: string): ParsedImport | null {
  const parsed = parseCsv(text);
  if (parsed.length < 2) return null;
  const head = parsed[0] ?? [];
  const body = parsed.slice(1, MAX_ROWS + 1);
  const guess: Mapping = {};
  head.forEach((h, i) => {
    const key = h.trim().toLowerCase();
    if (/phone|mobile|number|whatsapp/.test(key)) guess[String(i)] = "phone";
    else if (/name/.test(key)) guess[String(i)] = "name";
    else if (/tag/.test(key)) guess[String(i)] = "tags";
    else guess[String(i)] = `attr:${attrKey(h, i)}`;
  });
  return { headers: head, rows: body, mapping: guess, truncated: parsed.length - 1 > MAX_ROWS };
}

/** The column mapped to Phone, if any (an import can't start without one). */
export function phoneColumnOf(mapping: Mapping): string | null {
  return Object.entries(mapping).find(([, v]) => v === "phone")?.[0] ?? null;
}

type CallApi = typeof callApi;

/**
 * Runs an import: start, then the rows in chunks, then finish. Returns the
 * start error when the import couldn't begin (nothing was sent), else the
 * results; a failed chunk counts its rows as skipped, as before.
 */
export async function runContactImport(
  {
    organizationId,
    filename,
    rows,
    mapping,
    consent,
    startFlows,
    onProgress,
  }: {
    organizationId: string;
    filename: string;
    rows: string[][];
    mapping: Mapping;
    consent: boolean;
    startFlows: boolean;
    onProgress: (percent: number) => void;
  },
  call: CallApi = callApi,
): Promise<{ startError: string } | { results: Results }> {
  const phoneColumn = phoneColumnOf(mapping);
  const start = await call<{ import_id: string }>("/api/contacts/import", {
    body: {
      action: "start",
      organization_id: organizationId,
      filename,
      total_rows: rows.length,
      consent,
    },
  });
  if (start.error || !start.data) {
    return { startError: start.error ?? "We couldn't start the import." };
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
  let optedIn = 0;
  let stayedOptedOut = 0;
  for (let i = 0; i < payloadRows.length; i += CHUNK) {
    const chunk = payloadRows.slice(i, i + CHUNK);
    const res = await call<ChunkReply>("/api/contacts/import", {
      body: {
        action: "chunk",
        organization_id: organizationId,
        consent,
        start_flows: startFlows,
        import_id: importId,
        rows: chunk,
      },
    });
    if (res.error || !res.data) {
      for (const row of chunk) {
        errors.push({
          row: row.row_number,
          phone: row.phone,
          reason: res.error ?? "Import failed",
        });
      }
    } else {
      created += res.data.created;
      updated += res.data.updated;
      optedIn += res.data.opted_in ?? 0;
      stayedOptedOut += res.data.stayed_opted_out ?? 0;
      errors.push(...(res.data.errors ?? []));
    }
    onProgress(Math.round(((i + chunk.length) / payloadRows.length) * 100));
  }

  const summary: Results = { created, updated, skipped: errors.length, stayedOptedOut, errors };
  await call("/api/contacts/import", {
    body: {
      action: "finish",
      organization_id: organizationId,
      import_id: importId,
      created_count: created,
      updated_count: updated,
      skipped_count: errors.length,
      opted_in_count: optedIn,
      stayed_opted_out_count: stayedOptedOut,
      error_report: errors.slice(0, 500),
      status: "completed",
    },
  });
  return { results: summary };
}

/** The error report a merchant downloads after an import. */
export function errorReportCsv(errors: ErrorRow[]): string {
  return toCsv([["row", "phone", "reason"], ...errors.map((e) => [e.row, e.phone, e.reason])]);
}
