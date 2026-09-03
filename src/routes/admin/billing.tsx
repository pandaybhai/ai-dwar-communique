import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpDown, Building2, FileText, RefreshCw, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, PageHeader } from "@/components/empty-state";
import { TableSkeleton } from "@/components/data-pagination";
import { TopupsDrawer, type TopupTask } from "@/components/admin/topups-drawer";
import { callApi } from "@/lib/whatsapp-client";
import { money } from "@/lib/billing";

type Row = {
  organization_id: string;
  name: string;
  plan_name: string | null;
  plan_status: string | null;
  funding_model: string | null;
  available: number;
  held: number;
  low_credit_threshold: number;
  meta_float: number | null;
  meta_float_target: number;
  mtd_consumed: number;
  mtd_meta_cost: number;
  mtd_margin: number;
  sent: number;
  delivered: number;
  failed: number;
  numbers: { display: string | null; quality: string | null; tier: number | null }[];
  pending_topups: number;
  last_activity: string | null;
};

type SortKey =
  | "name"
  | "available"
  | "mtd_consumed"
  | "mtd_margin"
  | "sent"
  | "pending_topups";

export const Route = createFileRoute("/admin/billing")({
  component: AdminBilling,
  head: () => ({
    meta: [
      { title: "Billing overview · AiDwar Super Admin" },
      {
        name: "description",
        content: "Wallets, margins and Meta top-ups across every AiDwar workspace.",
      },
    ],
  }),
});

function statusTone(status: string | null): string {
  if (status === "active") return "bg-primary/10 text-primary";
  if (status === "trialing") return "bg-amber-500/10 text-amber-600";
  if (status === "past_due" || status === "cancelled") return "bg-destructive/10 text-destructive";
  return "bg-muted text-muted-foreground";
}

const FUNDING_LABEL: Record<string, string> = {
  meta_direct: "Pays Meta directly",
  aidwar_prepaid: "We fund Meta",
  bsp: "Through a partner",
};

function AdminBilling() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [tasks, setTasks] = useState<TopupTask[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "mtd_consumed",
    dir: "desc",
  });

  const load = useCallback(async () => {
    setError(null);
    const [overview, topups] = await Promise.all([
      callApi<{ rows: Row[] }>("/api/admin/billing", { body: { action: "overview" } }),
      callApi<{ tasks: TopupTask[] }>("/api/admin/billing", { body: { action: "topup_tasks" } }),
    ]);
    if (overview.error) {
      setError(overview.error);
      setRows([]);
      return;
    }
    setRows(overview.data?.rows ?? []);
    setTasks(topups.data?.tasks ?? []);
  }, []);

  useEffect(() => void load(), [load]);

  const sorted = useMemo(() => {
    if (!rows) return null;
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      const cmp =
        typeof av === "string" || typeof bv === "string"
          ? String(av ?? "").localeCompare(String(bv ?? ""))
          : Number(av ?? 0) - Number(bv ?? 0);
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sort]);

  function toggleSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" },
    );
  }

  function Th({ label, sortKey }: { label: string; sortKey?: SortKey }) {
    return (
      <th className="whitespace-nowrap px-3 py-2 text-left text-xs font-semibold text-muted-foreground">
        {sortKey ? (
          <button
            type="button"
            onClick={() => toggleSort(sortKey)}
            className="inline-flex items-center gap-1 transition-colors duration-150 hover:text-foreground"
          >
            {label}
            <ArrowUpDown className="h-3 w-3" />
          </button>
        ) : (
          label
        )}
      </th>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader
          title="Billing"
          description="What every workspace holds, spends and earns us — and what we still owe Meta."
        />
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setDrawer(true)}>
            <Wallet className="mr-2 h-4 w-4" />
            Top-ups due ({tasks.length})
          </Button>
          <Button
            variant="ghost"
            onClick={async () => {
              const result = await callApi<{ created?: string[]; error?: string }>(
                "/api/admin/billing",
                { body: { action: "create_billing_templates" } },
              );
              if (result.error || result.data?.error) {
                setError(result.error ?? result.data?.error ?? "We couldn't create the templates.");
                return;
              }
              setError(null);
            }}
          >
            <FileText className="mr-2 h-4 w-4" />
            Billing templates
          </Button>
          <Button variant="ghost" onClick={() => void load()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </div>
      </div>

      {error ? <ErrorState message={error} /> : null}

      {!sorted ? (
        <TableSkeleton rows={8} />
      ) : sorted.length === 0 && !error ? (
        <EmptyState
          icon={Building2}
          title="No billing-enabled workspaces yet"
          description="Turn billing on for a workspace and its wallet, usage and margin will appear here."
        />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border/70 bg-card shadow-sm">
          <table className="w-full min-w-[1100px] text-sm">
            <thead className="border-b border-border/70 bg-muted/40">
              <tr>
                <Th label="Workspace" sortKey="name" />
                <Th label="Plan" />
                <Th label="Funding" />
                <Th label="Available" sortKey="available" />
                <Th label="Meta estimate" />
                <Th label="Spent (MTD)" sortKey="mtd_consumed" />
                <Th label="Margin (MTD)" sortKey="mtd_margin" />
                <Th label="Messages" sortKey="sent" />
                <Th label="Number" />
                <Th label="Top-ups" sortKey="pending_topups" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => {
                const lowCredits = row.available < Number(row.low_credit_threshold ?? 0);
                const lowFloat =
                  row.meta_float !== null && row.meta_float < Number(row.meta_float_target ?? 0);
                const number = row.numbers[0] ?? null;
                return (
                  <tr
                    key={row.organization_id}
                    className="border-b border-border/50 last:border-0 transition-colors duration-150 hover:bg-muted/30"
                  >
                    <td className="px-3 py-3">
                      <Link
                        to="/admin/organizations"
                        className="font-medium text-foreground hover:text-primary"
                      >
                        {row.name}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {row.last_activity
                          ? `Active ${new Date(row.last_activity).toLocaleDateString("en-IN")}`
                          : "No activity yet"}
                      </p>
                    </td>
                    <td className="px-3 py-3">
                      <span className="font-medium text-foreground">{row.plan_name ?? "—"}</span>
                      {row.plan_status ? (
                        <span
                          className={`ml-2 rounded-full px-2 py-0.5 text-xs font-medium ${statusTone(row.plan_status)}`}
                        >
                          {row.plan_status.replace(/_/g, " ")}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-3">
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {FUNDING_LABEL[row.funding_model ?? ""] ?? "—"}
                      </span>
                    </td>
                    <td
                      className={`px-3 py-3 ${lowCredits ? "text-amber-600 font-semibold" : "text-foreground"}`}
                    >
                      {money(row.available)}
                      {row.held > 0 ? (
                        <span className="block text-xs text-muted-foreground">
                          {money(row.held)} held
                        </span>
                      ) : null}
                    </td>
                    <td
                      className={`px-3 py-3 ${lowFloat ? "text-destructive font-semibold" : "text-muted-foreground"}`}
                    >
                      {row.meta_float === null ? "—" : money(row.meta_float)}
                    </td>
                    <td className="px-3 py-3">{money(row.mtd_consumed)}</td>
                    <td className="px-3 py-3 text-primary">{money(row.mtd_margin)}</td>
                    <td className="px-3 py-3 text-xs text-muted-foreground">
                      <span className="text-foreground">{row.sent}</span> sent ·{" "}
                      {row.delivered} delivered · {row.failed} failed
                    </td>
                    <td className="px-3 py-3 text-xs text-muted-foreground">
                      {number?.quality ? `${number.quality} · ` : ""}
                      {number?.tier === null || number?.tier === undefined
                        ? "Tier unknown"
                        : `Tier ${number.tier}`}
                    </td>
                    <td className="px-3 py-3">
                      {row.pending_topups > 0 ? (
                        <button
                          type="button"
                          onClick={() => setDrawer(true)}
                          className="rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-600"
                        >
                          {row.pending_topups} due
                        </button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <TopupsDrawer
        open={drawer}
        tasks={tasks}
        onClose={() => setDrawer(false)}
        onDone={() => void load()}
      />
    </div>
  );
}
