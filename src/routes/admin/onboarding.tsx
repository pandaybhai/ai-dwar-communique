import { useCallback, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Filter, LifeBuoy, RefreshCw, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, PageHeader } from "@/components/empty-state";
import { TableSkeleton } from "@/components/data-pagination";
import { callApi } from "@/lib/whatsapp-client";
import { FUNNEL_LABELS } from "@/lib/onboarding-journey";
import type { FunnelReport } from "@/lib/admin-onboarding.server";

const DESCRIPTION = "Sign-ups in the last 30 days, step by step, and where each one stopped.";

export const Route = createFileRoute("/admin/onboarding")({
  head: () => ({
    meta: [
      { title: "Onboarding funnel — AiDwar Admin" },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: "Onboarding funnel — AiDwar Admin" },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminOnboarding,
});

function day(value: string): string {
  return new Date(value).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Batch 40: no third-party tracking — this reads our own analytics_events. */
function AdminOnboarding() {
  const [report, setReport] = useState<FunnelReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error: err } = await callApi<FunnelReport>("/api/admin/onboarding?days=30", {
      method: "GET",
    });
    setLoading(false);
    if (err || !data) setError(err ?? "We couldn't load the funnel.");
    else {
      setError(null);
      setReport(data);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submitTemplate = async () => {
    setSubmitting(true);
    const { data, error: err } = await callApi<{ status: string | null; created: boolean }>(
      "/api/admin/onboarding",
      {
        body: { action: "submit_link_template" },
      },
    );
    setSubmitting(false);
    if (err) toast.error(err);
    else {
      toast.success(
        data?.created
          ? "Submitted to Meta for approval."
          : `Already there (${data?.status ?? "unknown"}).`,
      );
      await load();
    }
  };

  const max = Math.max(report?.summary.total ?? 0, 1);

  return (
    <>
      <PageHeader title="Onboarding funnel" description={DESCRIPTION} />
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" /> Refresh
        </Button>
        {report ? (
          <span className="text-sm text-muted-foreground">
            Resume-link nudge template:{" "}
            <span className="font-medium text-foreground">
              {report.linkTemplateStatus ?? "not submitted"}
            </span>
          </span>
        ) : null}
        {report && !report.linkTemplateStatus ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void submitTemplate()}
            disabled={submitting}
          >
            <Send className="h-4 w-4" aria-hidden="true" /> Submit it to Meta
          </Button>
        ) : null}
      </div>

      {loading && !report ? (
        <TableSkeleton rows={6} />
      ) : error ? (
        <ErrorState message={error} />
      ) : !report || report.summary.total === 0 ? (
        <EmptyState
          icon={Filter}
          title="No sign-ups yet"
          description="Sign-ups that start the new setup in the last 30 days appear here."
        />
      ) : (
        <div className="space-y-8">
          <section
            aria-labelledby="funnel-steps"
            className="rounded-2xl border border-border bg-card p-5 sm:p-6"
          >
            <h2 id="funnel-steps" className="text-base font-semibold">
              Step by step · {report.summary.total} sign-up{report.summary.total === 1 ? "" : "s"}
            </h2>
            <ol className="mt-5 space-y-3">
              {report.summary.steps.map((s) => (
                <li
                  key={s.step}
                  className="grid grid-cols-[9rem_1fr_6rem] items-center gap-3 text-sm sm:grid-cols-[11rem_1fr_9rem]"
                >
                  <span className="font-medium">{s.label}</span>
                  <span
                    className="relative h-7 overflow-hidden rounded-lg bg-muted"
                    aria-hidden="true"
                  >
                    <span
                      className="absolute inset-y-0 left-0 rounded-lg bg-primary"
                      style={{ width: `${(s.reached / max) * 100}%` }}
                    />
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    <span className="font-semibold text-foreground">{s.reached}</span>
                    {s.fromPrevious !== null ? ` · ${s.fromPrevious}% of previous` : ""}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <section
            aria-labelledby="funnel-stopped"
            className="rounded-2xl border border-border bg-card p-5 sm:p-6"
          >
            <h2 id="funnel-stopped" className="text-base font-semibold">
              Where each sign-up stopped
            </h2>
            <ul className="mt-4 flex flex-wrap gap-2">
              {report.summary.stoppedAt.map((s) => (
                <li key={s.step} className="rounded-full border border-border px-3 py-1.5 text-sm">
                  {s.label}: <span className="font-semibold tabular-nums">{s.count}</span>
                </li>
              ))}
            </ul>
          </section>

          <section
            aria-labelledby="funnel-signups"
            className="overflow-x-auto rounded-2xl border border-border bg-card"
          >
            <h2 id="funnel-signups" className="sr-only">
              Sign-ups
            </h2>
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Workspace</th>
                  <th className="px-4 py-3 font-medium">Started</th>
                  <th className="px-4 py-3 font-medium">Furthest step</th>
                  <th className="px-4 py-3 font-medium">Last activity</th>
                  <th className="px-4 py-3 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {report.signups.map((s) => (
                  <tr key={s.organizationId} className="border-t border-border">
                    <td className="px-4 py-3 font-medium">{s.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{day(s.startedAt)}</td>
                    <td className="px-4 py-3">{FUNNEL_LABELS[s.furthest]}</td>
                    <td className="px-4 py-3 text-muted-foreground">{day(s.lastAt)}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {s.callbackRequested ? (
                        <span className="inline-flex items-center gap-1 font-medium text-foreground">
                          <LifeBuoy className="h-3.5 w-3.5" aria-hidden="true" /> Asked for a call
                        </span>
                      ) : null}
                      {s.skippedConnect ? <span className="ml-2">Skipped connect</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}
    </>
  );
}
