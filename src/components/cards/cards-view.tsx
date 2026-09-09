import { useCallback, useEffect, useState } from "react";
import { Eye, ImageIcon, Loader2, Palette } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { callApi } from "@/lib/whatsapp-client";
import { logActivity } from "@/lib/activity";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

const CARD_KINDS = [
  { kind: "customer_offer", title: "Offer", blurb: "A headline offer with a coupon code and validity date.", vars: "headline · offer · validity · code" },
  { kind: "customer_product", title: "Product", blurb: "One product with its picture, price and a one-line pitch.", vars: "name · price · image · one-liner" },
  { kind: "customer_order_update", title: "Order update", blurb: "Order number, its new status and when it arrives.", vars: "order no · status · ETA" },
  { kind: "customer_receipt", title: "Receipt", blurb: "A tidy receipt — up to four items and the total paid.", vars: "items · total" },
  { kind: "customer_appointment", title: "Appointment", blurb: "A booking card with the date, time and place.", vars: "date · time · place" },
] as const;

type Branding = {
  brand_logo_url: string;
  brand_name: string;
  brand_primary: string;
  brand_accent: string;
};

const EMPTY: Branding = { brand_logo_url: "", brand_name: "", brand_primary: "", brand_accent: "" };

/**
 * /app/cards — the workspace's brand paint (logo, colours) and the five
 * customer card designs, each with a live preview drawn by the renderer.
 */
export function CardsView({
  organizationId,
  canManage,
}: {
  organizationId: string;
  canManage: boolean;
}) {
  const [branding, setBranding] = useState<Branding>(EMPTY);
  const [orgName, setOrgName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [previewing, setPreviewing] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await aidwar
      .from("organizations")
      .select("name, branding")
      .eq("id", organizationId)
      .maybeSingle();
    const row = (data ?? {}) as { name?: string | null; branding?: Record<string, unknown> | null };
    const b = (row.branding ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    setOrgName((row.name ?? "").trim());
    setBranding({
      brand_logo_url: str(b["brand_logo_url"]) || str(b["logo_url"]),
      brand_name: str(b["brand_name"]),
      brand_primary: str(b["brand_primary"]),
      brand_accent: str(b["brand_accent"]),
    });
    setLoading(false);
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setSaving(true);
    const { error } = await callApi("/api/cards", {
      body: { action: "save_branding", organization_id: organizationId, branding },
    });
    setSaving(false);
    if (error) {
      toast.error(error);
      return;
    }
    // New paint means new cards — old previews no longer apply.
    setPreviews({});
    void logActivity("card_branding_updated", organizationId, {
      has_logo: Boolean(branding.brand_logo_url),
    });
    toast.success("Card branding saved — every new card uses it from here.");
  }

  async function preview(kind: string) {
    setPreviewing(kind);
    const { data, error } = await callApi<{ url: string }>("/api/cards", {
      body: { action: "preview", organization_id: organizationId, kind },
    });
    setPreviewing(null);
    if (error || !data?.url) {
      toast.error(error ?? "The card couldn't be drawn just now — try again in a moment.");
      return;
    }
    setPreviews((p) => ({ ...p, [kind]: data.url }));
  }

  if (loading) {
    return (
      <div className="space-y-6 p-6">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-64 w-full max-w-2xl rounded-2xl" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-56 rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Cards</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Branded picture cards that travel with your campaigns, flows and AI answers — an offer,
          a product, an order update, a receipt or an appointment. Set your logo and colours once;
          every card wears them.
        </p>
      </div>

      <section className="max-w-2xl rounded-2xl border border-border/60 bg-card p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <Palette className="h-4 w-4 text-primary" />
          <h2 className="text-base font-semibold text-foreground">Your brand on every card</h2>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="brand-logo">Logo image link</Label>
            <Input
              id="brand-logo"
              className="min-h-11"
              placeholder="https://yourstore.in/logo.png"
              value={branding.brand_logo_url}
              disabled={!canManage}
              onChange={(e) => setBranding((b) => ({ ...b, brand_logo_url: e.target.value }))}
            />
            <p className="text-xs text-muted-foreground">
              A public https image. Leave it blank and the cards simply show your name instead.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="brand-name">Name on the card</Label>
            <Input
              id="brand-name"
              className="min-h-11"
              placeholder={orgName || "Your shop's name"}
              value={branding.brand_name}
              disabled={!canManage}
              onChange={(e) => setBranding((b) => ({ ...b, brand_name: e.target.value }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="brand-primary">Main colour</Label>
              <Input
                id="brand-primary"
                className="min-h-11"
                placeholder="#10B981"
                value={branding.brand_primary}
                disabled={!canManage}
                onChange={(e) => setBranding((b) => ({ ...b, brand_primary: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="brand-accent">Second colour</Label>
              <Input
                id="brand-accent"
                className="min-h-11"
                placeholder="#0D9488"
                value={branding.brand_accent}
                disabled={!canManage}
                onChange={(e) => setBranding((b) => ({ ...b, brand_accent: e.target.value }))}
              />
            </div>
          </div>
        </div>
        {canManage ? (
          <Button
            className="mt-5 min-h-11 rounded-full px-6"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save branding
          </Button>
        ) : (
          <p className="mt-4 text-xs text-muted-foreground">
            Ask the shop owner to give you permission to change these.
          </p>
        )}
      </section>

      <section>
        <h2 className="text-base font-semibold text-foreground">The five designs</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Attach any of these to a campaign or a flow step; Aiden also uses the product card when
          it answers with a product.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CARD_KINDS.map((card) => {
            const url = previews[card.kind];
            return (
              <div
                key={card.kind}
                className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm transition-shadow duration-200 hover:shadow-md"
              >
                <div className="flex aspect-[4/5] items-center justify-center bg-muted/40">
                  {url ? (
                    <img
                      src={url}
                      alt={`${card.title} card preview`}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <ImageIcon className="h-8 w-8" />
                      <span className="text-xs">Not drawn yet</span>
                    </div>
                  )}
                </div>
                <div className="space-y-1.5 p-4">
                  <h3 className="text-sm font-semibold text-foreground">{card.title}</h3>
                  <p className="text-xs text-muted-foreground">{card.blurb}</p>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
                    {card.vars}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2 rounded-full"
                    onClick={() => void preview(card.kind)}
                    disabled={previewing === card.kind}
                  >
                    {previewing === card.kind ? (
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Eye className="mr-2 h-3.5 w-3.5" />
                    )}
                    {url ? "Draw again" : "Preview"}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
