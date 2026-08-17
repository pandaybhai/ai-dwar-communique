import type { AttributionSourceRow, AttributionStepRow, Period } from "@/lib/analytics";

/**
 * CSV export for the Receipts table. The file mirrors exactly what's on screen —
 * one row per campaign or flow, its messages indented underneath, and the same
 * totals row at the bottom — so a merchant can hand it to their accountant.
 */

const escape = (value: string | number | null | undefined): string => {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const HEADERS = [
  "Type",
  "Name",
  "Created",
  "Sent",
  "Delivered",
  "Read",
  "Clicked",
  "Orders",
  "Revenue",
  "Spent",
  "Spent incl. tax",
  "Cost data complete",
  "Currency",
];

type Totals = {
  messages_sent: number;
  delivered: number;
  read_count: number;
  clicked: number;
  orders: number;
  revenue: number;
  spent: number;
  cost_complete: boolean;
};

const round = (n: number) => Math.round(n * 100) / 100;

export function buildReceiptsCsv({
  rows,
  steps,
  totals,
  gstPercent,
  currency,
  period,
  numberLabel,
}: {
  rows: AttributionSourceRow[];
  steps: AttributionStepRow[];
  totals: Totals;
  gstPercent: number;
  currency: string;
  period: Period;
  numberLabel: string;
}): string {
  const withTax = (spent: number) => round(spent * (1 + gstPercent / 100));
  const lines: string[] = [];

  lines.push(`AiDwar receipts,${escape(`${period.from} to ${period.to}`)}`);
  lines.push(`WhatsApp number,${escape(numberLabel)}`);
  lines.push(`Tax applied,${gstPercent}%`);
  lines.push("");
  lines.push(HEADERS.join(","));

  for (const row of rows) {
    const cur = row.currency ?? currency;
    lines.push(
      [
        row.source_type === "flow" ? "Automatic message" : "Campaign",
        escape(row.name),
        escape(row.created_at ? row.created_at.slice(0, 10) : ""),
        Number(row.messages_sent),
        Number(row.delivered),
        Number(row.read_count),
        Number(row.clicked),
        Number(row.orders),
        round(Number(row.revenue)),
        round(Number(row.spent)),
        withTax(Number(row.spent)),
        row.cost_complete ? "yes" : "no",
        escape(cur),
      ].join(","),
    );

    for (const step of steps.filter(
      (s) => s.source_id === row.source_id && s.source_type === row.source_type,
    )) {
      lines.push(
        [
          "Message",
          escape(`${step.step_order ? `Message ${step.step_order}: ` : ""}${step.name}`),
          "",
          Number(step.messages_sent),
          Number(step.delivered),
          Number(step.read_count),
          Number(step.clicked),
          Number(step.orders),
          round(Number(step.revenue)),
          round(Number(step.spent)),
          withTax(Number(step.spent)),
          step.cost_complete ? "yes" : "no",
          escape(step.currency ?? cur),
        ].join(","),
      );
    }
  }

  lines.push(
    [
      "Total",
      "Everything together",
      "",
      totals.messages_sent,
      totals.delivered,
      totals.read_count,
      totals.clicked,
      totals.orders,
      round(totals.revenue),
      round(totals.spent),
      withTax(totals.spent),
      totals.cost_complete ? "yes" : "no",
      escape(currency),
    ].join(","),
  );

  return lines.join("\n");
}

/** Browser-only: hand the CSV to the user as a download. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
