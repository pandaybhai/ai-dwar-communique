/**
 * Shared shape for a connected WhatsApp number. An organization may hold
 * several — separate brands, sales versus support, or a rep who owns their own
 * number — so nothing in the app may assume "the" number of a workspace.
 */
export type WhatsAppNumber = {
  id: string;
  organization_id?: string;
  waba_id: string | null;
  phone_number_id: string;
  display_phone_number: string | null;
  verified_name: string | null;
  quality_rating: string | null;
  status: string;
  is_default: boolean;
  connected_at: string | null;
};

export const NUMBER_COLUMNS =
  "id, organization_id, waba_id, phone_number_id, display_phone_number, verified_name, quality_rating, status, is_default, connected_at";

export function numberLabel(n: Pick<WhatsAppNumber, "display_phone_number" | "verified_name"> | null | undefined): string {
  return n?.display_phone_number?.trim() || n?.verified_name?.trim() || "Unknown number";
}

/** Label used in tight spaces — the number, with the business name as context. */
export function numberSubtitle(n: WhatsAppNumber | null | undefined): string {
  if (!n) return "";
  const parts: string[] = [];
  if (n.verified_name && n.display_phone_number) parts.push(n.verified_name);
  if (n.is_default) parts.push("Default");
  if (n.status !== "active") parts.push(n.status);
  return parts.join(" · ");
}

/** Default first, then active, then most recently connected. */
export function sortNumbers(rows: WhatsAppNumber[]): WhatsAppNumber[] {
  return [...rows].sort((a, b) => {
    if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
    const aActive = a.status === "active";
    const bActive = b.status === "active";
    if (aActive !== bActive) return aActive ? -1 : 1;
    return (b.connected_at ?? "").localeCompare(a.connected_at ?? "");
  });
}

export function defaultNumberId(rows: WhatsAppNumber[]): string | null {
  const sorted = sortNumbers(rows.filter((r) => r.status === "active"));
  return sorted[0]?.id ?? null;
}
