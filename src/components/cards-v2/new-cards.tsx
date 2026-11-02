import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, ImageIcon, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { PageHeader } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { logActivity } from "@/lib/activity";
import {
  CARD_USES,
  CUSTOMER_CARD_DESIGNS,
  PRODUCT_CARDS_SETTING,
  productCardsInAnswers,
} from "@/lib/customer-cards";
import { callApi } from "@/lib/whatsapp-client";
import { cardsCopy as cc } from "./copy";

/**
 * Batch 47: Cards in the new design, the Campaigns section's third tab. The
 * five designs first, each as the renderer draws it on a chat wall, then the
 * brand paint and where cards go. Every request is the Batch 41 page's own
 * (/api/cards stored_previews, preview, save_branding, save_usage; the
 * organizations read), so drawing and reusing cards works exactly as before;
 * a workspace with the flag off sees that page (cards-view), unchanged.
 */

type Branding = {
  brand_logo_url: string;
  brand_name: string;
  brand_primary: string;
  brand_accent: string;
};

const EMPTY: Branding = { brand_logo_url: "", brand_name: "", brand_primary: "", brand_accent: "" };

export function NewCards({
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
  const [productCards, setProductCards] = useState(true);
  const [savingUsage, setSavingUsage] = useState(false);

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
    setProductCards(productCardsInAnswers(true, b));
    setLoading(false);
  }, [organizationId]);

  // A design already drawn for today's paint is found again, nothing redrawn.
  const lookup = useRef(0);
  const loadStoredPreviews = useCallback(async () => {
    const mine = (lookup.current += 1);
    const { data } = await callApi<{ urls: Record<string, string> }>("/api/cards", {
      body: { action: "stored_previews", organization_id: organizationId },
    });
    if (mine === lookup.current) setPreviews((p) => ({ ...(data?.urls ?? {}), ...p }));
  }, [organizationId]);

  useEffect(() => {
    void load();
    void loadStoredPreviews();
  }, [load, loadStoredPreviews]);

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
    setPreviews({});
    void loadStoredPreviews();
    void logActivity("card_branding_updated", organizationId, {
      has_logo: Boolean(branding.brand_logo_url),
    });
    toast.success(cc.brand.saved);
  }

  async function saveProductCards(next: boolean) {
    const before = productCards;
    setProductCards(next);
    setSavingUsage(true);
    const { error } = await callApi("/api/cards", {
      body: { action: "save_usage", organization_id: organizationId, product_cards: next },
    });
    setSavingUsage(false);
    if (error) {
      setProductCards(before);
      toast.error(error);
      return;
    }
    toast.success(next ? cc.uses.on : cc.uses.off);
  }

  async function preview(kind: string) {
    setPreviewing(kind);
    const { data, error } = await callApi<{ url: string }>("/api/cards", {
      body: { action: "preview", organization_id: organizationId, kind },
    });
    setPreviewing(null);
    if (error || !data?.url) {
      toast.error(error ?? cc.designs.drawFailed);
      return;
    }
    setPreviews((p) => ({ ...p, [kind]: data.url }));
  }

  const field = (key: keyof Branding, value: string) =>
    setBranding((b) => ({ ...b, [key]: value }));

  return (
    <>
      <PageHeader title={cc.page.title} description={cc.page.description} />

      {loading ? (
        <div className="flex flex-col gap-6" aria-busy="true" aria-label={cc.loading}>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-5">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-80 rounded-[23px]" />
            ))}
          </div>
          <Skeleton className="h-64 rounded-[20px]" />
        </div>
      ) : (
        <div className="flex flex-col gap-9">
          <section aria-labelledby="card-designs" className="flex flex-col gap-4">
            <div>
              <h2 id="card-designs" className="m-0 font-display text-xl font-semibold">
                {cc.designs.heading}
              </h2>
              <p className="m-0 mt-1 text-muted-foreground">{cc.designs.body}</p>
            </div>
            <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(210px,1fr))] items-start gap-5 p-0">
              {CUSTOMER_CARD_DESIGNS.map((d, i) => {
                const url = previews[d.kind];
                return (
                  <li
                    key={d.kind}
                    className="nd-rise flex flex-col gap-3"
                    style={{ ["--d" as string]: i }}
                  >
                    <div className="nd-wall grid aspect-[4/5] place-items-center overflow-hidden rounded-[23px] border border-line p-3">
                      {url ? (
                        <img
                          src={url}
                          alt={cc.designs.alt(d.title)}
                          className="max-h-full w-full rounded-[14px] object-contain shadow-md"
                        />
                      ) : (
                        <span className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
                          <ImageIcon className="h-7 w-7" aria-hidden="true" />
                          {cc.designs.notDrawn}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-col gap-1">
                      <h3 className="m-0 text-base font-bold">{d.title}</h3>
                      <p className="m-0 text-sm text-muted-foreground">{d.blurb}</p>
                      <p className="m-0 text-sm text-muted-foreground">
                        {cc.designs.fillsIn(d.vars.map((v) => v.label.toLowerCase()).join(", "))}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-fit phone:h-11"
                      onClick={() => void preview(d.kind)}
                      disabled={previewing === d.kind}
                    >
                      {previewing === d.kind ? (
                        <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
                      ) : (
                        <Eye className="h-4 w-4" aria-hidden="true" />
                      )}
                      {url ? cc.designs.drawAgain : cc.designs.preview}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </section>

          <div className="grid items-start gap-7 min-[1001px]:grid-cols-2">
            <section
              aria-labelledby="card-brand"
              className="flex flex-col gap-4 rounded-[20px] border border-line bg-surface p-5 shadow-md"
            >
              <h2 id="card-brand" className="m-0 font-display text-lg font-semibold">
                {cc.brand.heading}
              </h2>
              <div className="grid gap-4 wide:grid-cols-2">
                <div className="flex flex-col gap-2 wide:col-span-2">
                  <Label htmlFor="nd-brand-logo">{cc.brand.logo}</Label>
                  <Input
                    id="nd-brand-logo"
                    placeholder="https://yourstore.in/logo.png"
                    value={branding.brand_logo_url}
                    disabled={!canManage}
                    onChange={(e) => field("brand_logo_url", e.target.value)}
                    aria-describedby="nd-brand-logo-hint"
                  />
                  <p id="nd-brand-logo-hint" className="m-0 text-sm text-muted-foreground">
                    {cc.brand.logoHint}
                  </p>
                </div>
                <div className="flex flex-col gap-2 wide:col-span-2">
                  <Label htmlFor="nd-brand-name">{cc.brand.name}</Label>
                  <Input
                    id="nd-brand-name"
                    placeholder={orgName || cc.brand.namePlaceholder}
                    value={branding.brand_name}
                    disabled={!canManage}
                    onChange={(e) => field("brand_name", e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="nd-brand-primary">{cc.brand.primary}</Label>
                  <Input
                    id="nd-brand-primary"
                    placeholder="#10B981"
                    value={branding.brand_primary}
                    disabled={!canManage}
                    onChange={(e) => field("brand_primary", e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="nd-brand-accent">{cc.brand.accent}</Label>
                  <Input
                    id="nd-brand-accent"
                    placeholder="#0D9488"
                    value={branding.brand_accent}
                    disabled={!canManage}
                    onChange={(e) => field("brand_accent", e.target.value)}
                  />
                </div>
              </div>
              {canManage ? (
                <Button className="w-fit phone:h-11" onClick={() => void save()} disabled={saving}>
                  {saving ? (
                    <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
                  ) : null}
                  {cc.brand.save}
                </Button>
              ) : (
                <p className="m-0 text-sm text-muted-foreground">{cc.brand.noPermission}</p>
              )}
            </section>

            <section aria-labelledby="card-uses" className="flex flex-col gap-4">
              <div>
                <h2 id="card-uses" className="m-0 font-display text-lg font-semibold">
                  {cc.uses.heading}
                </h2>
                <p className="m-0 mt-1 text-muted-foreground">{cc.uses.body}</p>
              </div>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {CARD_USES.map((use) => (
                  <li key={use.key} className="border-b border-line pb-2 last:border-0">
                    <b className="text-foreground">{use.title}</b>
                    <p className="m-0 text-sm text-muted-foreground">{use.how}</p>
                  </li>
                ))}
              </ul>
              <div className="flex items-start justify-between gap-4 rounded-[18px] border border-line bg-surface p-4">
                <div>
                  <label
                    htmlFor={`nd-switch-${PRODUCT_CARDS_SETTING}`}
                    className="font-semibold text-foreground"
                  >
                    {cc.uses.switchLabel}
                  </label>
                  <p className="m-0 mt-1 text-sm text-muted-foreground">{cc.uses.switchHelp}</p>
                </div>
                <Switch
                  id={`nd-switch-${PRODUCT_CARDS_SETTING}`}
                  checked={productCards}
                  disabled={!canManage || savingUsage}
                  onCheckedChange={(v) => void saveProductCards(v)}
                />
              </div>
            </section>
          </div>
        </div>
      )}
    </>
  );
}
