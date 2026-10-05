import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Loader2, RefreshCw, ShoppingCart } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { callApi } from "@/lib/whatsapp-client";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { usePermissions } from "@/hooks/use-permissions";
import { relativeTime, whatsappShopState, type WhatsAppShopRow } from "@/lib/catalog";
import { CatalogCard } from "@/components/whatsapp-catalog-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";

type Account = { id: string; waba_id: string | null; is_default: boolean | null };

/**
 * WhatsApp shop = the Meta catalogue on a WhatsApp number. Connecting reuses
 * the guided catalogue setup from Settings → WhatsApp (same API, same steps);
 * "Sync now" is the same sync/refresh that card runs.
 */
export function WhatsAppShopCard({ organizationId }: { organizationId: string }) {
  const { enabled: flagOn, loading: flagLoading } = useFeatureFlag("whatsapp_catalog");
  const { can } = usePermissions();
  const canManage = can("settings.whatsapp");
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [rows, setRows] = useState<WhatsAppShopRow[]>([]);
  const [connectOpen, setConnectOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    const [{ data: numbers }, { data: catalogs }] = await Promise.all([
      aidwar.from("whatsapp_accounts").select("id, waba_id, is_default").eq("organization_id", organizationId),
      aidwar
        .from("whatsapp_catalogs")
        .select("waba_id, status, mode, pushed_count, last_sync_at")
        .eq("organization_id", organizationId),
    ]);
    setAccounts((numbers as Account[] | null) ?? []);
    setRows((catalogs as WhatsAppShopRow[] | null) ?? []);
  }, [organizationId]);

  useEffect(() => {
    if (flagOn) void load();
  }, [flagOn, load]);

  if (flagLoading || !flagOn) return null;

  const shop = whatsappShopState(rows);
  const list = accounts ?? [];
  const shopAccount = shop.row ? (list.find((a) => a.waba_id === shop.row!.waba_id) ?? null) : null;
  const setupAccount = list.find((a) => a.is_default) ?? list[0] ?? null;

  async function syncNow() {
    if (!shopAccount || !shop.row) return;
    const linked = shop.row.mode === "linked";
    setSyncing(true);
    const { data, error } = await callApi<{ pushed?: number; rejected?: number; removed?: number; imported?: number }>(
      "/api/whatsapp/catalog",
      {
        body: {
          organization_id: organizationId,
          whatsapp_account_id: shopAccount.id,
          action: linked ? "refresh" : "sync",
        },
      },
    );
    setSyncing(false);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success(
      linked
        ? `${data?.imported ?? 0} product${data?.imported === 1 ? "" : "s"} read from your WhatsApp shop`
        : `${data?.pushed ?? 0} sent · ${data?.removed ?? 0} removed · ${data?.rejected ?? 0} refused`,
    );
    await load();
  }

  return (
    <div className="mb-6 rounded-2xl border border-border/70 bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ShoppingCart className="h-4 w-4" />
          </span>
          <div>
            {accounts === null ? (
              <Skeleton className="mt-1 h-4 w-56" />
            ) : shop.connected ? (
              <>
                <p className="text-sm font-semibold text-foreground">WhatsApp shop - connected</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {shop.synced.toLocaleString("en-IN")} product{shop.synced === 1 ? "" : "s"} synced · last synced{" "}
                  {relativeTime(shop.lastSynced)}
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold text-foreground">WhatsApp shop - not connected</p>
                <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                  Let customers browse your products, add to cart and send an order inside WhatsApp. We copy your
                  products into your Meta catalogue for you - no manual upload.
                </p>
              </>
            )}
          </div>
        </div>

        {accounts === null || !canManage ? null : shop.connected ? (
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="rounded-full">
              Connected
            </Badge>
            <Button
              variant="outline"
              className="rounded-full"
              disabled={syncing || !shopAccount}
              onClick={() => void syncNow()}
            >
              {syncing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Sync now
            </Button>
          </div>
        ) : setupAccount ? (
          <Button className="rounded-full" onClick={() => setConnectOpen(true)}>
            Connect WhatsApp shop
          </Button>
        ) : (
          <Button variant="outline" className="rounded-full" asChild>
            <Link to="/app/settings">Connect WhatsApp first</Link>
          </Button>
        )}
      </div>

      <Dialog
        open={connectOpen}
        onOpenChange={(open) => {
          setConnectOpen(open);
          if (!open) void load();
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Connect WhatsApp shop</DialogTitle>
          </DialogHeader>
          {setupAccount ? (
            <CatalogCard orgId={organizationId} accountId={setupAccount.id} canManage={canManage} onReconnected={load} />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
