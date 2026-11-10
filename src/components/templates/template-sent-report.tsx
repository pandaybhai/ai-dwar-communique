import { useCallback, useEffect, useMemo, useState } from "react";
import { CornerDownRight, Download, Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { SendFailureSummarySwitch } from "@/components/templates/send-failure-summary-switch";
import { aidwar } from "@/integrations/aidwar/client";
import { usePermissions } from "@/hooks/use-permissions";
import {
  NO_SEND_FILTERS,
  SEND_SOURCES,
  SEND_SOURCE_LABEL,
  SEND_STATUSES,
  sendStatusLabel,
  sendsCsv,
  type SendFilters,
  type SendLine,
  type SendTotals,
} from "@/lib/template-sends";
import { loadAllTemplateSends, loadTemplateSends } from "@/lib/template-sends-data";

/**
 * Batch 63 (C): a template's "Sent" view, in both designs (Classic's
 * Templates list and Aiden Workspace's gallery open this same sheet). Every
 * send of the template from any source — API, campaign, flow, Inbox — read
 * from the messages rows through the member's own client. An API send's
 * copies sit under the customer's send. Read-only, except the daily summary
 * switch (POST /api/template-sends, settings.manage).
 */

const STATUS_CLASS: Record<string, string> = {
  pending: "border-border bg-muted text-muted-foreground",
  sent: "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  delivered: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  read: "border-emerald-600/30 bg-emerald-600/15 text-emerald-800 dark:text-emerald-200",
  failed: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  // Batch 67: refused before it was sent (nothing reached WhatsApp).
  refused: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200",
};

function when(at: string): string {
  const d = new Date(at);
  return Number.isFinite(d.getTime())
    ? d.toLocaleString("en-IN", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
}

function StatusPill({ line }: { line: SendLine }) {
  return (
    <span
      data-status={line.status}
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_CLASS[line.status] ?? STATUS_CLASS["pending"]}`}
    >
      {sendStatusLabel(line.status)}
    </span>
  );
}

function SendItem({ line, nested = false }: { line: SendLine; nested?: boolean }) {
  return (
    <li
      data-testid={nested ? "sent-copy" : "sent-line"}
      className={
        nested
          ? "flex flex-col gap-1 border-t border-dashed border-border/70 py-2 pl-6 sm:grid sm:grid-cols-[8.5rem_6rem_1fr_9rem_1fr] sm:items-start sm:gap-3 sm:pl-0"
          : "flex flex-col gap-1 py-3 sm:grid sm:grid-cols-[8.5rem_6rem_1fr_9rem_1fr] sm:items-start sm:gap-3"
      }
    >
      <span className="text-xs text-muted-foreground sm:text-sm">{when(line.at)}</span>
      <span className="text-xs text-muted-foreground sm:text-sm">
        {nested ? (
          <span className="inline-flex items-center gap-1">
            <CornerDownRight className="h-3 w-3" aria-hidden="true" /> Copy
          </span>
        ) : (
          SEND_SOURCE_LABEL[line.source]
        )}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">{line.customer}</span>
        {line.phone && line.phone !== line.customer ? (
          <span className="block truncate text-xs text-muted-foreground">{line.phone}</span>
        ) : null}
      </span>
      <span
        className="min-w-0 truncate text-xs text-muted-foreground sm:text-sm"
        title={line.reference ?? undefined}
      >
        {line.reference ?? "—"}
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <StatusPill line={line} />
        {line.reason ? (
          <span
            className={`text-xs ${line.status === "refused" ? "text-amber-800 dark:text-amber-200" : "text-red-700 dark:text-red-300"}`}
          >
            {line.reason}
          </span>
        ) : null}
      </span>
    </li>
  );
}

function Totals({ totals }: { totals: SendTotals | null }) {
  const tiles: Array<[string, number | null]> = [
    ["Sent", totals?.sent ?? null],
    ["Delivered", totals?.delivered ?? null],
    ["Read", totals?.read ?? null],
    ["Failed", totals?.failed ?? null],
    ["Refused", totals?.refused ?? null],
    ["Copies sent", totals?.copies ?? null],
  ];
  return (
    <dl className="grid grid-cols-3 gap-2 sm:grid-cols-6" data-testid="sent-totals">
      {tiles.map(([label, value]) => (
        <div key={label} className="rounded-xl border border-border/70 bg-muted/30 px-3 py-2">
          <dt className="text-[11px] text-muted-foreground">{label}</dt>
          <dd
            className={`text-lg font-semibold tabular-nums ${label === "Failed" && value ? "text-red-700 dark:text-red-300" : label === "Refused" && value ? "text-amber-800 dark:text-amber-200" : "text-foreground"}`}
          >
            {value === null ? "…" : value.toLocaleString("en-IN")}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function TemplateSentReport({
  organizationId,
  templateName,
  open,
  onOpenChange,
  noTemplate = false,
}: {
  organizationId: string;
  templateName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Batch 67: the API sends refused without a template name ("Refused (no template)"). */
  noTemplate?: boolean;
}) {
  // The report's subject: a template, or (noTemplate) the refusals that named none.
  const subject: string | null = noTemplate ? null : templateName;
  const ready = noTemplate || Boolean(templateName);
  const { can } = usePermissions();
  const [filters, setFilters] = useState<SendFilters>(NO_SEND_FILTERS);
  const [lines, setLines] = useState<SendLine[] | null>(null);
  const [totals, setTotals] = useState<SendTotals | null>(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(
    async (nextPage: number) => {
      if (!ready) return;
      setBusy(true);
      const r = await loadTemplateSends(aidwar as never, {
        organizationId,
        templateName: subject,
        filters,
        page: nextPage,
      });
      setBusy(false);
      setError(r.error);
      setTotals(r.totals);
      setHasMore(r.hasMore);
      setPage(nextPage);
      setLines((prev) => (nextPage === 0 || !prev ? r.lines : [...prev, ...r.lines]));
    },
    [organizationId, subject, ready, filters],
  );

  useEffect(() => {
    if (open) void load(0);
  }, [open, load]);

  const set = (patch: Partial<SendFilters>) => setFilters((f) => ({ ...f, ...patch }));

  const download = async () => {
    if (!ready) return;
    setExporting(true);
    const all = await loadAllTemplateSends(aidwar as never, {
      organizationId,
      templateName: subject,
      filters,
    });
    setExporting(false);
    const label = subject ?? "no-template";
    const blob = new Blob([sendsCsv(subject ?? "(no template)", all)], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = noTemplate ? "refused-no-template.csv" : `${label}-sent.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const filtered = useMemo(
    () => JSON.stringify(filters) !== JSON.stringify(NO_SEND_FILTERS),
    [filters],
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full overflow-y-auto sm:max-w-4xl"
        data-testid="template-sent-report"
      >
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Send className="h-4 w-4 text-primary" aria-hidden="true" />{" "}
            {noTemplate ? "Refused (no template)" : <>Sent — {templateName}</>}
          </SheetTitle>
          <SheetDescription>
            {noTemplate
              ? "API sends we refused before sending that named no template (for example a free-form message outside the 24-hour window). Nothing was sent."
              : "Every send of this template: API, campaigns, flows and the Inbox. Copies of an API send are listed under it. Refused: an API send we refused before sending, with the reason."}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          <Totals totals={totals} />

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_1fr_1fr_1fr_auto] sm:items-end">
            <div className="space-y-1">
              <Label htmlFor="sent-from" className="text-xs">
                From
              </Label>
              <Input
                id="sent-from"
                type="date"
                value={filters.from ?? ""}
                onChange={(e) => set({ from: e.target.value || null })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sent-to" className="text-xs">
                To
              </Label>
              <Input
                id="sent-to"
                type="date"
                value={filters.to ?? ""}
                onChange={(e) => set({ to: e.target.value || null })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sent-source" className="text-xs">
                Source
              </Label>
              <select
                id="sent-source"
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={filters.source}
                onChange={(e) => set({ source: e.target.value as SendFilters["source"] })}
              >
                <option value="all">All sources</option>
                {SEND_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {SEND_SOURCE_LABEL[s]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="sent-status" className="text-xs">
                Status
              </Label>
              <select
                id="sent-status"
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={filters.failedOnly ? "failed" : filters.status}
                disabled={filters.failedOnly}
                onChange={(e) => set({ status: e.target.value as SendFilters["status"] })}
              >
                <option value="all">Any status</option>
                {SEND_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {sendStatusLabel(s)}
                  </option>
                ))}
              </select>
            </div>
            <label className="col-span-2 flex h-9 items-center gap-2 text-sm sm:col-span-1">
              <Switch
                checked={filters.failedOnly}
                onCheckedChange={(v) => set({ failedOnly: v })}
                aria-label="Failed only"
              />
              Failed only
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            {filtered ? (
              <Button variant="ghost" size="sm" onClick={() => setFilters(NO_SEND_FILTERS)}>
                Clear filters
              </Button>
            ) : (
              <span />
            )}
            {can("contacts.export") ? (
              <Button
                variant="outline"
                size="sm"
                disabled={exporting || !lines?.length}
                onClick={() => void download()}
              >
                {exporting ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Download className="mr-2 h-4 w-4" />
                )}
                Download CSV
              </Button>
            ) : null}
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <div className="rounded-xl border border-border/70 bg-card px-3">
            <div className="hidden border-b border-border/70 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:grid sm:grid-cols-[8.5rem_6rem_1fr_9rem_1fr] sm:gap-3">
              <span>Date</span>
              <span>Source</span>
              <span>Customer</span>
              <span>Reference</span>
              <span>Status</span>
            </div>
            {lines === null ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
            ) : lines.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {filtered
                  ? "No sends match these filters."
                  : noTemplate
                    ? "No refused API sends without a template."
                    : "This template hasn't been sent yet."}
              </p>
            ) : (
              <ul className="divide-y divide-border/70">
                {lines.map((line) => (
                  <li key={line.id} className="list-none">
                    <ul>
                      <SendItem line={line} />
                      {line.copies.map((c) => (
                        <SendItem key={c.id} line={c} nested />
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {hasMore ? (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void load(page + 1)}
              >
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Show more
              </Button>
            </div>
          ) : null}

          {open ? <SendFailureSummarySwitch organizationId={organizationId} /> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
