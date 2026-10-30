import { useEffect, useState } from "react";
import { callApi } from "@/lib/whatsapp-client";
import { Skeleton } from "@/components/ui/skeleton";
import type { DesignCounts } from "@/lib/aiden-workspace";

/**
 * Batch 53: Super Admin -> Feature Flags. Who stays on Classic and who on
 * Aiden Workspace (saved choices), switches in the last 30 days, and the
 * unlocked workspaces waiting for the release flag.
 */
export function DesignCountsCard({ releaseOn }: { releaseOn: boolean | null }) {
  const [counts, setCounts] = useState<DesignCounts | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    void callApi<DesignCounts>("/api/admin/design?days=30", { method: "GET" }).then(({ data }) => {
      if (data) setCounts(data);
      else setError(true);
    });
  }, []);

  const stat = (label: string, value: number) => (
    <div className="rounded-xl bg-muted/40 px-4 py-3">
      <p className="text-2xl font-semibold tabular-nums text-foreground">{value}</p>
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );

  return (
    <section
      aria-labelledby="design-counts-title"
      className="mb-8 space-y-4 rounded-2xl border border-border/70 bg-card p-5 shadow-sm"
    >
      <div className="space-y-1">
        <h2 id="design-counts-title" className="text-lg font-semibold text-foreground">
          Aiden Workspace and Classic
        </h2>
        <p className="text-sm text-muted-foreground">
          {releaseOn
            ? "Released: unlocked workspaces open in Aiden Workspace and everyone has the switch in their avatar menu."
            : "Not released yet (flag aiden_workspace is off): only workspaces with a new_design override see Aiden Workspace, and nobody has the switch."}
        </p>
      </div>
      {error ? (
        <p className="text-sm text-muted-foreground">We couldn't load the counts. Please refresh.</p>
      ) : !counts ? (
        <Skeleton className="h-20 w-full rounded-xl" />
      ) : (
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {stat("people chose Aiden Workspace", counts.people.aiden_workspace)}
          {stat("people chose Classic", counts.people.classic)}
          {stat(`switches to Aiden Workspace, ${counts.days} days`, counts.switches.to_aiden_workspace)}
          {stat(`switches to Classic, ${counts.days} days`, counts.switches.to_classic)}
          {stat("workspaces unlocked (Aiden switched on)", counts.unlocked_workspaces)}
        </div>
      )}
    </section>
  );
}
