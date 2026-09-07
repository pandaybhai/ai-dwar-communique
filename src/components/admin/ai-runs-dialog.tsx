import { useCallback, useEffect, useState } from "react";
import { Download, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { TableSkeleton } from "@/components/data-pagination";
import { callApi } from "@/lib/whatsapp-client";
import { downloadCsv } from "@/lib/csv";
import { money } from "@/lib/billing";

export type AiRunDetailRow = {
  id: string;
  created_at: string;
  task: string | null;
  tier: string | null;
  model: string | null;
  cost_amount: number;
  billed_amount: number;
  markup_multiplier: number | null;
  conversation_id: string | null;
  billed: boolean;
  debit_amount: number | null;
};

type Totals = { answers: number; provider_cost: number; billed: number; margin: number };

const HEADERS = [
  "When",
  "Task",
  "Tier",
  "Model",
  "Provider cost",
  "Billed to client",
  "Charged to wallet",
  "Wallet debit",
  "Run id",
  "Conversation id",
];

const cell = (value: string | number) => {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function aiRunsCsv(rows: AiRunDetailRow[]): string {
  const body = rows.map((r) =>
    [
      r.created_at,
      r.task ?? "",
      r.tier ?? "",
      r.model ?? "",
      r.cost_amount,
      r.billed_amount,
      r.billed ? "yes" : "no",
      r.debit_amount ?? "",
      r.id,
      r.conversation_id ?? "",
    ]
      .map(cell)
      .join(","),
  );
  return [HEADERS.join(","), ...body].join("\n");
}

const monthLabel = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return month;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
};

/**
 * The answers behind one workspace's month: every run we priced, and the wallet
 * debit (if any) that charged the client for it. Read-only.
 */
export function AiRunsDialog({
  open,
  organizationId,
  organizationName,
  month,
  onClose,
}: {
  open: boolean;
  organizationId: string | null;
  organizationName: string;
  month: string | null;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<AiRunDetailRow[] | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!organizationId || !month) return;
    setRows(null);
    setError(null);
    const result = await callApi<{ runs: AiRunDetailRow[]; totals: Totals }>("/api/admin/billing", {
      body: { action: "ai_runs_detail", organization_id: organizationId, month },
    });
    if (result.error) {
      setError(result.error);
      setRows([]);
      return;
    }
    setRows(result.data?.runs ?? []);
    setTotals(result.data?.totals ?? null);
  }, [organizationId, month]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>
            AI answers · {organizationName}
            {month ? ` · ${monthLabel(month)}` : ""}
          </DialogTitle>
        </DialogHeader>

        {totals ? (
          <div className="grid gap-3 sm:grid-cols-4">
            {[
              { label: "Answers", value: String(totals.answers) },
              { label: "Provider cost", value: money(totals.provider_cost) },
              { label: "Billed to client", value: money(totals.billed) },
              { label: "AI margin", value: money(totals.margin), negative: totals.margin < 0 },
            ].map((stat) => (
              <div key={stat.label} className="rounded-xl border border-border/70 p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  {stat.label}
                </p>
                <p
                  className={`mt-1 text-lg font-semibold ${
                    stat.negative ? "text-destructive" : "text-foreground"
                  }`}
                >
                  {stat.value}
                </p>
              </div>
            ))}
          </div>
        ) : null}

        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            disabled={!rows || rows.length === 0}
            onClick={() =>
              downloadCsv(
                `aidwar-ai-${organizationName.replace(/\W+/g, "-").toLowerCase()}-${month}.csv`,
                aiRunsCsv(rows ?? []),
              )
            }
          >
            <Download className="mr-2 h-4 w-4" />
            Export this month
          </Button>
        </div>

        {error ? <ErrorState message={error} /> : null}

        {rows === null ? (
          <TableSkeleton rows={6} />
        ) : rows.length === 0 && !error ? (
          <EmptyState
            icon={Sparkles}
            title="No AI answers this month"
            description="Nothing was answered by the AI employee for this workspace in this month."
          />
        ) : (
          <div className="max-h-[50vh] overflow-auto rounded-xl border border-border/70">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="sticky top-0 border-b border-border/70 bg-muted/60">
                <tr>
                  {["When", "Task", "Tier · model", "Provider cost", "Billed", "Wallet debit"].map(
                    (h) => (
                      <th
                        key={h}
                        className="whitespace-nowrap px-3 py-2 text-left text-xs font-semibold text-muted-foreground"
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-border/50 last:border-0">
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                      {new Date(r.created_at).toLocaleString("en-IN")}
                    </td>
                    <td className="px-3 py-2 text-foreground">{r.task ?? "—"}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {r.tier ?? "—"}
                      {r.model ? ` · ${r.model}` : ""}
                    </td>
                    <td className="px-3 py-2">{money(r.cost_amount)}</td>
                    <td className="px-3 py-2">
                      {r.billed ? (
                        money(r.billed_amount)
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          Inside allowance — not charged
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {r.debit_amount === null ? "—" : money(r.debit_amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
