import { useEffect, useRef, useState } from "react";
import { ImagePlus, Loader2, Unlink } from "lucide-react";
import { toast } from "sonner";
import { callApi, uploadApi } from "@/lib/whatsapp-client";
import {
  AVAILABILITY_LABELS,
  AVAILABILITY_VALUES,
  relativeTime,
  type Availability,
  type ProductRow,
} from "@/lib/catalog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Draft = {
  title: string;
  description: string;
  sku: string;
  brand: string;
  category: string;
  price: string;
  compare_at_price: string;
  inventory_quantity: string;
  availability: Availability;
  image_url: string;
  product_url: string;
  is_visible: boolean;
};

const emptyDraft: Draft = {
  title: "",
  description: "",
  sku: "",
  brand: "",
  category: "",
  price: "",
  compare_at_price: "",
  inventory_quantity: "",
  availability: "in_stock",
  image_url: "",
  product_url: "",
  is_visible: true,
};

function toDraft(product: ProductRow): Draft {
  return {
    title: product.title ?? "",
    description: product.description ?? "",
    sku: product.sku ?? "",
    brand: product.brand ?? "",
    category: product.category ?? "",
    price: product.price === null ? "" : String(product.price),
    compare_at_price: product.compare_at_price === null ? "" : String(product.compare_at_price),
    inventory_quantity:
      product.inventory_quantity === null ? "" : String(product.inventory_quantity),
    availability: product.availability,
    image_url: product.image_url ?? "",
    product_url: product.product_url ?? "",
    is_visible: product.is_visible,
  };
}

export function ProductDialog({
  organizationId,
  product,
  open,
  onOpenChange,
  onSaved,
}: {
  organizationId: string;
  /** Null when adding a product by hand. */
  product: ProductRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const fromShopify = product?.source === "shopify";

  useEffect(() => {
    if (open) setDraft(product ? toDraft(product) : emptyDraft);
  }, [open, product]);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  async function upload(file: File) {
    setUploading(true);
    const form = new FormData();
    form.append("organization_id", organizationId);
    form.append("file", file);
    const { data, error } = await uploadApi<{ url: string }>("/api/catalog/image", form);
    setUploading(false);
    if (error || !data) {
      toast.error(error ?? "We couldn't upload that image.");
      return;
    }
    set({ image_url: data.url });
    toast.success("Image uploaded.");
  }

  async function save() {
    if (!draft.title.trim()) {
      toast.error("Give the product a name.");
      return;
    }
    setSaving(true);
    const { error } = await callApi("/api/catalog/products", {
      body: {
        action: "save",
        organization_id: organizationId,
        id: product?.id ?? null,
        title: draft.title,
        description: draft.description,
        sku: draft.sku,
        brand: draft.brand,
        category: draft.category,
        price: draft.price === "" ? null : Number(draft.price),
        compare_at_price: draft.compare_at_price === "" ? null : Number(draft.compare_at_price),
        inventory_quantity: draft.inventory_quantity === "" ? null : draft.inventory_quantity,
        availability: draft.availability,
        image_url: draft.image_url,
        product_url: draft.product_url,
        is_visible: draft.is_visible,
      },
    });
    setSaving(false);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success(product ? "Product updated." : "Product added.");
    onOpenChange(false);
    onSaved();
  }

  async function unlink() {
    if (!product) return;
    const { error } = await callApi("/api/catalog/products", {
      body: { action: "unlink", organization_id: organizationId, id: product.id },
    });
    if (error) {
      toast.error(error);
      return;
    }
    toast.success("Unlinked from Shopify. This product is yours to edit now.");
    onOpenChange(false);
    onSaved();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{product ? "Edit product" : "Add a product"}</DialogTitle>
          <DialogDescription>
            {product
              ? "Change the details your customers see when this product is shared."
              : "Add one product by hand — useful for anything that isn't in your store."}
          </DialogDescription>
        </DialogHeader>

        {fromShopify ? (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
            <p className="font-medium text-foreground">
              This product comes from Shopify — last updated {relativeTime(product?.synced_at)}.
            </p>
            <p className="mt-1 text-muted-foreground">
              Shopify will overwrite anything you change here on the next sync, unless you unlink
              this product.
            </p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void unlink()}>
              <Unlink className="mr-2 h-4 w-4" /> Unlink from Shopify
            </Button>
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="product-title">Product name</Label>
            <Input
              id="product-title"
              value={draft.title}
              onChange={(e) => set({ title: e.target.value })}
              placeholder="Cotton Kurta — Blue"
            />
          </div>

          <div className="sm:col-span-2">
            <Label htmlFor="product-description">Description</Label>
            <Textarea
              id="product-description"
              rows={3}
              value={draft.description}
              onChange={(e) => set({ description: e.target.value })}
              placeholder="What makes it worth buying?"
            />
          </div>

          <div>
            <Label htmlFor="product-price">Price</Label>
            <Input
              id="product-price"
              inputMode="decimal"
              value={draft.price}
              onChange={(e) => set({ price: e.target.value })}
              placeholder="1299"
            />
          </div>
          <div>
            <Label htmlFor="product-compare">Compare-at price</Label>
            <Input
              id="product-compare"
              inputMode="decimal"
              value={draft.compare_at_price}
              onChange={(e) => set({ compare_at_price: e.target.value })}
              placeholder="1799"
            />
          </div>

          <div>
            <Label htmlFor="product-sku">SKU</Label>
            <Input
              id="product-sku"
              value={draft.sku}
              onChange={(e) => set({ sku: e.target.value })}
              placeholder="KUR-BLU-M"
            />
          </div>
          <div>
            <Label htmlFor="product-stock">Stock</Label>
            <Input
              id="product-stock"
              inputMode="numeric"
              value={draft.inventory_quantity}
              onChange={(e) => set({ inventory_quantity: e.target.value })}
              placeholder="12"
            />
          </div>

          <div>
            <Label htmlFor="product-brand">Brand</Label>
            <Input
              id="product-brand"
              value={draft.brand}
              onChange={(e) => set({ brand: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="product-category">Category</Label>
            <Input
              id="product-category"
              value={draft.category}
              onChange={(e) => set({ category: e.target.value })}
            />
          </div>

          <div>
            <Label>Availability</Label>
            <Select
              value={draft.availability}
              onValueChange={(v) => set({ availability: v as Availability })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AVAILABILITY_VALUES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {AVAILABILITY_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="product-url">Product link</Label>
            <Input
              id="product-url"
              value={draft.product_url}
              onChange={(e) => set({ product_url: e.target.value })}
              placeholder="https://…"
            />
          </div>

          <div className="sm:col-span-2">
            <Label>Image</Label>
            <div className="mt-2 flex items-center gap-4">
              <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border/70 bg-muted/40">
                {draft.image_url ? (
                  <img
                    src={draft.image_url}
                    alt={draft.title || "Product image"}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <ImagePlus className="h-6 w-6 text-muted-foreground" />
                )}
              </div>
              <div className="flex-1 space-y-2">
                <Input
                  value={draft.image_url}
                  onChange={(e) => set({ image_url: e.target.value })}
                  placeholder="Paste an image URL, or upload one"
                />
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void upload(file);
                    e.target.value = "";
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={uploading}
                  onClick={() => fileRef.current?.click()}
                >
                  {uploading ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <ImagePlus className="mr-2 h-4 w-4" />
                  )}
                  Upload image
                </Button>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-xl border border-border/70 p-3 sm:col-span-2">
            <div>
              <p className="text-sm font-medium text-foreground">Visible in the catalogue</p>
              <p className="text-xs text-muted-foreground">
                Hidden products stay saved but never appear in messages or AI answers.
              </p>
            </div>
            <Switch
              checked={draft.is_visible}
              onCheckedChange={(checked) => set({ is_visible: checked })}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {product ? "Save changes" : "Add product"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
