import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ShoppingBag,
  Unplug,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { callApi } from "@/lib/whatsapp-client";
import { useOrg } from "@/lib/org-context";
import { usePermissions } from "@/hooks/use-permissions";

type SyncJob = {
  id: string;
  status: string;
  phase: string | null;
  products_synced: number | null;
  orders_synced: number | null;
  contacts_matched: number | null;
  error: string | null;
  finished_at: string | null;
};

type Integration = {
  id: string;
  provider: string;
  shop_domain: string;
  display_name: string | null;
  status: string;
  scopes: string[] | null;
  installed_at: string | null;
  last_sync_at: string | null;
  sync_error: string | null;
  latest_sync: SyncJob | null;
};

type ListResponse = { configured: boolean; integrations: Integration[] };

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm sm:p-8">{children}</div>
  );
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** Shopify stores connected to this workspace: install, watch sync, disconnect. */
export function IntegrationsTab() {
  const { active } = useOrg();
  const { can, loading: permsLoading } = usePermissions();
  const canView = can("integrations.view");
  const canManage = can("integrations.manage");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState(true);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [shopDomain, setShopDomain] = useState("");
  const [installing, setInstalling] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const load = useCallback(
    async (quiet = false) => {
      if (!active?.organization.id) return;
      if (!quiet) setLoading(true);
      const { data, error: err } = await callApi<ListResponse>(
        `/api/integrations/shopify?organization_id=${encodeURIComponent(active.organization.id)}`,
        { method: "GET" },
      );
      if (err) setError(err);
      else if (data) {
        setError(null);
        setConfigured(data.configured);
        setIntegrations(data.integrations ?? []);
      }
      setLoading(false);
    },
    [active?.organization.id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // A backfill runs in the background, so the card polls while one is live.
  const syncing = integrations.some((i) => i.latest_sync?.status === "running");
  useEffect(() => {
    if (!syncing) return;
    pollRef.current = window.setInterval(() => void load(true), 4000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [syncing, load]);

  // The OAuth callback returns here with the outcome in the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("shopify_connected");
    const failure = params.get("shopify_error");
    if (!connected && !failure) return;
    if (connected) toast.success(`${connected} is connected. Syncing your store now.`);
    if (failure) {
      const messages: Record<string, string> = {
        not_configured: "Shopify isn't configured for this deployment yet.",
        signature: "We couldn't verify that response came from Shopify.",
        state: "That install link had expired. Please start again.",
        invalid_request: "Shopify sent an incomplete response. Please try again.",
        exchange: "Shopify wouldn't complete the install. Please try again.",
        save: "We couldn't save the connection. Please try again.",
        online_token:
          "Shopify issued a temporary per-user token. Reinstall the app so background sync keeps working.",

      };
      toast.error(messages[failure] ?? "We couldn't finish connecting that store.");
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("shopify_connected");
    url.searchParams.delete("shopify_error");
    window.history.replaceState({}, "", url.toString());
  }, []);

  const startInstall = async (domain?: string) => {
    if (!active?.organization.id) return;
    const shop = (domain ?? shopDomain).trim();
    setInstalling(true);
    const { data, error: err } = await callApi<{ install_url: string }>(
      "/api/integrations/shopify",
      { body: { organization_id: active.organization.id, action: "install", shop_domain: shop } },
    );
    setInstalling(false);
    if (err || !data?.install_url) {
      toast.error(err ?? "We couldn't start the install.");
      return;
    }
    window.location.href = data.install_url;
  };

  const act = async (integrationId: string, action: "resync" | "disconnect") => {
    if (!active?.organization.id) return;
    setBusyId(integrationId);
    const { error: err } = await callApi(`/api/integrations/shopify`, {
      body: { organization_id: active.organization.id, action, integration_id: integrationId },
    });
    setBusyId(null);
    if (err) {
      toast.error(err);
      return;
    }
    toast.success(action === "resync" ? "Sync started." : "Store disconnected.");
    void load(true);
  };

  if (permsLoading || loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-32 w-full rounded-2xl" />
      </div>
    );
  }

  if (!canView) {
    return <ErrorState message="You don't have access to integrations in this workspace." />;
  }
  if (error) return <ErrorState message={error} />;

  return (
    <div className="space-y-6">
      {integrations.length === 0 ? (
        <Card>
          <EmptyState
            icon={ShoppingBag}
            title="No stores connected yet"
            description="Connect a Shopify store to sync orders, products, checkouts and customers into this workspace."
          />
        </Card>
      ) : (
        integrations.map((integration) => {
          const job = integration.latest_sync;
          const running = job?.status === "running";
          return (
            <Card key={integration.id}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <ShoppingBag className="h-5 w-5" />
                  </span>
                  <div>
                    <p className="font-semibold">{integration.shop_domain}</p>
                    <p className="text-sm text-muted-foreground">
                      Last synced {timeAgo(integration.last_sync_at)}
                    </p>
                  </div>
                </div>
                <Badge variant={integration.status === "connected" ? "default" : "secondary"}>
                  {integration.status === "connected"
                    ? "Connected"
                    : integration.status === "error"
                      ? "Needs attention"
                      : "Disconnected"}
                </Badge>
              </div>

              {integration.sync_error ? (
                <p className="mt-4 flex items-start gap-2 rounded-xl bg-destructive/10 p-3 text-sm text-destructive">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  {integration.sync_error}
                </p>
              ) : null}

              {job ? (
                <div className="mt-4 rounded-xl bg-muted/50 p-3 text-sm text-muted-foreground">
                  {running ? (
                    <span className="flex items-center gap-2 text-foreground">
                      <Loader2 className="h-4 w-4 animate-spin text-primary" />
                      Syncing {job.phase ?? "store"} — {job.products_synced ?? 0} products,{" "}
                      {job.orders_synced ?? 0} orders so far.
                    </span>
                  ) : job.status === "completed" ? (
                    <span className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-primary" />
                      Synced {job.products_synced ?? 0} products and {job.orders_synced ?? 0} orders,{" "}
                      {job.contacts_matched ?? 0} matched to contacts.
                    </span>
                  ) : (
                    <span className="flex items-center gap-2 text-destructive">
                      <AlertTriangle className="h-4 w-4" />
                      {job.error ?? "The last sync didn't finish."}
                    </span>
                  )}
                </div>
              ) : null}

              {canManage ? (
                <div className="mt-5 flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={running || busyId === integration.id || integration.status !== "connected"}
                    onClick={() => void act(integration.id, "resync")}
                  >
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Resync
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="sm" disabled={busyId === integration.id}>
                        <Unplug className="mr-2 h-4 w-4" />
                        Disconnect
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Disconnect {integration.shop_domain}?</AlertDialogTitle>
                        <AlertDialogDescription>
                          We'll delete the stored access token straight away and stop syncing. Orders
                          and products already synced stay in this workspace.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Keep connected</AlertDialogCancel>
                        <AlertDialogAction onClick={() => void act(integration.id, "disconnect")}>
                          Disconnect
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              ) : null}
            </Card>
          );
        })
      )}

      {canManage ? (
        <Card>
          <h3 className="font-semibold">Connect a Shopify store</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Multi-brand workspaces can connect more than one store. Each store syncs separately.
          </p>
          {!configured ? (
            <p className="mt-4 flex items-start gap-2 rounded-xl bg-muted/60 p-3 text-sm text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              Shopify isn't configured for this deployment yet. Once the app credentials are in
              place, you'll be able to connect a store here.
            </p>
          ) : null}
          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-2">
              <Label htmlFor="shop-domain">Store address</Label>
              <Input
                id="shop-domain"
                placeholder="your-store.myshopify.com"
                value={shopDomain}
                onChange={(e) => setShopDomain(e.target.value)}
                disabled={!configured}
              />
            </div>
            <Button
              onClick={() => void startInstall()}
              disabled={!configured || installing || shopDomain.trim().length < 3}
            >
              {installing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Connect store
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
