import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { NumberTicker, PhoneFrame, PhoneMessage, ProductBubble } from "@/components/design-v2";
import { Button } from "@/components/ui/button";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { usePermissions } from "@/hooks/use-permissions";
import { aidwar } from "@/integrations/aidwar/client";
import {
  NOT_ARCHIVED_DUPLICATE,
  STORE_PRODUCT_SOURCES,
  formatMoney,
  relativeTime,
} from "@/lib/catalog";
import { callApi } from "@/lib/whatsapp-client";

type Overview = {
  total: number;
  website: number;
  store: number;
  hidden: number;
  noPhoto: number;
  collections: number;
  lastUpdated: string | null;
  site: { id: string; status: string } | null;
  preview: Array<{
    id: string;
    title: string;
    price: number | null;
    currency: string | null;
    image_url: string | null;
  }>;
};

/** Website reads that are queued or running (ProductsSummary's READING). */
const READING = new Set(["pending", "syncing"]);

/**
 * Batch 49: the top of Shop > Catalogue in the new design. Read only, with
 * the member's own access: ProductsSummary's counts (all, from the website,
 * from the store, newest change, the website source) plus how many are
 * hidden or have no photo, the number of collections, and two visible
 * products with photos for the WhatsApp shop preview. "Refresh from website"
 * is ProductsSummary's own call (/api/ai/knowledge "read_changes", for
 * ai.configure, same cooldown and queue).
 */
export function ShopOverview({
  organizationId,
  shopCard,
  below,
}: {
  organizationId: string;
  shopCard: React.ReactNode;
  /** Shown under the catalogue card in the wide column (the category words card). */
  below?: React.ReactNode;
}) {
  const { can } = usePermissions();
  const { enabled: shopOn } = useFeatureFlag("whatsapp_catalog");
  const [summary, setSummary] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const count = (q: PromiseLike<{ count: number | null }>) =>
      Promise.resolve(q).then((r) => r.count ?? 0);
    const base = () =>
      aidwar
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .or(NOT_ARCHIVED_DUPLICATE);
    const [total, website, store, hidden, noPhoto, collections, latest, site, preview] =
      await Promise.all([
        count(base()),
        count(base().eq("source", "crawl")),
        count(base().in("source", [...STORE_PRODUCT_SOURCES])),
        count(base().eq("is_visible", false)),
        count(base().is("image_url", null)),
        count(
          aidwar
            .from("product_collections")
            .select("id", { count: "exact", head: true })
            .eq("organization_id", organizationId),
        ),
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
        aidwar
          .from("products")
          .select("id, title, price, currency, image_url")
          .eq("organization_id", organizationId)
          .eq("is_visible", true)
          .not("image_url", "is", null)
          .or(NOT_ARCHIVED_DUPLICATE)
          .order("updated_at", { ascending: false })
          .limit(2),
      ]);
    setSummary({
      total,
      website,
      store,
      hidden,
      noPhoto,
      collections,
      lastUpdated:
        ((latest.data ?? []) as Array<{ updated_at: string | null }>)[0]?.updated_at ?? null,
      site: ((site.data ?? []) as Array<{ id: string; status: string }>)[0] ?? null,
      preview: (preview.data ?? []) as Overview["preview"],
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
    toast.success(
      "Reading your website for changes. New products and photos show up here when it's done.",
    );
    await load();
  }

  if (!summary) {
    return (
      <div className="mb-10 h-64 animate-pulse rounded-[20px] bg-bubble-in motion-reduce:animate-none" />
    );
  }
  const reading = summary.site ? READING.has(summary.site.status) : false;

  return (
    <div className="mb-10 grid items-start gap-10 wide:grid-cols-[minmax(0,7fr)_minmax(0,4fr)]">
      <div className="flex min-w-0 flex-col gap-6">
        <section
          aria-labelledby="shop-catalogue-heading"
          className="flex flex-col gap-5 rounded-[20px] border border-line bg-surface p-6 shadow-md phone:p-5"
        >
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2
                id="shop-catalogue-heading"
                className="m-0 text-body font-semibold text-muted-foreground"
              >
                Your catalogue
              </h2>
              <p className="m-0 font-display text-[clamp(2rem,4vw,2.75rem)] font-extrabold leading-none tracking-[-0.03em] tabular-nums">
                <NumberTicker value={summary.total} />{" "}
                <span className="text-[0.5em] font-semibold tracking-normal">products</span>
              </p>
              <p className="m-0 mt-1.5 text-sm text-muted-foreground">
                {summary.lastUpdated
                  ? `Last change ${relativeTime(summary.lastUpdated)}.`
                  : "Nothing added yet."}{" "}
                Aiden, campaigns and your WhatsApp shop all use this list.
              </p>
            </div>
            {summary.site && can("ai.configure") ? (
              <Button
                variant="outline"
                disabled={busy || reading}
                onClick={() => void refreshFromWebsite()}
              >
                {busy || reading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
                )}
                {reading ? "Reading your website…" : "Refresh from website"}
              </Button>
            ) : null}
          </div>
          <dl className="m-0 grid grid-cols-2 gap-x-6 border-t border-line pt-4 wide:grid-cols-4">
            <Stat label="From your website" value={summary.website} />
            <Stat label="From your store" value={summary.store} />
            <Stat label="Hidden from customers" value={summary.hidden} />
            <Stat label="Without a photo" value={summary.noPhoto} />
          </dl>
          <p className="m-0 text-sm text-muted-foreground">
            {summary.collections > 0
              ? `${summary.collections} collection${summary.collections === 1 ? "" : "s"} group these for campaigns and flows. `
              : "No collections yet. "}
            <Link
              to="/app/catalog/collections"
              className="font-semibold text-aiden-deep underline-offset-4 hover:underline"
            >
              {summary.collections > 0 ? "See collections" : "Make one"}
            </Link>
          </p>
        </section>
        {below}
      </div>

      {shopOn ? (
        <section aria-labelledby="shop-wa-heading" className="flex flex-col items-center gap-4">
          <div className="self-stretch">
            <h2 id="shop-wa-heading" className="m-0 font-display text-[1.25rem] font-semibold">
              WhatsApp shop
            </h2>
            <p className="m-0 text-sm text-muted-foreground">
              How your products look to a customer in WhatsApp.
            </p>
          </div>
          <PhoneFrame label="Your products in a WhatsApp chat" className="phone:max-w-[300px]">
            <div className="-mt-4 flex flex-col gap-2">
              <PhoneMessage
                text="Take a look at our shop. Tap a piece to see it, or add it to your cart."
                buttons={["View catalogue"]}
              />
              {summary.preview.map((p) => (
                <ProductBubble
                  key={p.id}
                  title={p.title}
                  detail={p.price === null ? "Price on request" : formatMoney(p.price, p.currency)}
                  image={p.image_url}
                  imageAlt={p.title}
                  className="w-[200px] [&_b]:text-sm"
                />
              ))}
            </div>
          </PhoneFrame>
          <div className="w-full">{shopCard}</div>
        </section>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col py-1.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="m-0 font-display text-[1.5rem] font-semibold tabular-nums">
        <NumberTicker value={value} />
      </dd>
    </div>
  );
}
