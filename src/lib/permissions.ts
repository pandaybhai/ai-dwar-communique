/**
 * Shared permission vocabulary. The database (public.permissions,
 * public.role_permissions, public.has_permission) is the source of truth —
 * these are the client-side mirrors used for typing and presentation only.
 */

export type OrgRole = "owner" | "admin" | "marketer" | "agent";

export const ROLE_RANK: Record<OrgRole, number> = {
  owner: 4,
  admin: 3,
  marketer: 2,
  agent: 1,
};

export const ROLE_LABELS: Record<OrgRole, string> = {
  owner: "Owner",
  admin: "Admin",
  marketer: "Marketer",
  agent: "Agent",
};

export const ROLE_DESCRIPTIONS: Record<OrgRole, string> = {
  owner: "Full access, including billing and the business number.",
  admin: "Everything except billing and the number connection.",
  marketer: "Campaigns, templates, automations, segments and contacts.",
  agent: "Inbox conversations and read-only contacts.",
};

export const PERMISSION_CATEGORIES = [
  "inbox",
  "contacts",
  "marketing",
  "team",
  "settings",
  "billing",
] as const;

export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<PermissionCategory, string> = {
  inbox: "Inbox",
  contacts: "Contacts",
  marketing: "Marketing",
  team: "Team",
  settings: "Settings",
  billing: "Billing",
};

/** Keys seeded in public.permissions. */
export const PERMISSION_KEYS = [
  "inbox.view",
  "inbox.reply",
  "inbox.assign",
  "inbox.close",
  "contacts.view",
  "contacts.edit",
  "contacts.import",
  "contacts.export",
  "contacts.delete",
  "segments.manage",
  "campaigns.view",
  "campaigns.create",
  "campaigns.send",
  "templates.manage",
  "automations.manage",
  "analytics.view",
  "team.manage",
  "settings.manage",
  "settings.whatsapp",
  "billing.manage",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export type PermissionRow = {
  key: string;
  name: string;
  description: string;
  category: PermissionCategory;
  min_role: OrgRole;
};

/** Friendly copy shown in the tooltip of a control the user cannot use. */
export function permissionDeniedReason(name: string): string {
  return `You need the "${name}" permission. Ask an owner or admin of this workspace to grant it.`;
}

/**
 * Turns a PostgREST / Postgres error into the message the database actually
 * raised. Our RLS guards and triggers return meaningful text — showing it
 * beats a generic retry prompt.
 */
export function databaseMessage(
  error: { message?: string | null; details?: string | null; hint?: string | null } | null,
  fallback: string,
): string {
  const raw = (error?.message ?? "").trim();
  if (!raw) return fallback;
  if (/violates row-level security/i.test(raw)) {
    return "The workspace rules blocked this change — you don't have permission to do it.";
  }
  // Postgres RAISE EXCEPTION text arrives verbatim; it is written for users.
  return raw;
}
