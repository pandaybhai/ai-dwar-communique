import { useCallback, useEffect, useRef, useState } from "react";
import { Layers, Lock } from "lucide-react";
import { CatalogView } from "@/components/catalog/catalog-view";
import { CategoryWordsCard } from "@/components/catalog/category-words-card";
import { CollectionsView } from "@/components/catalog/collections-view";
import { WhatsAppShopCard } from "@/components/catalog/whatsapp-shop-card";
import { EmptyState, PageHeader, PageSkeleton } from "@/components/empty-state";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { usePermissions } from "@/hooks/use-permissions";
import { aidwar } from "@/integrations/aidwar/client";
import { type CollectionRow } from "@/lib/catalog";
import { useOrg } from "@/lib/org-context";
import { ShopOverview } from "./shop-overview";

const CATALOGUE_DESCRIPTION =
  "Everything you sell: names, prices, photos and details, read from your website or store, uploaded or added by hand. Aiden uses them to answer customers and show the right pieces.";

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
        <PageHeader title="Catalogue" description={CATALOGUE_DESCRIPTION} />
        <EmptyState
          icon={Lock}
          title="Products are turned off"
          description="This feature isn't enabled for your workspace yet. Reach out to your administrator to switch it on."
        />
      </>
    );
  }
  if (!can("catalog.view")) {
    return (
      <>
        <PageHeader title="Catalogue" description={CATALOGUE_DESCRIPTION} />
        <EmptyState
          icon={Lock}
          title="You don't have access to Products"
          description="Ask an owner or admin of this workspace to give you access to Products."
        />
      </>
    );
  }
  return (
    <>
      <PageHeader title="Catalogue" description={CATALOGUE_DESCRIPTION} />
      <ShopOverview
        organizationId={organizationId}
        shopCard={<WhatsAppShopCard organizationId={organizationId} />}
        below={<CategoryWordsCard organizationId={organizationId} />}
      />
      <CatalogView organizationId={organizationId} />
    </>
  );
}

type CollectionCard = CollectionRow & { count: number; images: Array<{ id: string; title: string; image_url: string }> };

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
      aidwar.from("product_collection_items").select("collection_id, product_id").eq("organization_id", organizationId),
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
      ? await aidwar.from("products").select("id, title, image_url").eq("organization_id", organizationId).in("id", wanted.slice(0, 300))
      : { data: [] };
    const withPhoto = new Map(
      ((prods ?? []) as Array<{ id: string; title: string; image_url: string | null }>)
        .filter((p) => p.image_url)
        .map((p) => [p.id, { id: p.id, title: p.title, image_url: p.image_url! }]),
    );
    setCards(
      list.map((c) => {
        const ids = byCollection.get(c.id) ?? [];
        return { ...c, count: ids.length, images: ids.map((id) => withPhoto.get(id)).filter((x): x is NonNullable<typeof x> => Boolean(x)).slice(0, 4) };
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
        <PageHeader title="Collections" description="Groups of products you can reuse." />
        <EmptyState
          icon={Lock}
          title="Collections aren't available to you"
          description="Either the catalogue is switched off for this workspace, or you don't have access to it yet."
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Collections"
        description="Group products the way you talk about them, then reuse those groups in campaigns and flows."
      />
      {cards && cards.length > 0 ? (
        <ul className="m-0 mb-10 grid list-none gap-4 p-0 wide:grid-cols-3">
          {cards.map((c) => (
            <li key={c.id} className="flex flex-col gap-3 rounded-[20px] border border-line bg-surface p-3 shadow-md">
              <div aria-hidden="true" className="grid aspect-[16/9] grid-cols-2 grid-rows-2 gap-1 overflow-hidden rounded-[14px] bg-bubble-in">
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
                  {c.count} product{c.count === 1 ? "" : "s"}
                  {c.description ? `, ${c.description}` : ""}
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <section aria-labelledby="manage-collections-heading" className="flex flex-col gap-2">
        <h2 id="manage-collections-heading" className="m-0 font-display text-[1.25rem] font-semibold">
          Manage collections
        </h2>
        <div ref={manager}>
          <CollectionsView organizationId={organizationId} />
        </div>
      </section>
    </>
  );
}
