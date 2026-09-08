import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { CreditCard, RefreshCw, Search, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, ErrorState, PageHeader } from "@/components/empty-state";
import { NoResults, TableSkeleton } from "@/components/data-pagination";
import { OrgBillingSheet } from "@/components/admin/org-billing-sheet";
import { callApi } from "@/lib/whatsapp-client";
import { money } from "@/lib/billing";
import { cn } from "@/lib/utils";
import type { CustomerRow } from "@/lib/admin-customers.server";

const DESCRIPTION = "Every workspace, where it is in onboarding, and who needs a nudge.";

export const Route = createFileRoute("/admin/customers")({
  head: () => ({
    meta: [
      { title: "Customers — AiDwar Admin" },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: "Customers — AiDwar Admin" },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminCustomers,
});

type Queue = "all" | "stuck" | "trial_ending" | "asked_human" | "locked";

const QUEUES: Array<{ key: Queue; label: string }> = [
  { key: "all", label: "All" },
  { key: "stuck", label: "Stuck in onboarding" },
  { key: "trial_ending", label: "Trial ending" },
  { key: "asked_human", label: "Asked for human" },
  { key: "locked", label: "Locked" },
];

function when(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function day(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

const STATUS_CLASS: Record<string, string> = {
  active: "bg-primary/10 text-primary",
  trial: "bg-amber-50 text-amber-800",
  locked: "bg-destructive/10 text-destructive",
  paused: "bg-muted text-muted-foreground",
  past_due: "bg-amber-50 text-amber-800",
};

function AdminCustomers() {
  const [rows, setRows] = useState<CustomerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [queue, setQueue] = useState<Queue>("all");
  const [search, setSearch] = useState("");
  const [billingFor, setBillingFor] = useState<CustomerRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error: err } = await callApi<{ customers: CustomerRow[] }>(
      "/api/admin/customers",
      { method: "GET" },
    );
    setLoading(false);
    if (err || !data) {
      setError(err ?? "We couldn't load the customer list.");
      return;
    }
    setError(null);
    setRows(data.customers);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const c: Record<Queue, number> = { all: 0, stuck: 0, trial_ending: 0, asked_human: 0, locked: 0 };
    for (const r of rows ?? []) {
      c.all += 1;
      for (const q of r.queues) c[q] += 1;
    }
    return c;
  }, [rows]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (rows ?? []).filter(
      (r) =>
        (queue === "all" || r.queues.includes(queue)) &&
        (!needle ||
          r.name.toLowerCase().includes(needle) ||
          (r.owner_phone ?? "").includes(needle) ||
          (r.owner_email ?? "").toLowerCase().includes(needle)),
    );
  }, [rows, queue, search]);

  return (
    <>
      <PageHeader title="Customers" description={DESCRIPTION} />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" className="rounded-full" onClick={() => void load()}>
          <RefreshCw className={cn("mr-2 h-3.5 w-3.5", loading && "animate-spin")} /> Refresh
        </Button>
        <Tabs value={queue} onValueChange={(v) => setQueue(v as Queue)}>
          <TabsList className="h-auto flex-wrap rounded-full">
            {QUEUES.map((q) => (
              <TabsTrigger key={q.key} value={q.key} className="rounded-full">
                {q.label}
                <span className="ml-1.5 rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">
                  {counts[q.key]}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="relative ml-auto w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name, phone or email"
            className="pl-9"
          />
        </div>
      </div>

      {loading && !rows ? (
        <TableSkeleton />
      ) : error ? (
        <ErrorState message={error} />
      ) : (rows ?? []).length === 0 ? (
        <EmptyState icon={Users} title="No customers yet" description="Sign-ups show up here as they happen." />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border/70 bg-background shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Workspace</th>
                  <th className="px-4 py-3 font-medium">Owner</th>
                  <th className="px-4 py-3 font-medium">Signed up</th>
                  <th className="px-4 py-3 font-medium">Wanted</th>
                  <th className="px-4 py-3 font-medium">Onboarding</th>
                  <th className="px-4 py-3 font-medium">Trial ends</th>
                  <th className="px-4 py-3 font-medium">Plan</th>
                  <th className="px-4 py-3 text-right font-medium">Credits</th>
                  <th className="px-4 py-3 font-medium">Last heard</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {visible.map((r) => (
                  <tr key={r.organization_id} className="transition-colors hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <div className="font-medium text-foreground">{r.name}</div>
                      {r.open_questions > 0 ? (
                        <div className="text-xs text-amber-700">
                          {r.open_questions} unanswered question{r.open_questions === 1 ? "" : "s"}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <div>{r.owner_phone ?? "—"}</div>
                      {r.owner_email ? (
                        <div className="max-w-[12rem] truncate text-xs text-muted-foreground">
                          {r.owner_email}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{day(r.signed_up_at)}</td>
                    <td className="px-4 py-3 capitalize">{r.attribution_plan ?? "—"}</td>
                    <td className="px-4 py-3">
                      {r.onboarding_status ? (
                        <>
                          <div className="capitalize">{r.onboarding_status}</div>
                          {r.onboarding_step ? (
                            <div className="text-xs text-muted-foreground">
                              {r.onboarding_step.replace(/_/g, " ")}
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {r.plan_name ? "—" : day(r.trial_ends_at)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          "inline-flex rounded-full px-2 py-0.5 text-xs font-semibold",
                          STATUS_CLASS[r.plan_status] ?? "bg-muted text-muted-foreground",
                        )}
                      >
                        {r.plan_name ?? "No plan"} · {r.plan_status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{money(r.wallet_balance)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{when(r.last_inbound_at)}</td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        className="rounded-full"
                        onClick={() => setBillingFor(r)}
                      >
                        <CreditCard className="mr-2 h-3.5 w-3.5" /> Billing
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {visible.length === 0 ? <NoResults message="Nobody in this queue right now." /> : null}
        </div>
      )}

      {billingFor ? (
        <OrgBillingSheet
          organizationId={billingFor.organization_id}
          organizationName={billingFor.name}
          open
          onClose={() => {
            setBillingFor(null);
            void load();
          }}
        />
      ) : null}
    </>
  );
}
