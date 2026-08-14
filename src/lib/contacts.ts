export type OptInStatus = "opted_in" | "opted_out" | "unknown";

export type TagRow = {
  id: string;
  name: string;
  color: string;
};

export type ContactRow = {
  id: string;
  name: string | null;
  phone: string;
  wa_id: string | null;
  opt_in_status: OptInStatus;
  attributes: Record<string, unknown> | null;
  source: string;
  source_detail: Record<string, unknown> | null;
  created_at: string;
  tags: TagRow[];
};

/** Known lead sources. Organizations can add their own via tracking markers. */
export const SOURCE_LABELS: Record<string, string> = {
  direct: "Direct",
  ctwa_facebook: "Facebook ad",
  ctwa_instagram: "Instagram ad",
  website: "Website",
  instagram_organic: "Instagram",
  import: "Imported",
  manual: "Added by hand",
};

export const SOURCE_CLASSES: Record<string, string> = {
  direct: "border-border bg-muted text-muted-foreground",
  ctwa_facebook: "border-indigo-500/25 bg-indigo-500/10 text-indigo-600",
  ctwa_instagram: "border-pink-500/25 bg-pink-500/10 text-pink-600",
  website: "border-primary/25 bg-primary/10 text-primary",
  instagram_organic: "border-pink-500/25 bg-pink-500/10 text-pink-600",
  import: "border-amber-500/25 bg-amber-500/10 text-amber-600",
  manual: "border-sky-500/25 bg-sky-500/10 text-sky-600",
};

export function sourceLabel(source: string | null | undefined): string {
  if (!source) return SOURCE_LABELS["direct"]!;
  return (
    SOURCE_LABELS[source] ??
    source.replace(/_/g, " ").replace(/^\w/, (ch) => ch.toUpperCase())
  );
}

export function sourceClass(source: string | null | undefined): string {
  return SOURCE_CLASSES[source ?? "direct"] ?? "border-border bg-muted text-muted-foreground";
}


export const OPT_IN_LABELS: Record<OptInStatus, string> = {
  opted_in: "Opted in",
  opted_out: "Opted out",
  unknown: "Unknown",
};

export const OPT_IN_CLASSES: Record<OptInStatus, string> = {
  opted_in: "border-primary/25 bg-primary/10 text-primary",
  opted_out: "border-destructive/25 bg-destructive/10 text-destructive",
  unknown: "border-border bg-muted text-muted-foreground",
};

export const TAG_COLORS = [
  "#10B981",
  "#0EA5A4",
  "#6366F1",
  "#F59E0B",
  "#EF4444",
  "#8B5CF6",
  "#0891B2",
  "#64748B",
];

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function contactInitials(contact: { name: string | null; phone: string }): string {
  const source = contact.name?.trim() || contact.phone.replace(/\D/g, "");
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  return source.slice(-2).toUpperCase();
}
