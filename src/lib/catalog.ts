/**
 * Catalogue: shared vocabulary between the browser and the server routes.
 *
 * products is written by three different hands — the Shopify sync, a
 * spreadsheet upload, and a person typing — so `source` is what every screen
 * reads to decide what a merchant is allowed to change.
 */

import { toCsv } from "@/lib/csv";

export type ProductSource = "shopify" | "manual" | "import";
export type Availability = "in_stock" | "out_of_stock" | "preorder";

export type ProductRow = {
  id: string;
  organization_id: string;
  integration_id: string | null;
  external_id: string | null;
  title: string;
  description: string | null;
  sku: string | null;
  brand: string | null;
  category: string | null;
  price: number | null;
  compare_at_price: number | null;
  currency: string | null;
  availability: Availability;
  inventory_quantity: number | null;
  image_url: string | null;
  additional_image_urls: string[];
  product_url: string | null;
  source: ProductSource;
  is_visible: boolean;
  synced_at: string | null;
  updated_at: string | null;
};

export type CollectionRow = {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  description: string | null;
  image_url: string | null;
  sort_order: number;
};

export const SOURCE_LABELS: Record<ProductSource, string> = {
  shopify: "Shopify",
  import: "Uploaded",
  manual: "Added manually",
};

export const AVAILABILITY_LABELS: Record<Availability, string> = {
  in_stock: "In stock",
  out_of_stock: "Out of stock",
  preorder: "Pre-order",
};

export const AVAILABILITY_VALUES: Availability[] = ["in_stock", "out_of_stock", "preorder"];

export function isAvailability(value: unknown): value is Availability {
  return typeof value === "string" && (AVAILABILITY_VALUES as string[]).includes(value);
}

/** A parsed spreadsheet value: blank, a real value, or unreadable. */
export type ParsedValue<T> = {
  value: T | null;
  /** true when the cell had content we could not understand. */
  invalid: boolean;
  /** the original text, kept so warnings can name it. */
  raw: string;
};

/** Blank means "not provided". 0 and "0" are values, not blanks. */
export function isBlankCell(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  if (typeof raw === "string") return raw.trim() === "";
  return false;
}

/** "₹ 1,299.00" / "Rs. 1299" / "1 299" all mean the same number. "0" means 0. */
export function readNumber(raw: unknown): ParsedValue<number> {
  const rawText = typeof raw === "string" ? raw.trim() : raw === null || raw === undefined ? "" : String(raw);
  if (isBlankCell(raw)) return { value: null, invalid: false, raw: rawText };
  if (typeof raw === "number") {
    return Number.isFinite(raw)
      ? { value: raw, invalid: false, raw: rawText }
      : { value: null, invalid: true, raw: rawText };
  }
  const text = rawText
    .replace(/₹|rs\.?|inr/gi, "")
    .replace(/[,\s]/g, "")
    .trim();
  if (text === "") return { value: null, invalid: true, raw: rawText };
  const value = Number(text);
  return Number.isFinite(value)
    ? { value, invalid: false, raw: rawText }
    : { value: null, invalid: true, raw: rawText };
}

export function parsePrice(raw: unknown): number | null {
  return readNumber(raw).value;
}

export function readQuantity(raw: unknown): ParsedValue<number> {
  const parsed = readNumber(raw);
  return { ...parsed, value: parsed.value === null ? null : Math.round(parsed.value) };
}

export function parseQuantity(raw: unknown): number | null {
  return readQuantity(raw).value;
}

/** Spreadsheets say "in stock", "yes", "0 left" — all of it means one of three states. */
export function readAvailability(
  raw: unknown,
  quantity: number | null,
): { value: Availability; invalid: boolean; raw: string } {
  const rawText = isBlankCell(raw) ? "" : String(raw).trim();
  const text = rawText.toLowerCase();
  const fallback: Availability = quantity !== null && quantity <= 0 ? "out_of_stock" : "in_stock";
  if (text === "") return { value: fallback, invalid: false, raw: rawText };
  if (/pre[\s-]?order/.test(text)) return { value: "preorder", invalid: false, raw: rawText };
  if (/out[\s_-]?of[\s_-]?stock|unavailable|sold out|^no$|^false$|^0$/.test(text)) {
    return { value: "out_of_stock", invalid: false, raw: rawText };
  }
  if (/in[\s_-]?stock|available|^yes$|^true$|^1$|ready|stocked/.test(text)) {
    return { value: "in_stock", invalid: false, raw: rawText };
  }
  return { value: fallback, invalid: true, raw: rawText };
}

export function parseAvailability(raw: unknown, quantity: number | null): Availability {
  return readAvailability(raw, quantity).value;
}


export function formatMoney(value: number | null | undefined, currency: string | null): string {
  if (value === null || value === undefined) return "—";
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: currency || "INR",
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency ?? ""} ${value}`.trim();
  }
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "never";
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}

export function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "collection"
  );
}

/** Turns typed words into a prefix tsquery so search feels live. */
export function toTsQuery(input: string): string {
  const terms = input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 6);
  return terms.map((t) => `${t}:*`).join(" & ");
}

// ------------------------------------------------------------------ import

export type ImportField =
  | "title"
  | "description"
  | "sku"
  | "brand"
  | "category"
  | "price"
  | "compare_at_price"
  | "image_url"
  | "product_url"
  | "inventory_quantity"
  | "availability"
  | "ignore";

export const IMPORT_FIELDS: { key: ImportField; label: string }[] = [
  { key: "title", label: "Product name" },
  { key: "price", label: "Price" },
  { key: "compare_at_price", label: "Compare-at price" },
  { key: "sku", label: "SKU" },
  { key: "description", label: "Description" },
  { key: "image_url", label: "Image URL" },
  { key: "product_url", label: "Product link" },
  { key: "inventory_quantity", label: "Stock" },
  { key: "category", label: "Category" },
  { key: "brand", label: "Brand" },
  { key: "availability", label: "Availability" },
  { key: "ignore", label: "Don't import" },
];

const DETECTORS: { field: ImportField; test: RegExp }[] = [
  { field: "compare_at_price", test: /compare|mrp|was.?price|original.?price|list.?price/ },
  { field: "price", test: /^(price|selling.?price|rate|amount|cost)$|price/ },
  { field: "title", test: /^(title|name|product|product.?name|item|item.?name)$/ },
  { field: "sku", test: /sku|code|barcode|item.?id|product.?id/ },
  { field: "description", test: /desc|details|about/ },
  { field: "image_url", test: /image|photo|picture|thumbnail/ },
  { field: "product_url", test: /url|link|page/ },
  { field: "inventory_quantity", test: /stock|qty|quantity|inventory/ },
  { field: "availability", test: /avail|status/ },
  { field: "category", test: /categor|type|collection|department/ },
  { field: "brand", test: /brand|make|manufacturer|vendor/ },
];

export function detectField(header: string): ImportField {
  const text = header.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  for (const d of DETECTORS) if (d.test.test(text)) return d.field;
  if (/^(title|name)$/.test(text)) return "title";
  return "ignore";
}

/** Auto-mapping for a whole header row: each field is claimed only once. */
export function detectMapping(headers: string[]): Record<string, ImportField> {
  const mapping: Record<string, ImportField> = {};
  const claimed = new Set<ImportField>();
  headers.forEach((header, index) => {
    const field = detectField(header);
    if (field !== "ignore" && !claimed.has(field)) {
      claimed.add(field);
      mapping[String(index)] = field;
    } else {
      mapping[String(index)] = "ignore";
    }
  });
  return mapping;
}

export const CATALOG_TEMPLATE_CSV = toCsv([
  [
    "title",
    "sku",
    "price",
    "compare_at_price",
    "description",
    "image_url",
    "product_url",
    "stock",
    "category",
    "brand",
    "availability",
  ],
  [
    "Cotton Kurta - Blue",
    "KUR-BLU-M",
    "1299",
    "1799",
    "Handloom cotton kurta, medium",
    "https://example.com/kurta.jpg",
    "https://example.com/products/kurta",
    "12",
    "Ethnic wear",
    "Meezoy",
    "in_stock",
  ],
  [
    "Silk Scarf",
    "SCF-001",
    "₹ 899",
    "",
    "Pure silk scarf",
    "",
    "",
    "0",
    "Accessories",
    "Meezoy",
    "out_of_stock",
  ],
]);

export type ImportRow = {
  row_number: number;
  title?: string;
  description?: string;
  sku?: string;
  brand?: string;
  category?: string;
  price?: string;
  compare_at_price?: string;
  image_url?: string;
  product_url?: string;
  inventory_quantity?: string;
  availability?: string;
};

export type ImportError = { row: number; product: string; reason: string };
/** A row that imported, but with a value we had to substitute. */
export type ImportWarning = {
  row: number;
  product: string;
  field: string;
  value: string;
  used: string;
  reason: string;
};
export type ImportResults = {
  created: number;
  updated: number;
  warned: number;
  failed: number;
  errors: ImportError[];
  warnings: ImportWarning[];

};
