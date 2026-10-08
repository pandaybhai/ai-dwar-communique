import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { callApi } from "@/lib/whatsapp-client";
import { usePermissions } from "@/hooks/use-permissions";
import { CATEGORY_WORDS_SETTING, cleanCategoryWords } from "@/lib/shop-categories";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * "Words your customers use": the workspace's own extra words for each of
 * its categories (organizations.branding.category_words). Aiden's product
 * search and the flows "Show products" step find a category by its own name
 * or by these words — there is no built-in list of product kinds. Optional:
 * nothing filled in means categories are found by their own names only.
 */
export function CategoryWordsCard({ organizationId }: { organizationId: string }) {
  const { can } = usePermissions();
  const [open, setOpen] = useState(false);
  const [categories, setCategories] = useState<string[] | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const [products, org] = await Promise.all([
      aidwar
        .from("products")
        .select("category")
        .eq("organization_id", organizationId)
        .eq("is_visible", true)
        .not("category", "is", null)
        .limit(5000),
      aidwar.from("organizations").select("branding").eq("id", organizationId).maybeSingle(),
    ]);
    const names = new Map<string, number>();
    for (const row of (products.data ?? []) as Array<{ category: string | null }>) {
      const name = (row.category ?? "").trim();
      if (name) names.set(name, (names.get(name) ?? 0) + 1);
    }
    const branding = ((org.data as { branding?: Record<string, unknown> | null } | null)?.branding ?? {}) as Record<
      string,
      unknown
    >;
    const saved = cleanCategoryWords(branding[CATEGORY_WORDS_SETTING]);
    const list = [...names.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    // A category with saved words but no visible products right now still shows.
    for (const name of Object.keys(saved)) if (!list.includes(name)) list.push(name);
    setCategories(list);
    setDraft(Object.fromEntries(list.map((name) => [name, (saved[name] ?? []).join(", ")])));
  }, [organizationId]);

  useEffect(() => {
    if (open && categories === null) void load();
  }, [open, categories, load]);

  if (!can("catalog.manage")) return null;

  async function save() {
    setSaving(true);
    const words = Object.fromEntries(
      Object.entries(draft).map(([name, text]) => [name, text.split(",").map((w) => w.trim()).filter(Boolean)]),
    );
    const { error } = await callApi("/api/catalog/products", {
      body: { organization_id: organizationId, action: "save_category_words", category_words: words },
    });
    setSaving(false);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success("Saved — Aiden and your flows use these words from the next message.");
  }

  return (
    <div className="mb-6 rounded-xl border bg-card">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span>
          <span className="block text-sm font-medium">Words your customers use for your categories</span>
          <span className="block text-xs text-muted-foreground">
            Optional. Products are found by your own category names; add any other words customers use for a
            category (another language, a short name), separated by commas.
          </span>
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div className="space-y-3 border-t px-4 py-4">
          {categories === null ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : categories.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              None of your products has a category yet. Add one to a product and it shows up here.
            </p>
          ) : (
            <>
              {categories.map((name) => (
                <div key={name} className="grid gap-1.5 sm:grid-cols-[minmax(0,12rem)_1fr] sm:items-center">
                  <span className="truncate text-sm font-medium">{name}</span>
                  <Input
                    value={draft[name] ?? ""}
                    placeholder="Other words for this category, comma separated"
                    onChange={(e) => setDraft((d) => ({ ...d, [name]: e.target.value }))}
                  />
                </div>
              ))}
              <div className="flex justify-end">
                <Button size="sm" disabled={saving} onClick={() => void save()}>
                  {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Save words
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
