import { useCallback, useEffect, useState } from "react";
import { BookOpen, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { callApi } from "@/lib/whatsapp-client";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { EmbeddedSignupButton } from "@/components/whatsapp-embedded-signup";

type Catalog = {
  catalog_id: string;
  catalog_name: string | null;
  status: string;
  last_sync_at: string | null;
  pushed_count: number;
  rejected_count: number;
  last_error: string | null;
} | null;

type Status = {
  connected: boolean;
  scopes_ok: boolean;
  granted_scopes?: string[];
  catalog?: Catalog;
};

/**
 * Catalogue controls for one connected number. The enable button only appears
 * when Meta actually granted catalogue permission for this connection —
 * otherwise the owner is asked to reconnect the number.
 */
export function CatalogCard({
  orgId,
  accountId,
  canManage,
  onReconnected,
}: {
  orgId: string;
  accountId: string;
  canManage: boolean;
  onReconnected: () => Promise<void>;
}) {
  const { enabled: flagOn, loading: flagLoading } = useFeatureFlag("whatsapp_catalog");
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<"enable" | "sync" | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await callApi<Status>("/api/whatsapp/catalog", {
      body: { organization_id: orgId, whatsapp_account_id: accountId, action: "status" },
    });
    setStatus(data);
    setLoading(false);
  }, [orgId, accountId]);

  useEffect(() => {
    if (flagOn) void load();
  }, [flagOn, load]);

  if (flagLoading || !flagOn) return null;

  async function run(action: "enable" | "sync") {
    setWorking(action);
    const { data, error } = await callApi<{
      catalog_id?: string;
      pushed?: number;
      rejected?: number;
      eligible?: number;
    }>("/api/whatsapp/catalog", {
      body: { organization_id: orgId, whatsapp_account_id: accountId, action },
    });
    setWorking(null);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success(
      action === "enable"
        ? "Catalogue ready on your business account"
        : `${data?.pushed ?? 0} product${data?.pushed === 1 ? "" : "s"} sent${
            data?.rejected ? `, ${data.rejected} refused by Meta` : ""
          }`,
    );
    await load();
  }

  const catalog = status?.catalog ?? null;

  return (
    <div className="mt-6 rounded-xl border border-border/70 bg-muted/30 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <BookOpen className="h-4 w-4" />
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">Product catalogue</p>
            {loading ? (
              <Skeleton className="mt-2 h-4 w-56" />
            ) : !status?.scopes_ok ? (
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                Reconnect this number to enable the WhatsApp catalogue — the connection doesn't
                include catalogue permission yet.
              </p>
            ) : catalog ? (
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                Catalogue {catalog.catalog_id} ·{" "}
                {catalog.last_sync_at
                  ? `${catalog.pushed_count} product${catalog.pushed_count === 1 ? "" : "s"} sent${
                      catalog.rejected_count ? `, ${catalog.rejected_count} refused` : ""
                    }`
                  : "nothing sent yet"}
              </p>
            ) : (
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                Create a catalogue on your business account and send products that have a price and
                a picture.
              </p>
            )}
            {catalog?.last_error ? (
              <p className="mt-2 max-w-md text-xs text-destructive">{catalog.last_error}</p>
            ) : null}
          </div>
        </div>

        {loading ? null : !status?.scopes_ok ? (
          canManage ? (
            <EmbeddedSignupButton orgId={orgId} onConnected={onReconnected} />
          ) : null
        ) : canManage ? (
          <div className="flex flex-wrap items-center gap-2">
            {catalog ? (
              <Badge variant="outline" className="rounded-full">
                {catalog.status}
              </Badge>
            ) : null}
            {!catalog ? (
              <Button
                className="rounded-full"
                disabled={working !== null}
                onClick={() => void run("enable")}
              >
                {working === "enable" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Enable WhatsApp catalogue
              </Button>
            ) : (
              <Button
                variant="outline"
                className="rounded-full"
                disabled={working !== null}
                onClick={() => void run("sync")}
              >
                {working === "sync" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Sync products
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
