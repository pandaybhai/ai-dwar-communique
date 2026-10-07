import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { callApi } from "@/lib/whatsapp-client";
import { usePermissions } from "@/hooks/use-permissions";
import { NOT_ARCHIVED_DUPLICATE, STORE_PRODUCT_SOURCES, productsSummaryLine } from "@/lib/catalog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

type Summary = {
  total: number;
  website: number;
  store: number;
  lastUpdated: string | null;
  site: { id: string; status: string } | null;
};

/** Website reads that are queued or running. */
const READING = new Set(["pending", "syncing"]);

/**
 * The line under the Products heading: how many products, where they came
 * from, when they last changed — plus "Refresh from website", which is the
 * same "read changes" the Knowledge tab offers (same cooldown, same queue).
 */
export function ProductsSummary({ organizationId }: { organizationId: string }) {
  const { can } = usePermissions();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const count = (q: PromiseLike<{ count: number | null }>) => Promise.resolve(q).then((r) => r.count ?? 0);
    const base = () =>
      aidwar.from("products").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).or(NOT_ARCHIVED_DUPLICATE);
    const [total, website, store, latest, site] = await Promise.all([
      count(base()),
      count(base().eq("source", "crawl")),
      count(base().in("source", [...STORE_PRODUCT_SOURCES])),
      aidwar
        .from("products")
        .select("updated_at")
        .eq("organization_id", organizationId)
        .order("updated_at", { ascending: false })
        .limit(1),
      aidwar
        .from("knowledge_sources")
        .select("id, status")
        .eq("organization_id", organizationId)
        .eq("type", "website")
        .order("created_at", { ascending: false })
        .limit(1),
    ]);
    setSummary({
      total,
      website,
      store,
      lastUpdated: ((latest.data ?? []) as Array<{ updated_at: string | null }>)[0]?.updated_at ?? null,
      site: ((site.data ?? []) as Array<{ id: string; status: string }>)[0] ?? null,
    });
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refreshFromWebsite() {
    if (!summary?.site) return;
    setBusy(true);
    const { error } = await callApi("/api/ai/knowledge", {
      body: { organization_id: organizationId, action: "read_changes", source_id: summary.site.id },
    });
    setBusy(false);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success("Reading your website for changes. New products and photos show up here when it's done.");
    await load();
  }

  if (!summary) return <Skeleton className="-mt-5 mb-8 h-5 w-72" />;

  const reading = summary.site ? READING.has(summary.site.status) : false;
  return (
    <div className="-mt-5 mb-8 flex flex-wrap items-center gap-3">
      <p className="text-sm text-muted-foreground">{productsSummaryLine(summary)}</p>
      {summary.site && can("ai.configure") ? (
        <Button
          size="sm"
          variant="outline"
          className="rounded-full"
          disabled={busy || reading}
          onClick={() => void refreshFromWebsite()}
        >
          {busy || reading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          {reading ? "Reading your website…" : "Refresh from website"}
        </Button>
      ) : null}
    </div>
  );
}
