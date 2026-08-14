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
  created_at: string;
  tags: TagRow[];
};

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
