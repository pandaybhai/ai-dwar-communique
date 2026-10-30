import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Layers, Lock } from "lucide-react";
import { CatalogView } from "@/components/catalog/catalog-view";
import { CategoryWordsCard } from "@/components/catalog/category-words-card";
import { CollectionsView } from "@/components/catalog/collections-view";
import { WhatsAppShopCard } from "@/components/catalog/whatsapp-shop-card";
import { EmptyState, PageHeader, PageSkeleton } from "@/components/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { usePermissions } from "@/hooks/use-permissions";
import { aidwar } from "@/integrations/aidwar/client";
import { type CollectionRow } from "@/lib/catalog";
import { useOrg } from "@/lib/org-context";
import { cataloguePage, collectionsPage } from "./copy";
import { ShopOverview } from "./shop-overview";

const CATALOGUE_DESCRIPTION = cataloguePage.description;

/**
 * Batch 49: Shop > Catalogue in the new design. The classic page's gates
 * (catalogs flag, catalog.view), then the new overview (read only, plus
 * ProductsSummary's Refresh from website) with the existing WhatsAppShopCard,
 * the existing CategoryWordsCard and the existing CatalogView: the product
 * grid with photos and prices, its filters, bulk actions, product dialog and
 * upload, unchanged.
 */
export function NewCataloguePage() {
  const { enabled, loading } = useFeatureFlag("catalogs");
  const { can, loading: permissionsLoading } = usePermissions();
  const { active } = useOrg();
  const organizationId = active?.organization.id ?? null;

  if (loading || permissionsLoading || !organizationId) return <PageSkeleton />;
  if (!enabled) {
    return (
      <>
        <PageHeader title={cataloguePage.title} description={CATALOGUE_DESCRIPTION} />
        <EmptyState
          icon={Lock}
          title={cataloguePage.notOn.title}
          description={cataloguePage.notOn.description}
        />
      </>
    );
  }
  if (!can("catalog.view")) {
    return (
      <>
        <PageHeader title={cataloguePage.title} description={CATALOGUE_DESCRIPTION} />
        <EmptyState
          icon={Lock}
          title={cataloguePage.noAccess.title}
          description={cataloguePage.noAccess.description}
        />
      </>
    );
  }
  return (
    <>
      <PageHeader title={cataloguePage.title} description={CATALOGUE_DESCRIPTION} />
      <ShopOverview
        organizationId={organizationId}
        shopCard={<WhatsAppShopCard organizationId={organizationId} />}
        below={<CategoryWordsCard organizationId={organizationId} />}
      />
      <CatalogView organizationId={organizationId} />
    </>
  );
}

type CollectionCard = CollectionRow & {
  count: number;
  images: Array<{ id: string; title: string; image_url: string }>;
};

/**
 * Batch 49: Shop > Collections in the new design: each collection as a card
 * with up to four of its products' photos (read only), then the existing
 * CollectionsView, which keeps every action (new, edit, order, assign,
 * delete). The cards re-read when the manager's list changes.
 */
export function NewCollectionsPage() {
  const { enabled, loading } = useFeatureFlag("catalogs");
  const { can, loading: permissionsLoading } = usePermissions();
  const { active } = useOrg();
  const organizationId = active?.organization.id ?? null;
  const [cards, setCards] = useState<CollectionCard[] | null>(null);
  const manager = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!organizationId) return;
    const [{ data: cols }, { data: items }] = await Promise.all([
      aidwar
        .from("product_collections")
        .select("id, organization_id, name, slug, description, image_url, sort_order")
        .eq("organization_id", organizationId)
        .order("sort_order")
        .order("name"),
      aidwar
        .from("product_collection_items")
        .select("collection_id, product_id")
        .eq("organization_id", organizationId),
    ]);
    const list = (cols ?? []) as CollectionRow[];
    const byCollection = new Map<string, string[]>();
    for (const it of (items ?? []) as Array<{ collection_id: string; product_id: string }>) {
      const ids = byCollection.get(it.collection_id) ?? [];
      ids.push(it.product_id);
      byCollection.set(it.collection_id, ids);
    }
    const wanted = [...new Set(list.flatMap((c) => (byCollection.get(c.id) ?? []).slice(0, 12)))];
    const { data: prods } = wanted.length
      ? await aidwar
          .from("products")
          .select("id, title, image_url")
          .eq("organization_id", organizationId)
          .in("id", wanted.slice(0, 300))
      : { data: [] };
    const withPhoto = new Map(
      ((prods ?? []) as Array<{ id: string; title: string; image_url: string | null }>)
        .filter((p) => p.image_url)
        .map((p) => [p.id, { id: p.id, title: p.title, image_url: p.image_url! }]),
    );
    setCards(
      list.map((c) => {
        const ids = byCollection.get(c.id) ?? [];
        return {
          ...c,
          count: ids.length,
          images: ids
            .map((id) => withPhoto.get(id))
            .filter((x): x is NonNullable<typeof x> => Boolean(x))
            .slice(0, 4),
        };
      }),
    );
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The manager is the classic component: when its list changes (a save, a reorder, a delete), read the cards again.
  useEffect(() => {
    const el = manager.current;
    if (!el || typeof MutationObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new MutationObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 500);
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
    // The manager mounts once the gates below pass.
  }, [load, loading, permissionsLoading]);

  if (loading || permissionsLoading || !organizationId) return <PageSkeleton />;
  if (!enabled || !can("catalog.view")) {
    return (
      <>
        <PageHeader title={collectionsPage.title} description={collectionsPage.shortDescription} />
        <EmptyState
          icon={Lock}
          title={collectionsPage.blocked.title}
          description={collectionsPage.blocked.description}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader title={collectionsPage.title} description={collectionsPage.description} />
      {cards === null ? (
        <div
          aria-busy="true"
          aria-label={collectionsPage.loading}
          className="mb-10 grid gap-4 wide:grid-cols-3"
        >
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-60 rounded-[20px]" />
          ))}
        </div>
      ) : cards.length === 0 ? null : (
        /* No collections: the manager below shows the one empty state (illustrated, with New collection). */
        <ul className="m-0 mb-10 grid list-none gap-4 p-0 wide:grid-cols-3">
          {cards.map((c, i) => (
            <li
              key={c.id}
              style={{ "--d": Math.min(i, 6) } as CSSProperties}
              className="nd-rise flex flex-col gap-3 rounded-[20px] border border-line bg-surface p-3 shadow-md"
            >
              <div
                aria-hidden="true"
                className="grid aspect-[16/9] grid-cols-2 grid-rows-2 gap-1 overflow-hidden rounded-[14px] bg-bubble-in"
              >
                {c.images.length === 0 ? (
                  <span className="col-span-2 row-span-2 grid place-items-center text-muted-foreground">
                    <Layers className="h-6 w-6" />
                  </span>
                ) : (
                  c.images.map((img, i) => (
                    <img
                      key={img.id}
                      src={img.image_url}
                      alt=""
                      loading="lazy"
                      className={
                        c.images.length === 1
                          ? "col-span-2 row-span-2 h-full w-full object-cover"
                          : c.images.length === 2 || (c.images.length === 3 && i === 0)
                            ? "row-span-2 h-full w-full object-cover"
                            : "h-full w-full object-cover"
                      }
                    />
                  ))
                )}
              </div>
              <div className="px-1 pb-1">
                <p className="m-0 font-display text-[1.125rem] font-semibold">{c.name}</p>
                <p className="m-0 text-sm text-muted-foreground">
                  {collectionsPage.count(c.count)}
                  {c.description ? `, ${c.description}` : ""}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <section aria-labelledby="manage-collections-heading" className="flex flex-col gap-2">
        <h2
          id="manage-collections-heading"
          className="m-0 font-display text-[1.25rem] font-semibold"
        >
          {collectionsPage.manage}
        </h2>
        <div ref={manager}>
          <CollectionsView organizationId={organizationId} />
        </div>
      </section>
    </>
  );
}
