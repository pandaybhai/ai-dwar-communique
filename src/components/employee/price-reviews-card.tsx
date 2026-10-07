import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { knowledgeApi } from "@/lib/employee-client";

type Review = {
  id: string;
  title: string;
  sku: string | null;
  price: number | null;
  product_url: string | null;
  price_review: { old_price: number | null; new_price: number; url: string; seen_at: string };
};

const money = (n: number | null) => (n === null ? "—" : `₹${new Intl.NumberFormat("en-IN").format(Math.round(n))}`);

/**
 * Batch 16: the daily price check found a product page whose price moved by
 * more than half. It never changes that on its own — the merchant decides.
 * Hidden when there is nothing to check.
 */
export function PriceReviewsCard({ organizationId, canConfigure }: { organizationId: string; canConfigure: boolean }) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await knowledgeApi<{ reviews: Review[] }>({ organization_id: organizationId, action: "price_reviews" });
    setReviews(data?.reviews ?? []);
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const resolve = async (review: Review, apply: boolean) => {
    setBusy(review.id);
    const { error } = await knowledgeApi({
      organization_id: organizationId,
      action: "resolve_price_review",
      product_id: review.id,
      apply,
    });
    setBusy(null);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success(apply ? "Price updated." : "Kept your price.");
    await load();
  };

  if (reviews.length === 0) return null;

  return (
    <section aria-labelledby="price-reviews-heading" className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 id="price-reviews-heading" className="text-base font-semibold text-foreground">
            Prices to check
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            I check your product pages every day. These prices changed by more than half, so I haven't changed
            them — customers still see your current price until you decide.
          </p>
        </div>
      </div>
      <ul className="mt-4 space-y-3">
        {reviews.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border/70 bg-card px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">
                {r.title}
                {r.sku && r.sku !== r.title ? <span className="text-muted-foreground"> · {r.sku}</span> : null}
              </p>
              <p className="text-xs text-muted-foreground">
                Ours: {money(r.price_review.old_price ?? r.price)} · Your website now: {money(r.price_review.new_price)}{" "}
                <a className="text-primary underline-offset-4 hover:underline" href={r.price_review.url} target="_blank" rel="noreferrer">
                  Open page
                </a>
              </p>
            </div>
            {canConfigure ? (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={busy === r.id} onClick={() => void resolve(r, false)}>
                  Keep {money(r.price_review.old_price ?? r.price)}
                </Button>
                <Button size="sm" disabled={busy === r.id} onClick={() => void resolve(r, true)}>
                  {busy === r.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Use {money(r.price_review.new_price)}
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
