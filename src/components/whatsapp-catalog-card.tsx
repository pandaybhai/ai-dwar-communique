import { useCallback, useEffect, useState } from "react";
import { BookOpen, Check, Copy, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { callApi } from "@/lib/whatsapp-client";
import { useFeatureFlag } from "@/hooks/use-feature-flag";

type Catalog = {
  catalog_id: string;
  catalog_name: string | null;
  status: string;
  mode: "managed" | "linked";
  last_sync_at: string | null;
  pushed_count: number;
  rejected_count: number;
  last_error: string | null;
  is_catalog_visible: boolean | null;
  is_cart_enabled: boolean | null;
} | null;

type Status = {
  connected: boolean;
  scopes_ok: boolean;
  granted_scopes?: string[];
  catalog?: Catalog;
};

const PARTNER_ID = "1451227116580979";

/**
 * Catalogue controls for one connected number. The enable button only appears
 * when Meta actually granted catalogue permission for this connection —
 * otherwise the owner is asked to reconnect the number.
 *
 * A merchant who already owns a catalogue (often kept fresh by their shop
 * platform) can link it instead: we then only read from it, never write.
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
  const [working, setWorking] = useState<"check" | "sync" | "mode" | "settings" | null>(null);
  const [catalogInput, setCatalogInput] = useState("");
  const [setupMode, setSetupMode] = useState<"managed" | "linked">("managed");
  const [showHowTo, setShowHowTo] = useState(false);
  const [checkError, setCheckError] = useState<{ step?: string | undefined; message: string } | null>(null);
  const [copied, setCopied] = useState(false);

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

  async function checkAccess() {
    setWorking("check");
    setCheckError(null);
    const { error, raw } = await callApi<{ ok: boolean }>("/api/whatsapp/catalog", {
      body: {
        organization_id: orgId,
        whatsapp_account_id: accountId,
        action: "check_access",
        catalog_id: catalogInput.trim(),
        mode: setupMode,
      },
    });
    setWorking(null);
    if (error) {
      const step = (raw as { step?: string } | null)?.step;
      setCheckError({ step, message: error });
      return;
    }
    toast.success("Catalogue connected to this number");
    await load();
  }

  async function changeMode(next: "managed" | "linked") {
    setWorking("mode");
    const { error } = await callApi("/api/whatsapp/catalog", {
      body: { organization_id: orgId, whatsapp_account_id: accountId, action: "set_mode", mode: next },
    });
    setWorking(null);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success(next === "linked" ? "Your store fills it — AiDwar only reads" : "AiDwar keeps it in sync");
    await load();
  }

  async function confirmAttached() {
    setWorking("settings");
    const { error } = await callApi("/api/whatsapp/catalog", {
      body: { organization_id: orgId, whatsapp_account_id: accountId, action: "confirm_attached" },
    });
    setWorking(null);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success("Got it — the catalogue is connected to this number");
    await load();
  }

  async function copyId() {
    try {
      await navigator.clipboard.writeText(PARTNER_ID);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy — select the number and copy it by hand.");
    }
  }

  async function runSync(mode: "managed" | "linked") {
    setWorking("sync");
    const { data, error } = await callApi<{
      pushed?: number;
      rejected?: number;
      removed?: number;
      imported?: number;
    }>("/api/whatsapp/catalog", {
      body: {
        organization_id: orgId,
        whatsapp_account_id: accountId,
        action: mode === "linked" ? "refresh" : "sync",
      },
    });
    setWorking(null);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success(
      mode === "linked"
        ? `${data?.imported ?? 0} product${data?.imported === 1 ? "" : "s"} read from your catalogue`
        : `${data?.pushed ?? 0} sent · ${data?.removed ?? 0} removed · ${data?.rejected ?? 0} refused`,
    );

    await load();
  }

  async function setCommerce(next: { visible: boolean; cart: boolean }) {
    setWorking("settings");
    const { error } = await callApi("/api/whatsapp/catalog", {
      body: {
        organization_id: orgId,
        whatsapp_account_id: accountId,
        action: "commerce_settings",
        is_catalog_visible: next.visible,
        is_cart_enabled: next.cart,
      },
    });
    setWorking(null);
    if (error) {
      toast.error(error);
      return;
    }
    await load();
  }

  const catalog = status?.catalog ?? null;
  const mode = catalog?.mode ?? "managed";

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
            ) : catalog ? (
              <>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">
                  {catalog.catalog_name ?? catalog.catalog_id} ·{" "}
                  {catalog.last_sync_at
                    ? mode === "linked"
                      ? `${catalog.pushed_count} product${
                          catalog.pushed_count === 1 ? "" : "s"
                        } read`
                      : `${catalog.pushed_count} product${
                          catalog.pushed_count === 1 ? "" : "s"
                        } sent${catalog.rejected_count ? `, ${catalog.rejected_count} refused` : ""}`
                    : mode === "linked"
                      ? "not read yet"
                      : "nothing sent yet"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {mode === "linked"
                    ? "My store already fills it — AiDwar only reads."
                    : "AiDwar keeps it in sync."}{" "}
                  {canManage ? (
                    <button
                      type="button"
                      className="font-medium text-primary underline-offset-2 hover:underline disabled:opacity-50"
                      disabled={working !== null}
                      onClick={() => void changeMode(mode === "linked" ? "managed" : "linked")}
                    >
                      Change
                    </button>
                  ) : null}
                </p>
              </>
            ) : (
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                Connect a catalogue from your Meta business in four short steps.
              </p>
            )}
            {catalog?.last_error ? (
              <p className="mt-2 max-w-md text-xs text-destructive">{catalog.last_error}</p>
            ) : null}
            {catalog?.status === "attach_unconfirmed" ? (
              <p className="mt-2 max-w-md text-xs text-muted-foreground">
                If the catalogue isn't showing in WhatsApp yet, open WhatsApp Manager → Catalogue and
                connect {catalog.catalog_name ?? "your catalogue"}.{" "}
                {canManage ? (
                  <button
                    type="button"
                    className="font-medium text-primary underline-offset-2 hover:underline disabled:opacity-50"
                    disabled={working !== null}
                    onClick={() => void confirmAttached()}
                  >
                    I've connected it
                  </button>
                ) : null}
              </p>
            ) : null}
          </div>
        </div>

        {loading ? null : canManage && catalog ? (
          <div className="flex flex-wrap items-center gap-2">
            {catalog ? (
              <Badge variant="outline" className="rounded-full">
                {mode === "linked" ? "Your catalogue" : "Managed by AiDwar"}
              </Badge>
            ) : null}
            {
              <Button
                variant="outline"
                className="rounded-full"
                disabled={working !== null}
                onClick={() => void runSync(mode)}
              >
                {working === "sync" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                {mode === "linked" ? "Refresh" : "Sync products"}
              </Button>
            }
          </div>
        ) : null}
      </div>

      {!loading && !catalog && canManage ? (
        <ol className="mt-4 space-y-4 border-t border-border/60 pt-4 text-sm">
          <li>
            <p className="font-semibold text-foreground">A · Pick or create a catalogue in your Meta business</p>
            <a
              href="https://business.facebook.com/commerce"
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-primary hover:underline"
            >
              Open Commerce Manager <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <Input
              className="mt-2 max-w-xs"
              inputMode="numeric"
              placeholder="Paste the catalogue ID"
              value={catalogInput}
              onChange={(e) => setCatalogInput(e.target.value.replace(/\s/g, ""))}
            />
            <button
              type="button"
              className="mt-2 block text-xs font-medium text-muted-foreground hover:text-foreground"
              onClick={() => setShowHowTo((v) => !v)}
            >
              I don't have one
            </button>
            {showHowTo ? (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                <li>In Commerce Manager, choose Add catalogue → E-commerce.</li>
                <li>Pick Upload product info, name it, and create it.</li>
                <li>Open Settings in the new catalogue and copy its ID here.</li>
              </ul>
            ) : null}
            {checkError?.step === "catalog_id" ? (
              <p className="mt-2 text-xs text-destructive">{checkError.message}</p>
            ) : null}
          </li>
          <li>
            <p className="font-semibold text-foreground">B · Share it with AiDwar</p>
            <p className="mt-1 text-muted-foreground">
              Business settings → Data sources → Catalogues → your catalogue → Assign partner →
              Business ID {PARTNER_ID} → Manage catalogue.
            </p>
            <Button variant="outline" size="sm" className="mt-2 rounded-full" onClick={() => void copyId()}>
              {copied ? <Check className="mr-2 h-3.5 w-3.5" /> : <Copy className="mr-2 h-3.5 w-3.5" />}
              {copied ? "Copied" : `Copy ${PARTNER_ID}`}
            </Button>
            {checkError?.step === "share" ? (
              <p className="mt-2 text-xs text-destructive">{checkError.message}</p>
            ) : null}
          </li>
          <li>
            <p className="font-semibold text-foreground">C · How should products get in?</p>
            <p className="mt-1 text-xs text-muted-foreground">You can change this later.</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {(
                [
                  ["managed", "AiDwar keeps it in sync", "We add, update and remove products for you."],
                  ["linked", "My store already fills it", "We only read it — nothing is changed."],
                ] as const
              ).map(([value, title, hint]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setSetupMode(value)}
                  className={`rounded-xl border p-3 text-left transition ${
                    setupMode === value
                      ? "border-primary bg-primary/5"
                      : "border-border/70 hover:border-primary/60"
                  }`}
                >
                  <p className="text-sm font-medium text-foreground">{title}</p>
                  <p className="text-xs text-muted-foreground">{hint}</p>
                </button>
              ))}
            </div>
          </li>
          <li>
            <p className="font-semibold text-foreground">D · Check access</p>
            <Button
              className="mt-2 rounded-full"
              disabled={working !== null || catalogInput.trim().length === 0}
              onClick={() => void checkAccess()}
            >
              {working === "check" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Check access
            </Button>
            {checkError && checkError.step !== "catalog_id" && checkError.step !== "share" ? (
              <p className="mt-2 text-xs text-destructive">{checkError.message}</p>
            ) : null}
          </li>
        </ol>
      ) : null}

      {catalog && canManage ? (
        <div className="mt-4 flex flex-wrap gap-6 border-t border-border/60 pt-4">
          <div className="flex items-center gap-3">
            <Switch
              id="catalog-visible"
              checked={catalog.is_catalog_visible !== false}
              disabled={working !== null}
              onCheckedChange={(checked) =>
                void setCommerce({ visible: checked, cart: catalog.is_cart_enabled !== false })
              }
            />
            <Label htmlFor="catalog-visible" className="text-sm text-muted-foreground">
              Show the shop button on this number
            </Label>
          </div>
          <div className="flex items-center gap-3">
            <Switch
              id="catalog-cart"
              checked={catalog.is_cart_enabled !== false}
              disabled={working !== null}
              onCheckedChange={(checked) =>
                void setCommerce({ visible: catalog.is_catalog_visible !== false, cart: checked })
              }
            />
            <Label htmlFor="catalog-cart" className="text-sm text-muted-foreground">
              Let customers build a cart
            </Label>
          </div>
        </div>
      ) : null}

    </div>
  );
}
