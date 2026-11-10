import { failureReason } from "@/lib/wa-reachability";
import type { RefusalRecord } from "@/lib/api-refusals";

/**
 * Batch 63 (C): a template's "Sent" report — every send of one template from
 * any source (API, campaign, flow, Inbox), read only from existing messages
 * rows (direction outbound, type template, template_name) through the
 * member's own client (RLS: the same rows the Inbox shows). Client-safe.
 *
 * An API send's copies (Batch 61: metadata.copy = true, metadata.cc_of = the
 * customer's message id) are listed under the customer's send, not as sends
 * of their own; totals count them separately ("copies sent").
 */

export type SendSource = "api" | "campaign" | "flow" | "inbox" | "other";

export const SEND_SOURCE_LABEL: Record<SendSource, string> = {
  api: "API",
  campaign: "Campaign",
  flow: "Flow",
  inbox: "Inbox",
  other: "Automation",
};

export const SEND_SOURCES: SendSource[] = ["api", "campaign", "flow", "inbox", "other"];

/** Batch 67: "refused" — an API send refused before it was sent (public.api_refusals), never a messages row. */
export type SendStatus = "pending" | "sent" | "delivered" | "read" | "failed" | "refused";
export const SEND_STATUSES: SendStatus[] = ["sent", "delivered", "read", "failed", "refused"];

export type SendRow = {
  id: string;
  created_at: string;
  status: string | null;
  status_updated_at?: string | null;
  error_detail?: unknown;
  template_name: string | null;
  campaign_id: string | null;
  flow_id: string | null;
  sent_by: string | null;
  metadata: Record<string, unknown> | null;
  conversation_id?: string | null;
  conversations?: {
    contact_id?: string | null;
    contacts?: { id?: string | null; name?: string | null; phone?: string | null } | null;
  } | null;
  campaigns?: { name?: string | null } | null;
};

export function sendSourceOf(
  row: Pick<SendRow, "metadata" | "campaign_id" | "flow_id" | "sent_by">,
): SendSource {
  const source = String(row.metadata?.["source"] ?? "");
  if (source === "api" || source === "api_console") return "api";
  if (row.campaign_id) return "campaign";
  if (row.flow_id || row.metadata?.["kind"] === "flow_v2" || row.metadata?.["run_id"])
    return "flow";
  if (row.sent_by) return "inbox";
  return "other";
}

/** Whether the row is a Batch 61 copy of an API send. */
export function isCopy(row: Pick<SendRow, "metadata">): boolean {
  return row.metadata?.["copy"] === true && typeof row.metadata?.["cc_of"] === "string";
}

/** The reference the merchant knows the send by: the API's idempotency key, the invoice file, the campaign. */
export function sendReference(row: SendRow): string | null {
  const m = row.metadata ?? {};
  const key =
    typeof m["idempotency_key"] === "string" && m["idempotency_key"]
      ? String(m["idempotency_key"])
      : null;
  const file =
    typeof m["document_filename"] === "string" && m["document_filename"]
      ? String(m["document_filename"])
      : null;
  if (key && file && !file.includes(key)) return `${key} · ${file}`;
  if (key) return key;
  if (file) return file;
  if (row.campaigns?.name) return row.campaigns.name;
  return null;
}

export type SendLine = {
  id: string;
  at: string;
  source: SendSource;
  customer: string;
  phone: string;
  contactId: string | null;
  reference: string | null;
  status: SendStatus;
  reason: string | null;
  copy: boolean;
  copies: SendLine[];
};

function asStatus(s: string | null | undefined): SendStatus {
  return s === "sent" || s === "delivered" || s === "read" || s === "failed" ? s : "pending";
}

export function toLine(row: SendRow): SendLine {
  const contact = row.conversations?.contacts ?? null;
  const phone = String(contact?.phone ?? row.metadata?.["to"] ?? "").trim();
  const status = asStatus(row.status);
  return {
    id: row.id,
    at: row.created_at,
    source: sendSourceOf(row),
    customer: String(contact?.name ?? "").trim() || phone || "Unknown customer",
    phone,
    contactId: contact?.id ?? row.conversations?.contact_id ?? null,
    reference: sendReference(row),
    status,
    reason: status === "failed" ? failureReason(row.error_detail) : null,
    copy: isCopy(row),
    copies: [],
  };
}

/** Batch 67: a refused API send as a report line (no customer: the number is as the request gave it). */
export function refusalLine(r: RefusalRecord): SendLine {
  const phone = String(r.to_received ?? "").trim();
  return {
    id: `refusal:${r.id}`,
    at: r.created_at,
    source: "api",
    customer: phone || "No number given",
    phone,
    contactId: null,
    reference: r.idempotency_key,
    status: "refused",
    // The field (e.g. cc[1]) only when the sentence doesn't already name it.
    reason: r.field && !r.reason.includes(r.field) ? `${r.reason} (${r.field})` : r.reason,
    copy: false,
    copies: [],
  };
}

/**
 * Customer sends, newest first, each with its copies (oldest first) under
 * it. A copy whose customer send isn't on this page is shown on its own,
 * marked as a copy, so nothing read is ever hidden.
 */
export function nestCopies(rows: SendRow[], copyRows: SendRow[] = []): SendLine[] {
  const main: SendLine[] = [];
  const byId = new Map<string, SendLine>();
  const loose: SendRow[] = [];
  for (const r of rows) {
    if (isCopy(r)) {
      loose.push(r);
      continue;
    }
    const line = toLine(r);
    main.push(line);
    byId.set(line.id, line);
  }
  const seen = new Set<string>();
  for (const c of [...copyRows, ...loose]) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const parent = byId.get(String(c.metadata?.["cc_of"] ?? ""));
    if (parent) parent.copies.push(toLine(c));
    else main.push(toLine(c));
  }
  for (const l of main) l.copies.sort((a, b) => a.at.localeCompare(b.at));
  return main.sort((a, b) => b.at.localeCompare(a.at));
}

export type SendTotals = {
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  copies: number;
  /** Batch 67: API sends refused before they were sent. */
  refused: number;
};

/**
 * "Sent" counts every message WhatsApp accepted (sent, delivered or read);
 * "delivered" includes read (a read message was delivered); copies are not in
 * the four customer numbers and are counted on their own.
 */
export function totalsFrom(
  counts: Partial<Record<SendStatus, number>>,
  copies: number,
  refused = 0,
): SendTotals {
  const read = counts.read ?? 0;
  const delivered = (counts.delivered ?? 0) + read;
  return {
    sent: (counts.sent ?? 0) + delivered,
    delivered,
    read,
    failed: counts.failed ?? 0,
    copies,
    refused,
  };
}

export type SendFilters = {
  from: string | null;
  to: string | null;
  source: SendSource | "all";
  status: SendStatus | "all";
  failedOnly: boolean;
};

export const NO_SEND_FILTERS: SendFilters = {
  from: null,
  to: null,
  source: "all",
  status: "all",
  failedOnly: false,
};

/** The status filter in force ("failed only" wins). */
export function statusFilter(f: SendFilters): SendStatus | "all" {
  return f.failedOnly ? "failed" : f.status;
}

/** Days are the merchant's (India) days: "to" includes its whole day. */
export function dateBounds(f: Pick<SendFilters, "from" | "to">): {
  gte: string | null;
  lt: string | null;
} {
  const at = (d: string, plusDay: boolean) => {
    const ms = Date.parse(`${d}T00:00:00+05:30`);
    return Number.isFinite(ms) ? new Date(ms + (plusDay ? 864e5 : 0)).toISOString() : null;
  };
  return { gte: f.from ? at(f.from, false) : null, lt: f.to ? at(f.to, true) : null };
}

/**
 * The PostgREST or() for a source. API sends are marked by metadata.source,
 * campaigns by campaign_id, flows by flow_id or metadata.kind, the Inbox by
 * sent_by; "other" is none of those.
 */
export function sourceClauses(source: SendSource): {
  eq?: Array<[string, string]>;
  is?: Array<[string, null]>;
  not?: Array<[string, string, unknown]>;
  or?: string;
} {
  switch (source) {
    case "api":
      return { or: "metadata->>source.eq.api,metadata->>source.eq.api_console" };
    case "campaign":
      return { not: [["campaign_id", "is", null]] };
    case "flow":
      return { is: [["campaign_id", null]], or: "flow_id.not.is.null,metadata->>kind.eq.flow_v2" };
    case "inbox":
      return {
        is: [
          ["campaign_id", null],
          ["flow_id", null],
        ],
        not: [["sent_by", "is", null]],
      };
    case "other":
      return {
        is: [
          ["campaign_id", null],
          ["flow_id", null],
          ["sent_by", null],
        ],
      };
  }
}

const STATUS_LABEL: Record<SendStatus, string> = {
  pending: "Sending",
  sent: "Sent",
  delivered: "Delivered",
  read: "Read",
  failed: "Failed",
  refused: "Refused",
};
export const sendStatusLabel = (s: SendStatus) => STATUS_LABEL[s];

function csvCell(v: string): string {
  // A phone number ("+91…") stays as it is; anything a spreadsheet would run as a formula is defused.
  const text = /^[=@\t\r]/.test(v) || /^[+-](?![\d\s])/.test(v) ? `'${v}` : v;
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV of the lines shown, copies on their own rows right under their send. */
export function sendsCsv(template: string, lines: SendLine[]): string {
  const head = [
    "sent_at",
    "template",
    "source",
    "customer",
    "phone",
    "reference",
    "status",
    "failure_reason",
    "copy_of",
  ];
  const out = [head.join(",")];
  const row = (l: SendLine, copyOf: string) =>
    [
      l.at,
      template,
      SEND_SOURCE_LABEL[l.source],
      l.customer,
      l.phone,
      l.reference ?? "",
      STATUS_LABEL[l.status],
      l.reason ?? "",
      copyOf,
    ]
      .map((v) => csvCell(String(v)))
      .join(",");
  for (const l of lines) {
    out.push(row(l, ""));
    for (const c of l.copies) out.push(row(c, l.id));
  }
  return `${out.join("\n")}\n`;
}

/** CSV is for owners and admins (the same people who see Billing's exports). */
export function canDownloadSends(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}
