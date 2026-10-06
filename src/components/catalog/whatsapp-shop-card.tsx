import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, Loader2, RefreshCw, ShoppingCart } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { callApi } from "@/lib/whatsapp-client";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { usePermissions } from "@/hooks/use-permissions";
import {
  relativeTime,
  shopVisibilityState,
  whatsappShopState,
  type ShopVisibilityCheck,
  type WhatsAppShopRow,
} from "@/lib/catalog";
import { CatalogCard } from "@/components/whatsapp-catalog-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";

type Account = { id: string; waba_id: string | null; is_default: boolean | null };

type SyncResult = {
  pushed?: number;
  rejected?: number;
  removed?: number;
  imported?: number;
  last_sync_at?: string;
  catalog?: Partial<WhatsAppShopRow> | null;
  visibility?: ShopVisibilityCheck | null;
};

const SYNC_TOAST = "whatsapp-shop-sync";

/**
 * WhatsApp shop = the Meta catalogue on a WhatsApp number. Connecting reuses
 * the guided catalogue setup from Settings → WhatsApp (same API, same steps);
 * "Sync now" is the same sync/refresh that card runs. After a sync the card
 * shows what Meta says: visible to customers, or what is left to do.
 */
export function WhatsAppShopCard({ organizationId }: { organizationId: string }) {
  const { enabled: flagOn, loading: flagLoading } = useFeatureFlag("whatsapp_catalog");
  const { can } = usePermissions();
  const canManage = can("settings.whatsapp");
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [rows, setRows] = useState<WhatsAppShopRow[]>([]);
  const [connectOpen, setConnectOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [turningOn, setTurningOn] = useState(false);
  const [check, setCheck] = useState<ShopVisibilityCheck | null>(null);
  const [showTodo, setShowTodo] = useState(false);

  const load = useCallback(async () => {
    const [{ data: numbers }, { data: catalogs }] = await Promise.all([
      aidwar.from("whatsapp_accounts").select("id, waba_id, is_default").eq("organization_id", organizationId),
      aidwar
        .from("whatsapp_catalogs")
        .select("waba_id, status, mode, pushed_count, last_sync_at, catalog_name, is_catalog_visible, is_cart_enabled")
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

  /** The catalogue row as the server returned it, so the card never shows an old count or time. */
  function applyRow(wabaId: string, patch: Partial<WhatsAppShopRow> | null | undefined) {
    if (!patch) return;
    setRows((current) => current.map((r) => (r.waba_id === wabaId ? { ...r, ...patch, waba_id: r.waba_id } : r)));
  }

  async function syncNow() {
    if (!shopAccount || !shop.row || syncing) return;
    const linked = shop.row.mode === "linked";
    const wabaId = shop.row.waba_id;
    setSyncing(true);
    toast.loading(linked ? "Reading your WhatsApp shop…" : "Syncing your products to WhatsApp…", {
      id: SYNC_TOAST,
      description: "This can take up to a minute.",
    });
    try {
      const { data, error } = await callApi<SyncResult>("/api/whatsapp/catalog", {
        body: {
          organization_id: organizationId,
          whatsapp_account_id: shopAccount.id,
          action: linked ? "refresh" : "sync",
        },
      });
      if (error) {
        toast.error(error, { id: SYNC_TOAST, description: undefined });
        return;
      }
      applyRow(wabaId, {
        ...(data?.last_sync_at ? { last_sync_at: data.last_sync_at } : {}),
        pushed_count: linked ? (data?.imported ?? 0) : (data?.pushed ?? 0),
        ...(data?.catalog ?? {}),
      });
      if (data?.visibility) setCheck(data.visibility);
      toast.success(
        linked
          ? `${data?.imported ?? 0} product${data?.imported === 1 ? "" : "s"} read from your WhatsApp shop`
          : `${data?.pushed ?? 0} sent · ${data?.removed ?? 0} removed · ${data?.rejected ?? 0} refused`,
        {
          id: SYNC_TOAST,
          description: data?.visibility
            ? data.visibility.visible
              ? "Visible to customers."
              : "Not visible to customers yet — see what to do on the card."
            : undefined,
        },
      );
    } catch {
      toast.error("We couldn't reach the server. Check your connection and try again.", {
        id: SYNC_TOAST,
        description: undefined,
      });
    } finally {
      setSyncing(false);
    }
    void load();
  }

  async function checkAgain() {
    if (!shopAccount || !shop.row) return;
    const wabaId = shop.row.waba_id;
    setChecking(true);
    try {
      const { data, error } = await callApi<{ visibility?: ShopVisibilityCheck; catalog?: Partial<WhatsAppShopRow> | null }>(
        "/api/whatsapp/catalog",
        { body: { organization_id: organizationId, whatsapp_account_id: shopAccount.id, action: "check_visibility" } },
      );
      if (error) {
        toast.error(error);
        return;
      }
      if (data?.visibility) setCheck(data.visibility);
      applyRow(wabaId, data?.catalog ?? null);
      toast.success(data?.visibility?.visible ? "Visible to customers" : "Checked with Meta — not visible yet");
    } catch {
      toast.error("We couldn't reach the server. Check your connection and try again.");
    } finally {
      setChecking(false);
    }
  }

  async function turnOnShopButton() {
    if (!shopAccount) return;
    setTurningOn(true);
    try {
      const { error } = await callApi("/api/whatsapp/catalog", {
        body: {
          organization_id: organizationId,
          whatsapp_account_id: shopAccount.id,
          action: "commerce_settings",
          is_catalog_visible: true,
          is_cart_enabled: true,
        },
      });
      if (error) {
        toast.error(error);
        return;
      }
    } catch {
      toast.error("We couldn't reach the server. Check your connection and try again.");
      return;
    } finally {
      setTurningOn(false);
    }
    await checkAgain();
  }

  const visibility = shopVisibilityState(shop.row, check);

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
                {visibility.visible ? (
                  <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-primary">
                    <CheckCircle2 className="h-4 w-4" /> Visible to customers
                  </p>
                ) : (
                  <div className="mt-1 text-sm">
                    <button
                      type="button"
                      className="font-medium text-amber-700 underline-offset-2 hover:underline dark:text-amber-400"
                      onClick={() => setShowTodo((v) => !v)}
                    >
                      Not visible yet - what to do
                    </button>
                    {showTodo ? (
                      <ol className="mt-2 max-w-xl list-decimal space-y-1.5 pl-5 text-muted-foreground">
                        {visibility.todo.includes("attach") ? (
                          <li>
                            {check?.attached === false
                              ? "Meta says the catalogue isn't connected to this number yet."
                              : "Meta hasn't confirmed the catalogue is connected to this number."}{" "}
                            In WhatsApp Manager open Account tools → Catalogue, choose{" "}
                            {shop.row?.catalog_name ?? "your catalogue"} and connect it.
                          </li>
                        ) : null}
                        {visibility.todo.includes("shop_button") ? (
                          <li>
                            {check?.is_catalog_visible === false || shop.row?.is_catalog_visible === false
                              ? "The shop button is off on this number."
                              : "We couldn't read the shop button setting yet."}{" "}
                            {canManage ? (
                              <button
                                type="button"
                                className="font-medium text-primary underline-offset-2 hover:underline disabled:opacity-50"
                                disabled={turningOn || checking}
                                onClick={() => void turnOnShopButton()}
                              >
                                {turningOn ? "Turning it on…" : "Turn on the shop button and cart"}
                              </button>
                            ) : (
                              "Ask an admin to turn it on."
                            )}
                          </li>
                        ) : null}
                        <li>
                          Then check again.{" "}
                          {canManage ? (
                            <button
                              type="button"
                              className="font-medium text-primary underline-offset-2 hover:underline disabled:opacity-50"
                              disabled={checking || turningOn}
                              onClick={() => void checkAgain()}
                            >
                              {checking ? "Checking with Meta…" : "Check again"}
                            </button>
                          ) : null}
                        </li>
                        {check?.errors.length ? (
                          <li className="list-none text-xs text-destructive">Meta said: {check.errors.join(" · ")}</li>
                        ) : null}
                      </ol>
                    ) : null}
                  </div>
                )}
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
          <div className="flex flex-wrap items-center gap-2">
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
              {syncing ? "Syncing…" : "Sync now"}
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
