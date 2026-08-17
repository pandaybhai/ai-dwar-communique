import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Clock, Inbox, MinusCircle, XCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { aidwar } from "@/integrations/aidwar/client";
import { NoResults, Pagination, TableSkeleton } from "@/components/data-pagination";
import { ErrorState, EmptyState } from "@/components/empty-state";
import { Label } from "@/components/ui/label";
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
  flowTitle,
  formatDateTime,
  stepLabel,
  type FlowRow,
  type ScheduledSendRow,
  type SendStatus,
} from "@/lib/flows";

const PAGE_SIZE = 25;

const SELECT =
  "id, organization_id, flow_id, flow_step_id, contact_id, trigger_type, send_after, status, cancel_reason, error, created_at, updated_at, contacts(name, phone), flows(key, name), flow_steps(step_order, condition)";

/** Status is never colour alone — every one carries an icon and a word. */
const STATUS_ICONS: Record<SendStatus, LucideIcon> = {
  scheduled: Clock,
  sent: Check,
  cancelled: MinusCircle,
  failed: XCircle,
  skipped: AlertTriangle,
};

function StatusPill({ status }: { status: SendStatus }) {
  const Icon = STATUS_ICONS[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${STATUS_CLASSES[status]}`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {STATUS_LABELS[status]}
    </span>
  );
}

/**
 * What actually went out. A skip or a "not sent" is only useful if it says why
 * in plain words, so the reason is never collapsed away.
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
      setError("We couldn't load this list. Please try again.");
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

  const describe = (r: ScheduledSendRow) => {
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
    const reason =
      cancelReasonLabel(r.cancel_reason) ??
      (r.error ? "Didn't go through — we'll try again" : "—");
    const who = r.contacts?.name?.trim() || r.contacts?.phone || "Unknown customer";
    const flowName = r.flows ? flowTitle({ key, name: r.flows.name }) : "—";
    return { step, reason, who, flowName };
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row">
        {!flowId && flows?.length ? (
          <div className="space-y-1.5">
            <Label htmlFor="log-flow">Show</Label>
            <Select
              value={flowFilter}
              onValueChange={(v) => {
                setFlowFilter(v);
                setPage(0);
              }}
            >
              <SelectTrigger id="log-flow" className="min-h-11 sm:w-60">
                <SelectValue placeholder="Everything" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Everything</SelectItem>
                {flows.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {flowTitle(f)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor="log-status">What happened</Label>
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v);
              setPage(0);
            }}
          >
            <SelectTrigger id="log-status" className="min-h-11 sm:w-52">
              <SelectValue placeholder="Anything" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Anything</SelectItem>
              {(Object.keys(STATUS_LABELS) as SendStatus[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {STATUS_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {rows === null ? (
        <TableSkeleton />
      ) : rows.length === 0 && total === 0 && status === "all" && flowFilter === "all" ? (
        <EmptyState
          icon={Inbox}
          title="No messages sent yet"
          description="Turn on a flow above and they'll appear here — every message we send, skip or hold back, with the reason in plain words."
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
          {/* Phone: one card per message, no sideways scrolling. */}
          <ul className="list-none divide-y divide-border/60 p-0 md:hidden">
            {rows.map((r) => {
              const d = describe(r);
              return (
                <li key={r.id} className="space-y-2 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="min-w-0 break-words font-medium text-foreground">{d.who}</p>
                    <StatusPill status={r.status} />
                  </div>
                  {r.contacts?.name && r.contacts.phone ? (
                    <p className="text-sm text-muted-foreground">{r.contacts.phone}</p>
                  ) : null}
                  <p className="text-sm text-muted-foreground">
                    {flowId ? d.step : `${d.flowName} · ${d.step}`}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {formatDateTime(r.send_after, timezone)}
                  </p>
                  {d.reason !== "—" ? (
                    <p className="text-sm text-foreground">{d.reason}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>

          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Customer</TableHead>
                  {flowId ? null : <TableHead scope="col">Flow</TableHead>}
                  <TableHead scope="col">Message</TableHead>
                  <TableHead scope="col">What happened</TableHead>
                  <TableHead scope="col">When</TableHead>
                  <TableHead scope="col">Why</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const d = describe(r);
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium text-foreground">
                        {d.who}
                        {r.contacts?.name && r.contacts.phone ? (
                          <span className="block text-xs font-normal text-muted-foreground">
                            {r.contacts.phone}
                          </span>
                        ) : null}
                      </TableCell>
                      {flowId ? null : (
                        <TableCell className="text-sm">{d.flowName}</TableCell>
                      )}
                      <TableCell className="text-sm text-muted-foreground">{d.step}</TableCell>
                      <TableCell>
                        <StatusPill status={r.status} />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDateTime(r.send_after, timezone)}
                      </TableCell>
                      <TableCell className="max-w-[20rem] text-sm text-foreground">
                        {d.reason}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {rows.length === 0 ? (
            <NoResults message="Nothing matches what you picked. Try 'Everything'." />
          ) : (
            <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
          )}
        </div>
      )}
    </div>
  );
}
