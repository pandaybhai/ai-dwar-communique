import { useCallback, useEffect, useState } from "react";
import { Inbox } from "lucide-react";
import { aidwar } from "@/integrations/aidwar/client";
import { NoResults, Pagination, TableSkeleton } from "@/components/data-pagination";
import { ErrorState, EmptyState } from "@/components/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  STATUS_CLASSES,
  STATUS_LABELS,
  cancelReasonLabel,
  formatDateTime,
  stepLabel,
  type FlowRow,
  type ScheduledSendRow,
  type SendStatus,
} from "@/lib/flows";

const PAGE_SIZE = 25;

const SELECT =
  "id, organization_id, flow_id, flow_step_id, contact_id, trigger_type, send_after, status, cancel_reason, error, created_at, updated_at, contacts(name, phone), flows(key, name), flow_steps(step_order, condition)";

/**
 * The sends log. A skip or a cancellation is only useful if it says why, so the
 * reason column is never collapsed away.
 */
export function SendsLog({
  organizationId,
  flowId,
  flows,
  timezone,
}: {
  organizationId: string;
  /** Scope to one flow; omit for the combined workspace view. */
  flowId?: string;
  flows?: FlowRow[];
  timezone?: string;
}) {
  const [status, setStatus] = useState<string>("all");
  const [flowFilter, setFlowFilter] = useState<string>("all");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<ScheduledSendRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    let query = aidwar
      .from("scheduled_sends")
      .select(SELECT, { count: "exact" })
      .eq("organization_id", organizationId)
      .order("send_after", { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

    if (flowId) query = query.eq("flow_id", flowId);
    else if (flowFilter !== "all") query = query.eq("flow_id", flowFilter);
    if (status !== "all") query = query.eq("status", status);

    const { data, count, error: err } = await query;
    if (err) {
      setError("We couldn't load the sends log. Please try again.");
      setRows([]);
      return;
    }
    setRows((data as unknown as ScheduledSendRow[]) ?? []);
    setTotal(count ?? 0);
  }, [organizationId, flowId, flowFilter, status, page]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorState message={error} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row">
        {!flowId && flows?.length ? (
          <Select
            value={flowFilter}
            onValueChange={(v) => {
              setFlowFilter(v);
              setPage(0);
            }}
          >
            <SelectTrigger className="sm:w-56">
              <SelectValue placeholder="All flows" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All flows</SelectItem>
              {flows.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Select
          value={status}
          onValueChange={(v) => {
            setStatus(v);
            setPage(0);
          }}
        >
          <SelectTrigger className="sm:w-44">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {(Object.keys(STATUS_LABELS) as SendStatus[]).map((k) => (
              <SelectItem key={k} value={k}>
                {STATUS_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {rows === null ? (
        <TableSkeleton />
      ) : rows.length === 0 && total === 0 && status === "all" && flowFilter === "all" ? (
        <EmptyState
          icon={Inbox}
          title="Nothing scheduled yet"
          description="Once a flow is enabled and a store event comes in, every scheduled, sent, skipped and cancelled message shows up here with its reason."
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contact</TableHead>
                  {flowId ? null : <TableHead>Flow</TableHead>}
                  <TableHead>Step</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Send after</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const key = r.flows?.key ?? "";
                  const step = r.flow_steps
                    ? stepLabel(key, {
                        id: r.flow_step_id,
                        flow_id: r.flow_id,
                        step_order: r.flow_steps.step_order,
                        delay_minutes: 0,
                        template_id: null,
                        condition: r.flow_steps.condition,
                        is_enabled: true,
                      })
                    : "—";
                  const reason = cancelReasonLabel(r.cancel_reason) ?? r.error ?? "—";
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium text-foreground">
                        {r.contacts?.name?.trim() || r.contacts?.phone || "Unknown contact"}
                        {r.contacts?.name && r.contacts.phone ? (
                          <span className="block text-xs font-normal text-muted-foreground">
                            {r.contacts.phone}
                          </span>
                        ) : null}
                      </TableCell>
                      {flowId ? null : (
                        <TableCell className="text-sm">{r.flows?.name ?? "—"}</TableCell>
                      )}
                      <TableCell className="text-sm text-muted-foreground">{step}</TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${STATUS_CLASSES[r.status]}`}
                        >
                          {STATUS_LABELS[r.status]}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDateTime(r.send_after, timezone)}
                      </TableCell>
                      <TableCell className="max-w-[18rem] text-sm text-muted-foreground">
                        {reason}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          {rows.length === 0 ? (
            <NoResults message="No sends match these filters." />
          ) : (
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={total}
              onPageChange={setPage}
            />
          )}
        </div>
      )}
    </div>
  );
}
