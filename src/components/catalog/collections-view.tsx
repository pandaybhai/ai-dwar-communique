import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, FolderPlus, Layers, Loader2, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { callApi } from "@/lib/whatsapp-client";
import { usePermissions } from "@/hooks/use-permissions";
import { type CollectionRow, type ProductRow } from "@/lib/catalog";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { TableSkeleton } from "@/components/data-pagination";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Counts = Record<string, number>;

export function CollectionsView({ organizationId }: { organizationId: string }) {
  const { can } = usePermissions();
  const canManage = can("catalog.manage");

  const [collections, setCollections] = useState<CollectionRow[]>([]);
  const [counts, setCounts] = useState<Counts>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<CollectionRow | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  const [assigning, setAssigning] = useState<CollectionRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [{ data, error: loadError }, { data: items, error: itemsError }] = await Promise.all([
      aidwar
        .from("product_collections")
        .select("id, organization_id, name, slug, description, image_url, sort_order")
        .eq("organization_id", organizationId)
        .order("sort_order")
        .order("name"),
      aidwar
        .from("product_collection_items")
        .select("collection_id")
        .eq("organization_id", organizationId),
    ]);
    if (loadError || itemsError) {
      setError((loadError ?? itemsError)?.message ?? "We couldn't load your collections.");
      setLoading(false);
      return;
    }
    setCollections((data as CollectionRow[]) ?? []);
    const tally: Counts = {};
    for (const item of ((items as { collection_id: string }[]) ?? [])) {
      tally[item.collection_id] = (tally[item.collection_id] ?? 0) + 1;
    }
    setCounts(tally);
    setLoading(false);
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(body: Record<string, unknown>, success: string) {
    const { error: callError } = await callApi("/api/catalog/products", {
      body: { organization_id: organizationId, ...body },
    });
    if (callError) {
      toast.error(callError);
      return false;
    }
    toast.success(success);
    await load();
    return true;
  }

  async function save() {
    if (!name.trim()) {
      toast.error("Give the collection a name.");
      return;
    }
    setSaving(true);
    const ok = await act(
      {
        action: "collection_save",
        id: editing?.id ?? null,
        name,
        description,
      },
      editing ? "Collection renamed." : "Collection created.",
    );
    setSaving(false);
    if (ok) setDialogOpen(false);
  }

  function move(index: number, direction: -1 | 1) {
    const next = [...collections];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    const a = next[index]!;
    const b = next[target]!;
    next[index] = b;
    next[target] = a;
    setCollections(next);
    void act({ action: "collection_reorder", ids: next.map((c) => c.id) }, "Order saved.");
  }

  if (loading) return <TableSkeleton />;
  if (error) return <ErrorState message={error} />;

  return (
    <>
      <div className="mb-6 flex justify-end">
        {canManage ? (
          <Button
            onClick={() => {
              setEditing(null);
              setName("");
              setDescription("");
              setDialogOpen(true);
            }}
          >
            <FolderPlus className="mr-2 h-4 w-4" /> New collection
          </Button>
        ) : null}
      </div>

      {collections.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No collections yet"
          description="Group products the way you talk about them — 'Festive picks', 'Under ₹999' — and reuse them everywhere."
          action={
            canManage ? (
              <Button
                onClick={() => {
                  setEditing(null);
                  setName("");
                  setDescription("");
                  setDialogOpen(true);
                }}
              >
                <FolderPlus className="mr-2 h-4 w-4" /> New collection
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-3">
          {collections.map((collection, index) => (
            <div
              key={collection.id}
              className="flex flex-wrap items-center gap-3 rounded-2xl border border-border/70 bg-card p-4 shadow-sm transition-shadow duration-200 hover:shadow-md"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-foreground">{collection.name}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {counts[collection.id] ?? 0} product
                  {(counts[collection.id] ?? 0) === 1 ? "" : "s"}
                  {collection.description ? ` · ${collection.description}` : ""}
                </p>
              </div>
              {canManage ? (
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Move up"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Move down"
                    disabled={index === collections.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setAssigning(collection)}>
                    Assign products
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Rename ${collection.name}`}
                    onClick={() => {
                      setEditing(collection);
                      setName(collection.name);
                      setDescription(collection.description ?? "");
                      setDialogOpen(true);
                    }}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${collection.name}`}
                    onClick={() => {
                      if (!window.confirm(`Delete "${collection.name}"? Products stay in the catalogue.`)) {
                        return;
                      }
                      void act(
                        { action: "collection_delete", id: collection.id },
                        "Collection deleted.",
                      );
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Rename collection" : "New collection"}</DialogTitle>
            <DialogDescription>
              Collections are just groups of products you can reuse in campaigns and flows.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="collection-name">Name</Label>
              <Input
                id="collection-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Festive picks"
              />
            </div>
            <div>
              <Label htmlFor="collection-description">Description</Label>
              <Textarea
                id="collection-description"
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {editing ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {assigning ? (
        <AssignProductsDialog
          organizationId={organizationId}
          collection={assigning}
          onClose={() => setAssigning(null)}
          onSaved={() => void load()}
        />
      ) : null}
    </>
  );
}

function AssignProductsDialog({
  organizationId,
  collection,
  onClose,
  onSaved,
}: {
  organizationId: string;
  collection: CollectionRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [products, setProducts] = useState<Pick<ProductRow, "id" | "title" | "sku">[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [initial, setInitial] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [{ data, error: productsError }, { data: items, error: itemsError }] = await Promise.all([
        aidwar
          .from("products")
          .select("id, title, sku")
          .eq("organization_id", organizationId)
          .order("title")
          .limit(500),
        aidwar
          .from("product_collection_items")
          .select("product_id")
          .eq("organization_id", organizationId)
          .eq("collection_id", collection.id),
      ]);
      if (cancelled) return;
      if (productsError || itemsError) {
        setError((productsError ?? itemsError)?.message ?? "We couldn't load your products.");
        setLoading(false);
        return;
      }
      setProducts((data as Pick<ProductRow, "id" | "title" | "sku">[]) ?? []);
      const chosen = ((items as { product_id: string }[]) ?? []).map((i) => i.product_id);
      setSelected(chosen);
      setInitial(chosen);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId, collection.id]);

  async function save() {
    setSaving(true);
    const added = selected.filter((id) => !initial.includes(id));
    const removed = initial.filter((id) => !selected.includes(id));

    for (const [ids, remove] of [
      [added, false],
      [removed, true],
    ] as [string[], boolean][]) {
      if (!ids.length) continue;
      const { error: callError } = await callApi("/api/catalog/products", {
        body: {
          action: "collection_assign",
          organization_id: organizationId,
          collection_id: collection.id,
          product_ids: ids,
          remove,
        },
      });
      if (callError) {
        setSaving(false);
        toast.error(callError);
        return;
      }
    }
    setSaving(false);
    toast.success("Collection updated.");
    onSaved();
    onClose();
  }

  const visible = products.filter((p) =>
    search.trim() ? p.title.toLowerCase().includes(search.trim().toLowerCase()) : true,
  );

  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="max-h-[85vh] overflow-hidden">
        <DialogHeader>
          <DialogTitle>Products in {collection.name}</DialogTitle>
          <DialogDescription>Tick everything that belongs in this collection.</DialogDescription>
        </DialogHeader>

        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search products…"
        />

        {loading ? (
          <TableSkeleton rows={4} />
        ) : error ? (
          <ErrorState message={error} />
        ) : (
          <div className="max-h-[45vh] space-y-1 overflow-y-auto">
            {visible.map((product) => (
              <label
                key={product.id}
                className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-sm hover:bg-muted/60"
              >
                <Checkbox
                  checked={selected.includes(product.id)}
                  onCheckedChange={(checked) =>
                    setSelected((s) =>
                      checked === true ? [...s, product.id] : s.filter((id) => id !== product.id),
                    )
                  }
                />
                <span className="min-w-0 flex-1 truncate text-foreground">{product.title}</span>
                <span className="text-xs text-muted-foreground">{product.sku ?? ""}</span>
              </label>
            ))}
            {visible.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                No products match that search.
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving || loading}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
