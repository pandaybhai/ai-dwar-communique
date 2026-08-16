/**
 * Feature registry — the single place a feature declares itself.
 *
 * Every cross-cutting system (feature flags, permissions, navigation,
 * analytics, activity log, super admin) reads this manifest instead of a
 * hand-written list. Adding a feature means adding one entry here and running
 * the registry sync; nothing else needs to be remembered.
 *
 * This module is pure data — no React, no lucide, no database client — so it
 * can be imported by the client, by server code and by the build-time check.
 */

export type OrgRole = "owner" | "admin" | "marketer" | "agent";

/** Icon names resolved to components in src/lib/feature-icons.ts. */
export type FeatureIcon =
  | "inbox"
  | "contact"
  | "megaphone"
  | "message-square-text"
  | "workflow"
  | "bar-chart"
  | "shield-check"
  | "settings"
  | "users"
  | "credit-card";

export type PermissionManifest = {
  key: string;
  name: string;
  description: string;
  /** Lowest role that holds this permission by default. */
  min_role: OrgRole;
};

export type AnalyticsManifest = {
  /** Event types this feature emits into the analytics data plane. */
  event_types: string[];
  /** Metrics this feature exposes through the analytics RPCs. */
  metrics: string[];
  /** Whether the analytics page renders a section for this feature. */
  dashboard_section: boolean;
  /** Tab id + label used when dashboard_section is true. */
  section_id?: string;
  section_label?: string;
  section_order?: number;
};

export type UsageMeter = {
  key: string;
  name: string;
  unit: string;
};

export type FeatureManifest = {
  key: string;
  name: string;
  description: string;
  icon: FeatureIcon;
  /** Sidebar destination. Omit for features with no page of their own. */
  nav_path?: string;
  nav_order?: number;
  /** Permission required to see the nav entry. Required when nav_path is set. */
  nav_permission?: string;
  /** Feature flag key. Every feature must have one. */
  flag_key: string;
  flag_default_enabled: boolean;
  permissions: PermissionManifest[];
  analytics: AnalyticsManifest;
  activity_actions: string[];
  settings_path?: string;
  usage_meters?: UsageMeter[];
  /** Tables holding this feature's data — used for offboarding and deletion. */
  data_tables: string[];
};

const none: AnalyticsManifest = { event_types: [], metrics: [], dashboard_section: false };

export const FEATURES: readonly FeatureManifest[] = [
  {
    key: "inbox",
    name: "Shared Inbox",
    description: "One shared place for the team to reply, assign and close conversations.",
    icon: "inbox",
    nav_path: "/app/inbox",
    nav_order: 10,
    nav_permission: "inbox.view",
    flag_key: "inbox",
    flag_default_enabled: true,
    permissions: [
      {
        key: "inbox.view",
        name: "View inbox",
        description: "Open the shared inbox and read conversations.",
        min_role: "agent",
      },
      {
        key: "inbox.reply",
        name: "Reply in inbox",
        description: "Send replies to customers from the shared inbox.",
        min_role: "agent",
      },
      {
        key: "inbox.assign",
        name: "Assign conversations",
        description: "Assign a conversation to a teammate.",
        min_role: "agent",
      },
      {
        key: "inbox.close",
        name: "Close conversations",
        description: "Mark conversations as closed.",
        min_role: "admin",
      },
    ],
    analytics: {
      event_types: ["message.inbound", "message.outbound", "conversation.closed"],
      metrics: ["first_response_median", "first_response_p90", "conversations_handled"],
      dashboard_section: true,
      section_id: "inbox",
      section_label: "Inbox & team",
      section_order: 40,
    },
    activity_actions: ["conversation_assigned", "conversation_closed"],
    data_tables: ["conversations", "messages"],
  },
  {
    key: "contacts",
    name: "Contacts",
    description: "Your audience — contacts, tags, imports and saved segments.",
    icon: "contact",
    nav_path: "/app/contacts",
    nav_order: 20,
    nav_permission: "contacts.view",
    flag_key: "contacts",
    flag_default_enabled: true,
    permissions: [
      {
        key: "contacts.view",
        name: "View contacts",
        description: "Browse contacts and their details.",
        min_role: "agent",
      },
      {
        key: "contacts.edit",
        name: "Edit contacts",
        description: "Create and edit contacts, tags and attributes.",
        min_role: "marketer",
      },
      {
        key: "contacts.import",
        name: "Import contacts",
        description: "Bring contacts in from a CSV file.",
        min_role: "marketer",
      },
      {
        key: "contacts.export",
        name: "Export contacts",
        description: "Download contact data.",
        min_role: "admin",
      },
      {
        key: "contacts.delete",
        name: "Delete contacts",
        description: "Permanently remove contacts.",
        min_role: "admin",
      },
      {
        key: "segments.manage",
        name: "Manage segments",
        description: "Create and edit saved audience segments.",
        min_role: "marketer",
      },
    ],
    analytics: {
      event_types: ["contact.created", "contact.imported", "contact.opt_changed"],
      metrics: ["new_contacts", "contacts_by_source", "opt_in_split", "opt_outs_over_time"],
      dashboard_section: true,
      section_id: "contacts",
      section_label: "Contacts",
      section_order: 30,
    },
    activity_actions: [
      "contact_created",
      "contacts_imported",
      "tag_created",
      "optin_changed",
      "segment_created",
      "segment_deleted",
      "lead_source_marker_created",
      "lead_source_marker_deleted",
    ],
    settings_path: "/app/settings",
    usage_meters: [{ key: "contacts_stored", name: "Contacts stored", unit: "contacts" }],
    data_tables: [
      "contacts",
      "tags",
      "contact_tags",
      "contact_imports",
      "segments",
      "lead_source_markers",
    ],
  },
  {
    key: "campaigns",
    name: "Campaigns",
    description: "Broadcast an approved template to a segment of opted-in contacts.",
    icon: "megaphone",
    nav_path: "/app/campaigns",
    nav_order: 30,
    nav_permission: "campaigns.view",
    flag_key: "campaigns",
    flag_default_enabled: true,
    permissions: [
      {
        key: "campaigns.view",
        name: "View campaigns",
        description: "See campaigns and their results.",
        min_role: "marketer",
      },
      {
        key: "campaigns.create",
        name: "Create campaigns",
        description: "Build and schedule a campaign.",
        min_role: "marketer",
      },
      {
        key: "campaigns.send",
        name: "Send campaigns",
        description: "Launch, pause and resume a campaign.",
        min_role: "marketer",
      },
    ],
    analytics: {
      event_types: ["campaign.launched", "campaign.recipient_status"],
      metrics: ["recipients", "delivered_rate", "read_rate", "replied_rate", "failure_reasons"],
      dashboard_section: true,
      section_id: "campaigns",
      section_label: "Campaigns",
      section_order: 20,
    },
    activity_actions: ["campaign_created", "campaign_launched", "campaign_controlled"],
    usage_meters: [{ key: "campaign_messages", name: "Campaign messages sent", unit: "messages" }],
    data_tables: ["campaigns", "campaign_recipients"],
  },
  {
    key: "templates",
    name: "Message Templates",
    description: "Pre-approved messages you can send at any time.",
    icon: "message-square-text",
    nav_path: "/app/templates",
    nav_order: 40,
    nav_permission: "templates.manage",
    flag_key: "templates",
    flag_default_enabled: true,
    permissions: [
      {
        key: "templates.manage",
        name: "Manage templates",
        description: "Create, sync and submit message templates.",
        min_role: "marketer",
      },
    ],
    analytics: none,
    activity_actions: ["template_created", "template_synced"],
    data_tables: ["message_templates"],
  },
  {
    key: "automations",
    name: "Automations",
    description: "Welcome messages, keyword replies and off-hours cover.",
    icon: "workflow",
    nav_path: "/app/automations",
    nav_order: 50,
    nav_permission: "automations.manage",
    flag_key: "automations",
    flag_default_enabled: true,
    permissions: [
      {
        key: "automations.manage",
        name: "Manage automations",
        description: "Create, edit and switch automations on or off.",
        min_role: "marketer",
      },
    ],
    analytics: {
      event_types: ["automation.run", "automation.skipped"],
      metrics: ["runs_sent", "runs_skipped", "skip_reasons"],
      dashboard_section: true,
      section_id: "automations",
      section_label: "Automations",
      section_order: 50,
    },
    activity_actions: [
      "automation_created",
      "automation_updated",
      "automation_toggled",
      "automation_deleted",
    ],
    data_tables: ["automations", "automation_runs"],
  },
  {
    key: "analytics",
    name: "Analytics",
    description: "Delivery, audience, response time and automation performance.",
    icon: "bar-chart",
    nav_path: "/app/analytics",
    nav_order: 60,
    nav_permission: "analytics.view",
    flag_key: "analytics",
    flag_default_enabled: true,
    permissions: [
      {
        key: "analytics.view",
        name: "View analytics",
        description: "Open the analytics dashboard for this workspace.",
        min_role: "marketer",
      },
    ],
    analytics: {
      event_types: [],
      metrics: ["messages_sent", "delivered", "read", "failed", "replies"],
      dashboard_section: true,
      section_id: "overview",
      section_label: "Overview",
      section_order: 10,
    },
    activity_actions: [],
    data_tables: [],
  },
  {
    key: "compliance",
    name: "Opt-out & compliance",
    description: "Opt-out keywords, consent state and number quality monitoring.",
    icon: "shield-check",
    flag_key: "compliance",
    flag_default_enabled: true,
    permissions: [
      {
        key: "compliance.manage",
        name: "Manage opt-out rules",
        description: "Edit unsubscribe and resubscribe keywords for this workspace.",
        min_role: "admin",
      },
    ],
    analytics: {
      event_types: ["quality.updated", "contact.opted_out", "contact.opted_in"],
      metrics: ["quality_history", "opt_outs"],
      dashboard_section: true,
      section_id: "quality",
      section_label: "Number quality",
      section_order: 60,
    },
    activity_actions: [
      "contact_opted_out",
      "contact_opted_in",
      "quality_changed",
      "opt_out_keyword_created",
      "opt_out_keyword_deleted",
    ],
    settings_path: "/app/settings",
    data_tables: ["opt_out_keywords", "whatsapp_quality_history"],
  },
  {
    key: "settings",
    name: "Settings",
    description: "Workspace details and the connection that powers your messaging.",
    icon: "settings",
    nav_path: "/app/settings",
    nav_order: 70,
    nav_permission: "settings.view",
    flag_key: "settings",
    flag_default_enabled: true,
    permissions: [
      {
        key: "settings.view",
        name: "Open settings",
        description: "See the workspace settings pages.",
        min_role: "agent",
      },
      {
        key: "settings.manage",
        name: "Manage settings",
        description: "Change workspace details and preferences.",
        min_role: "admin",
      },
      {
        key: "settings.whatsapp",
        name: "Manage connection",
        description: "Connect, disconnect or reconnect the business number.",
        min_role: "owner",
      },
    ],
    analytics: none,
    activity_actions: ["organization.created", "organization.updated", "user.logged_in"],
    settings_path: "/app/settings",
    data_tables: ["organizations", "whatsapp_accounts"],
  },
  {
    key: "team",
    name: "Team",
    description: "Teammates, roles, invitations and permission overrides.",
    icon: "users",
    flag_key: "team",
    flag_default_enabled: true,
    permissions: [
      {
        key: "team.manage",
        name: "Manage team",
        description: "Invite teammates, change roles and adjust permissions.",
        min_role: "admin",
      },
    ],
    analytics: none,
    activity_actions: [
      "member.invited",
      "invitation.accepted",
      "member.role_changed",
      "member.removed",
      "member.permission_overridden",
      "member.permission_reset",
    ],
    settings_path: "/app/settings",
    usage_meters: [{ key: "seats", name: "Team seats", unit: "seats" }],
    data_tables: ["organization_members", "invitations", "member_permissions"],
  },
  {
    key: "billing",
    name: "Billing",
    description: "Plan, usage and invoices for this workspace.",
    icon: "credit-card",
    flag_key: "billing",
    flag_default_enabled: false,
    permissions: [
      {
        key: "billing.manage",
        name: "Manage billing",
        description: "See and change the plan and payment details.",
        min_role: "owner",
      },
    ],
    analytics: none,
    activity_actions: [],
    settings_path: "/app/settings",
    data_tables: [],
  },
] as const;

export const ROLE_RANK: Record<OrgRole, number> = { owner: 4, admin: 3, marketer: 2, agent: 1 };

export function featureByKey(key: string): FeatureManifest | undefined {
  return FEATURES.find((f) => f.key === key);
}

export function featureForPermission(permissionKey: string): FeatureManifest | undefined {
  return FEATURES.find((f) => f.permissions.some((p) => p.key === permissionKey));
}

export function allPermissions(): (PermissionManifest & { feature: string })[] {
  return FEATURES.flatMap((f) => f.permissions.map((p) => ({ ...p, feature: f.key })));
}

export function allPermissionKeys(): string[] {
  return allPermissions().map((p) => p.key);
}

export function allActivityActions(): string[] {
  return Array.from(new Set(FEATURES.flatMap((f) => f.activity_actions)));
}

/** Role defaults derived from min_role: a role holds every permission at or below its rank. */
export function roleDefaults(role: OrgRole): string[] {
  return allPermissions()
    .filter((p) => ROLE_RANK[role] >= ROLE_RANK[p.min_role])
    .map((p) => p.key);
}

export function navFeatures(): FeatureManifest[] {
  return FEATURES.filter((f) => Boolean(f.nav_path)).sort(
    (a, b) => (a.nav_order ?? 999) - (b.nav_order ?? 999),
  );
}

export function analyticsSections(): FeatureManifest[] {
  return FEATURES.filter((f) => f.analytics.dashboard_section).sort(
    (a, b) => (a.analytics.section_order ?? 999) - (b.analytics.section_order ?? 999),
  );
}
