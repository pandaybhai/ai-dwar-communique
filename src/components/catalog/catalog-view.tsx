import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Eye,
  EyeOff,
  FolderPlus,
  LayoutGrid,
  List,
  Package,
  Pencil,
  Plus,
  Search,
  ShoppingBag,
  Trash2,
  Upload,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { callApi } from "@/lib/whatsapp-client";
import { usePermissions } from "@/hooks/use-permissions";
import {
  AVAILABILITY_LABELS,
  AVAILABILITY_VALUES,
  SOURCE_LABELS,
  formatMoney,
  relativeTime,
  toTsQuery,
  type CollectionRow,
  type ProductRow,
} from "@/lib/catalog";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { NoResults, Pagination, TableSkeleton } from "@/components/data-pagination";
import { ProductDialog } from "@/components/catalog/product-dialog";
import { ImportProductsDialog } from "@/components/catalog/import-products-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const PAGE_SIZE = 24;

const PRODUCT_COLUMNS =
  "id, organization_id, integration_id, external_id, title, description, sku, brand, category, price, compare_at_price, currency, availability, inventory_quantity, image_url, additional_image_urls, product_url, source, is_visible, synced_at, updated_at";

export function CatalogView({ organizationId }: { organizationId: string }) {
  const { can } = usePermissions();
  const canManage = can("catalog.manage");
  const canImport = can("catalog.import");

  const [view, setView] = useState<"grid" | "list">("grid");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [collectionFilter, setCollectionFilter] = useState("all");
  const [availabilityFilter, setAvailabilityFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");

  const [products, setProducts] = useState<ProductRow[]>([]);
  const [collections, setCollections] = useState<CollectionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<ProductRow | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  const loadCollections = useCallback(async () => {
    const { data, error: loadError } = await aidwar
      .from("product_collections")
      .select("id, organization_id, name, slug, description, image_url, sort_order")
      .eq("organization_id", organizationId)
      .order("sort_order")
      .order("name");
    if (loadError) {
      toast.error(loadError.message);
      return;
    }
    setCollections((data as CollectionRow[]) ?? []);
  }, [organizationId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    let productIdFilter: string[] | null = null;
    if (collectionFilter !== "all") {
      const { data: items, error: itemsError } = await aidwar
        .from("product_collection_items")
        .select("product_id")
        .eq("organization_id", organizationId)
        .eq("collection_id", collectionFilter);
      if (itemsError) {
        setError(itemsError.message);
        setLoading(false);
        return;
      }
      productIdFilter = ((items as { product_id: string }[]) ?? []).map((i) => i.product_id);
      if (!productIdFilter.length) {
        setProducts([]);
        setTotal(0);
        setLoading(false);
        return;
      }
    }

    let query = aidwar
      .from("products")
      .select(PRODUCT_COLUMNS, { count: "exact" })
      .eq("organization_id", organizationId)
      .order("updated_at", { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

    if (productIdFilter) query = query.in("id", productIdFilter);
    const tsquery = toTsQuery(debounced);
    if (tsquery) query = query.textSearch("search_vector", tsquery);
    if (availabilityFilter !== "all") query = query.eq("availability", availabilityFilter);
    if (sourceFilter !== "all") query = query.eq("source", sourceFilter);
    if (minPrice.trim()) query = query.gte("price", Number(minPrice));
    if (maxPrice.trim()) query = query.lte("price", Number(maxPrice));

    const { data, error: loadError, count } = await query;
    if (loadError) {
      setError(loadError.message);
      setLoading(false);
      return;
    }
    setProducts((data as ProductRow[]) ?? []);
    setTotal(count ?? 0);
    setSelected([]);
    setLoading(false);
  }, [
    organizationId,
    page,
    debounced,
    collectionFilter,
    availabilityFilter,
    sourceFilter,
    minPrice,
    maxPrice,
  ]);

  useEffect(() => {
    void loadCollections();
  }, [loadCollections]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtersActive =
    Boolean(debounced) ||
    collectionFilter !== "all" ||
    availabilityFilter !== "all" ||
    sourceFilter !== "all" ||
    Boolean(minPrice) ||
    Boolean(maxPrice);

  const allSelected = products.length > 0 && selected.length === products.length;

  async function act(body: Record<string, unknown>, success: string) {
    const { error: callError } = await callApi("/api/catalog/products", {
      body: { organization_id: organizationId, ...body },
    });
    if (callError) {
      toast.error(callError);
      return;
    }
    toast.success(success);
    await load();
  }

  const bulkBar = selected.length > 0 && canManage;

  const header = (
    <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex flex-1 flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search products, SKUs, brands…"
            className="pl-9"
          />
        </div>
        <Select
          value={collectionFilter}
          onValueChange={(v) => {
            setCollectionFilter(v);
            setPage(0);
          }}
        >
          <SelectTrigger className="w-[170px]">
            <SelectValue placeholder="Collection" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All collections</SelectItem>
            {collections.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={availabilityFilter}
          onValueChange={(v) => {
            setAvailabilityFilter(v);
            setPage(0);
          }}
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Availability" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any availability</SelectItem>
            {AVAILABILITY_VALUES.map((value) => (
              <SelectItem key={value} value={value}>
                {AVAILABILITY_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={sourceFilter}
          onValueChange={(v) => {
            setSourceFilter(v);
            setPage(0);
          }}
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any source</SelectItem>
            <SelectItem value="shopify">Shopify</SelectItem>
            <SelectItem value="import">Uploaded</SelectItem>
            <SelectItem value="manual">Added manually</SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={minPrice}
          onChange={(e) => {
            setMinPrice(e.target.value);
            setPage(0);
          }}
          inputMode="decimal"
          placeholder="Min ₹"
          className="w-[90px]"
        />
        <Input
          value={maxPrice}
          onChange={(e) => {
            setMaxPrice(e.target.value);
            setPage(0);
          }}
          inputMode="decimal"
          placeholder="Max ₹"
          className="w-[90px]"
        />
      </div>

      <div className="flex items-center gap-2">
        <div className="flex rounded-lg border border-border/70 p-0.5">
          <Button
            variant={view === "grid" ? "secondary" : "ghost"}
            size="icon"
            className="h-8 w-8"
            aria-label="Grid view"
            onClick={() => setView("grid")}
          >
            <LayoutGrid className="h-4 w-4" />
          </Button>
          <Button
            variant={view === "list" ? "secondary" : "ghost"}
            size="icon"
            className="h-8 w-8"
            aria-label="List view"
            onClick={() => setView("list")}
          >
            <List className="h-4 w-4" />
          </Button>
        </div>
        <Button variant="outline" asChild>
          <Link to="/app/catalog/collections">Collections</Link>
        </Button>
        {canImport ? (
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <Upload className="mr-2 h-4 w-4" /> Upload a file
          </Button>
        ) : null}
        {canManage ? (
          <Button
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="mr-2 h-4 w-4" /> Add a product
          </Button>
        ) : null}
      </div>
    </div>
  );

  return (
    <>
      {header}

      {bulkBar ? (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm">
          <span className="font-medium text-foreground">{selected.length} selected</span>
          {collections.length ? (
            <Select
              onValueChange={(collectionId) =>
                void act(
                  { action: "collection_assign", collection_id: collectionId, product_ids: selected },
                  "Added to the collection.",
                )
              }
            >
              <SelectTrigger className="h-8 w-[190px]">
                <SelectValue placeholder="Add to collection" />
              </SelectTrigger>
              <SelectContent>
                {collections.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Button variant="ghost" size="sm" asChild>
              <Link to="/app/catalog/collections">
                <FolderPlus className="mr-2 h-4 w-4" /> Create a collection
              </Link>
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void act(
                { action: "set_visibility", ids: selected, is_visible: false },
                "Those products are hidden now.",
              )
            }
          >
            <EyeOff className="mr-2 h-4 w-4" /> Hide
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void act(
                { action: "set_visibility", ids: selected, is_visible: true },
                "Those products are visible again.",
              )
            }
          >
            <Eye className="mr-2 h-4 w-4" /> Show
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              if (!window.confirm(`Delete ${selected.length} product(s)? This can't be undone.`)) {
                return;
              }
              void act({ action: "delete", ids: selected }, "Products deleted.");
            }}
          >
            <Trash2 className="mr-2 h-4 w-4" /> Delete
          </Button>
        </div>
      ) : null}

      {loading ? (
        <TableSkeleton />
      ) : error ? (
        <ErrorState message={error} />
      ) : products.length === 0 && filtersActive ? (
        <NoResults />
      ) : products.length === 0 ? (
        <EmptyState
          icon={Package}
          title="Your catalogue is empty"
          description="Bring your products in once, and every campaign, flow and AI answer can use them."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="outline" asChild>
                <Link to="/app/settings">
                  <ShoppingBag className="mr-2 h-4 w-4" /> Connect your store
                </Link>
              </Button>
              {canImport ? (
                <Button variant="outline" onClick={() => setImportOpen(true)}>
                  <Upload className="mr-2 h-4 w-4" /> Upload a file
                </Button>
              ) : null}
              {canManage ? (
                <Button
                  onClick={() => {
                    setEditing(null);
                    setDialogOpen(true);
                  }}
                >
                  <Plus className="mr-2 h-4 w-4" /> Add a product
                </Button>
              ) : null}
            </div>
          }
        />
      ) : view === "grid" ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {products.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              selected={selected.includes(product.id)}
              selectable={canManage}
              onSelect={(checked) =>
                setSelected((s) =>
                  checked ? [...s, product.id] : s.filter((id) => id !== product.id),
                )
              }
              onEdit={() => {
                setEditing(product);
                setDialogOpen(true);
              }}
            />
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border/70 bg-card shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                {canManage ? (
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allSelected}
                      aria-label="Select all"
                      onCheckedChange={(checked) =>
                        setSelected(checked === true ? products.map((p) => p.id) : [])
                      }
                    />
                  </TableHead>
                ) : null}
                <TableHead>Product</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Availability</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((product) => (
                <TableRow key={product.id} className={product.is_visible ? "" : "opacity-60"}>
                  {canManage ? (
                    <TableCell>
                      <Checkbox
                        checked={selected.includes(product.id)}
                        aria-label={`Select ${product.title}`}
                        onCheckedChange={(checked) =>
                          setSelected((s) =>
                            checked === true ? [...s, product.id] : s.filter((id) => id !== product.id),
                          )
                        }
                      />
                    </TableCell>
                  ) : null}
                  <TableCell className="font-medium text-foreground">{product.title}</TableCell>
                  <TableCell className="text-muted-foreground">{product.sku ?? "—"}</TableCell>
                  <TableCell>
                    {formatMoney(product.price, product.currency)}
                    {product.compare_at_price ? (
                      <span className="ml-2 text-xs text-muted-foreground line-through">
                        {formatMoney(product.compare_at_price, product.currency)}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <AvailabilityBadge product={product} />
                  </TableCell>
                  <TableCell>
                    <SourceBadge product={product} />
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Edit ${product.title}`}
                      onClick={() => {
                        setEditing(product);
                        setDialogOpen(true);
                      }}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {total > PAGE_SIZE ? (
        <div className="mt-4">
          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
        </div>
      ) : null}

      <ProductDialog
        organizationId={organizationId}
        product={editing}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSaved={() => void load()}
      />
      <ImportProductsDialog
        organizationId={organizationId}
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => void load()}
      />
    </>
  );
}

function AvailabilityBadge({ product }: { product: ProductRow }) {
  const tone =
    product.availability === "in_stock"
      ? "bg-primary/10 text-primary"
      : product.availability === "preorder"
        ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
        : "bg-muted text-muted-foreground";
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}>
      {AVAILABILITY_LABELS[product.availability]}
    </span>
  );
}

function SourceBadge({ product }: { product: ProductRow }) {
  return (
    <Badge variant="outline" className="font-normal">
      {SOURCE_LABELS[product.source]}
    </Badge>
  );
}

function ProductCard({
  product,
  selected,
  selectable,
  onSelect,
  onEdit,
}: {
  product: ProductRow;
  selected: boolean;
  selectable: boolean;
  onSelect: (checked: boolean) => void;
  onEdit: () => void;
}) {
  return (
    <div
      className={`group relative overflow-hidden rounded-2xl border bg-card shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md ${
        selected ? "border-primary" : "border-border/70"
      } ${product.is_visible ? "" : "opacity-60"}`}
    >
      {selectable ? (
        <div className="absolute left-3 top-3 z-10 rounded-md bg-background/90 p-1 shadow-sm">
          <Checkbox
            checked={selected}
            aria-label={`Select ${product.title}`}
            onCheckedChange={(checked) => onSelect(checked === true)}
          />
        </div>
      ) : null}

      <div className="flex aspect-[4/3] items-center justify-center bg-muted/40">
        {product.image_url ? (
          <img
            src={product.image_url}
            alt={product.title}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <Package className="h-8 w-8 text-muted-foreground" />
        )}
      </div>

      <div className="space-y-2 p-4">
        <p className="line-clamp-2 text-sm font-semibold text-foreground">{product.title}</p>
        <p className="text-sm">
          <span className="font-medium text-foreground">
            {formatMoney(product.price, product.currency)}
          </span>
          {product.compare_at_price ? (
            <span className="ml-2 text-xs text-muted-foreground line-through">
              {formatMoney(product.compare_at_price, product.currency)}
            </span>
          ) : null}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <AvailabilityBadge product={product} />
          <SourceBadge product={product} />
        </div>
        {product.source === "shopify" ? (
          <p className="text-xs text-muted-foreground">
            Last updated from Shopify {relativeTime(product.synced_at)}
          </p>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="w-full opacity-0 transition-opacity duration-200 group-hover:opacity-100"
          onClick={onEdit}
        >
          <Pencil className="mr-2 h-4 w-4" /> {product.source === "shopify" ? "View" : "Edit"}
        </Button>
      </div>
    </div>
  );
}
