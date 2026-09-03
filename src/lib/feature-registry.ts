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
  | "receipt"
  | "workflow"
  | "bar-chart"
  | "shield-check"
  | "settings"
  | "users"
  | "credit-card"
  | "shopping-bag"
  | "sparkles"
  | "package";

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

/**
 * A capability exposed to an AI model. The description is written for a model
 * to read, not for a person. The broker (src/lib/ai-tools.server.ts) binds the
 * organization itself — organization_id is never a model-supplied parameter.
 */
export type AiTool = {
  name: string;
  description: string;
  /** JSON Schema for the arguments the model may supply. */
  parameters: {
    type: "object";
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
    additionalProperties?: false;
  };
  required_permission: string;
  access: "read" | "write";
  requires_confirmation: boolean;
  /** Key in AI_TOOL_HANDLERS. */
  handler: string;
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
  /** Capabilities this feature offers to the AI layer. */
  ai_tools?: AiTool[];
  /** Tables holding this feature's data — used for offboarding and deletion. */
  data_tables: string[];
  /**
   * Feature keys this feature needs in order to work. Turning off a
   * dependency must warn about everything downstream before it happens.
   */
  depends_on: string[];
};

const none: AnalyticsManifest = { event_types: [], metrics: [], dashboard_section: false };

export const FEATURES: readonly FeatureManifest[] = [
  {
    key: "inbox",
    depends_on: [],
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
      event_types: [
        "message.sent",
        "message.delivered",
        "message.read",
        "message.failed",
        "message.received",
        "conversation.opened",
        "conversation.assigned",
        "conversation.closed",
      ],
      metrics: ["first_response_median", "first_response_p90", "conversations_handled"],
      dashboard_section: true,
      section_id: "inbox",
      section_label: "Inbox & team",
      section_order: 40,
    },
    activity_actions: ["conversation_assigned", "conversation_closed"],
    ai_tools: [
      {
        name: "search_conversation_history",
        description:
          "Search the recent message history of one contact's conversations in this workspace. Returns messages newest first with direction, text and time. Use it to recall what was already discussed before answering.",
        parameters: {
          type: "object",
          properties: {
            phone: { type: "string", description: "Contact phone number in any format." },
            query: { type: "string", description: "Optional text to search for within messages." },
            limit: { type: "integer", description: "Maximum messages to return (1-50).", default: 20 },
          },
          required: ["phone"],
          additionalProperties: false,
        },
        required_permission: "inbox.view",
        access: "read",
        requires_confirmation: false,
        handler: "searchConversationHistory",
      },
    ],
    data_tables: ["conversations", "messages"],
  },
  {
    key: "contacts",
    depends_on: [],
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
      event_types: [
        "contact.created",
        "contact.imported",
        "contact.opted_out",
        "contact.opted_in",
      ],
      metrics: ["new_contacts", "contacts_by_source", "opt_in_split", "opt_outs_over_time"],
      dashboard_section: true,
      section_id: "contacts",
      section_label: "Contacts",
      section_order: 30,
    },
    activity_actions: [
      "contact_created",
      "contacts_imported",
      "contacts_exported",
      "tag_created",
      "optin_changed",
      "segment_created",
      "segment_deleted",
      "lead_source_marker_created",
      "lead_source_marker_deleted",
    ],
    settings_path: "/app/settings",
    usage_meters: [{ key: "contacts_stored", name: "Contacts stored", unit: "contacts" }],
    ai_tools: [
      {
        name: "lookup_contact",
        description:
          "Look up one contact in this workspace by phone number. Returns their name, tags, lead source, opt-in status and custom attributes.",
        parameters: {
          type: "object",
          properties: {
            phone: { type: "string", description: "Phone number in any format; it is normalised." },
          },
          required: ["phone"],
          additionalProperties: false,
        },
        required_permission: "contacts.view",
        access: "read",
        requires_confirmation: false,
        handler: "lookupContact",
      },
      {
        name: "check_opt_out_status",
        description:
          "Check whether a contact may be messaged. Opt-out applies to the whole workspace, not to a single number.",
        parameters: {
          type: "object",
          properties: { phone: { type: "string", description: "Phone number in any format." } },
          required: ["phone"],
          additionalProperties: false,
        },
        required_permission: "contacts.view",
        access: "read",
        requires_confirmation: false,
        handler: "checkOptOutStatus",
      },
      {
        name: "list_segments",
        description:
          "List saved audience segments in this workspace together with how many contacts currently match each one.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        required_permission: "contacts.view",
        access: "read",
        requires_confirmation: false,
        handler: "listSegments",
      },
    ],
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
    depends_on: ["templates", "contacts"],
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
      event_types: ["campaign.launched", "campaign.completed"],
      metrics: ["recipients", "delivered_rate", "read_rate", "replied_rate", "failure_reasons"],
      dashboard_section: true,
      section_id: "campaigns",
      section_label: "Campaigns",
      section_order: 20,
    },
    activity_actions: ["campaign_created", "campaign_launched", "campaign_controlled"],
    usage_meters: [{ key: "campaign_messages", name: "Campaign messages sent", unit: "messages" }],
    ai_tools: [
      {
        name: "get_campaign_status",
        description:
          "Get one campaign's current status and delivery statistics: recipients, sent, delivered, read, replied and failed counts.",
        parameters: {
          type: "object",
          properties: {
            campaign_id: { type: "string", description: "The campaign's id." },
            name: { type: "string", description: "Campaign name, used when no id is given." },
          },
          additionalProperties: false,
        },
        required_permission: "campaigns.view",
        access: "read",
        requires_confirmation: false,
        handler: "getCampaignStatus",
      },
    ],
    data_tables: ["campaigns", "campaign_recipients"],
  },
  {
    key: "templates",
    depends_on: [],
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
    analytics: {
      event_types: ["template.created", "template.approved", "template.rejected"],
      metrics: [],
      dashboard_section: false,
    },
    activity_actions: ["template_created", "template_synced"],
    ai_tools: [
      {
        name: "list_approved_templates",
        description:
          "List the approved message templates available on one specific connected number. Templates belong to a number's business account, so the number must be named explicitly.",
        parameters: {
          type: "object",
          properties: {
            whatsapp_account_id: {
              type: "string",
              description:
                "Id of the connected number whose template library to read. Ask the user which number if the workspace has more than one.",
            },
          },
          required: ["whatsapp_account_id"],
          additionalProperties: false,
        },
        required_permission: "templates.manage",
        access: "read",
        requires_confirmation: false,
        handler: "listApprovedTemplates",
      },
    ],
    data_tables: ["message_templates"],
  },
  {
    key: "automations",
    depends_on: ["inbox"],
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
      event_types: ["automation.fired", "automation.skipped"],
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
    ai_tools: [
      {
        name: "list_active_automations",
        description:
          "List the automations currently switched on in this workspace, with their trigger type and priority.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        required_permission: "automations.manage",
        access: "read",
        requires_confirmation: false,
        handler: "listActiveAutomations",
      },
    ],
    data_tables: ["automations", "automation_runs"],
  },
  {
    key: "analytics",
    depends_on: ["campaigns"],
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
    depends_on: ["contacts"],
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
      event_types: ["whatsapp.quality_changed", "contact.opted_out", "contact.opted_in"],
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
    ai_tools: [
      {
        name: "check_number_quality",
        description:
          "Check the current Meta quality rating and messaging status of one specific connected number. A workspace can hold several numbers, so the number must be named explicitly.",
        parameters: {
          type: "object",
          properties: {
            whatsapp_account_id: {
              type: "string",
              description: "Id of the connected number to check. Never assume the default number.",
            },
          },
          required: ["whatsapp_account_id"],
          additionalProperties: false,
        },
        required_permission: "settings.view",
        access: "read",
        requires_confirmation: false,
        handler: "checkNumberQuality",
      },
    ],
    data_tables: ["opt_out_keywords", "whatsapp_quality_history"],
  },
  {
    key: "settings",
    depends_on: [],
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
        name: "Manage connections",
        description: "Add, disconnect or reconnect the business numbers this workspace sends from.",
        min_role: "owner",
      },
    ],
    analytics: {
      event_types: [
        "whatsapp.connected",
        "whatsapp.disconnected",
        "whatsapp.quality_changed",
      ],
      metrics: [],
      dashboard_section: false,
    },
    activity_actions: [
      "organization.created",
      "organization.updated",
      "user.logged_in",
      "whatsapp_connected",
      "whatsapp_disconnected",
      "whatsapp_default_changed",
    ],
    settings_path: "/app/settings",
    usage_meters: [
      { key: "messages_marketing", name: "Marketing messages sent", unit: "messages" },
      { key: "messages_utility", name: "Utility messages sent", unit: "messages" },
      { key: "messages_authentication", name: "Authentication messages sent", unit: "messages" },
      { key: "messages_service", name: "Service messages sent", unit: "messages" },
    ],
    ai_tools: [
      {
        name: "list_connected_numbers",
        description:
          "List the business numbers connected to this workspace, with their id, display number, label, status and whether each is the default. Call this first whenever another tool needs a whatsapp_account_id.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        required_permission: "settings.view",
        access: "read",
        requires_confirmation: false,
        handler: "listConnectedNumbers",
      },
    ],
    data_tables: ["organizations", "whatsapp_accounts"],

  },
  {
    key: "team",
    depends_on: [],
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
    key: "ai",
    depends_on: ["inbox"],
    name: "AI employee",
    description:
      "The AI employee: what it knows, how it behaves, the tools it may use on this workspace's data, and every answer it has given.",
    icon: "sparkles",
    nav_path: "/app/employee",
    nav_order: 55,
    nav_permission: "ai.use",
    flag_key: "ai_features",
    flag_default_enabled: true,

    permissions: [
      {
        key: "ai.use",
        name: "Use AI",
        description: "Ask the assistant questions and let it read this workspace's data.",
        min_role: "agent",
      },
      {
        key: "ai.configure",
        name: "Configure AI",
        description: "Change how the assistant behaves and which capabilities it may use.",
        min_role: "admin",
      },
    ],
    analytics: none,
    activity_actions: [
      "ai_tool_invoked",
      "ai_mode_changed",
      "ai_settings_updated",
      "ai_brain_changed",
      "ai_instructions_updated",
      "ai_knowledge_added",
      "ai_knowledge_removed",
      "ai_answer_corrected",
    ],
    settings_path: "/app/employee",
    usage_meters: [
      { key: "ai_answers", name: "AI answers", unit: "answers" },
      { key: "ai_spend", name: "AI spend", unit: "currency" },
    ],
    data_tables: [
      "ai_agents",
      "organization_ai_settings",
      "ai_task_models",
      "ai_runs",
      "ai_tool_calls",
      "ai_usage",
      "ai_instructions",
      "ai_comparisons",
      "knowledge_sources",
      "knowledge_documents",
      "knowledge_chunks",
    ],

  },
  {
    key: "shopify",
    depends_on: [],
    name: "Shopify",
    description:
      "Connect Shopify stores and keep orders, products, checkouts and customers in sync.",
    icon: "shopping-bag",
    flag_key: "shopify",
    flag_default_enabled: false,
    permissions: [
      {
        key: "integrations.view",
        name: "View integrations",
        description: "See connected stores and their sync state.",
        min_role: "marketer",
      },
      {
        key: "integrations.manage",
        name: "Manage integrations",
        description: "Connect, resync and disconnect stores for this workspace.",
        min_role: "owner",
      },
    ],
    analytics: {
      event_types: [
        "shopify.connected",
        "shopify.disconnected",
        "order.created",
        "order.fulfilled",
        "order.cancelled",
        "checkout.abandoned",
        "product.synced",
      ],
      metrics: ["orders_synced", "abandoned_checkouts"],
      dashboard_section: false,
    },
    activity_actions: [
      "integration_connected",
      "integration_disconnected",
      "integration_resynced",
      "integration_data_request",
      "integration_customer_redacted",
      "integration_shop_redacted",
      "shopify_data_request",
      "shopify_customer_redacted",
      "shopify_shop_redacted",
      "shopify_token_refreshed",
    ],
    settings_path: "/app/settings",
    usage_meters: [
      { key: "shopify_orders_synced", name: "Shopify orders synced", unit: "orders" },
    ],
    ai_tools: [
      {
        name: "lookup_order",
        description:
          "Look up a single order by its order number, or the most recent order for a phone number. Returns status, totals and line items.",
        parameters: {
          type: "object",
          properties: {
            order_number: { type: "string", description: "Order number as shown in Shopify, e.g. #1042." },
            phone: { type: "string", description: "Customer phone in any format; used when no order number is known." },
          },
          additionalProperties: false,
        },
        required_permission: "integrations.view",
        access: "read",
        requires_confirmation: false,
        handler: "lookupOrder",
      },
      {
        name: "get_customer_orders",
        description: "List recent orders for a customer, found by phone number.",
        parameters: {
          type: "object",
          properties: {
            phone: { type: "string", description: "Customer phone in any format." },
            limit: { type: "number", description: "How many orders to return, default 5, max 20." },
          },
          required: ["phone"],
          additionalProperties: false,
        },
        required_permission: "integrations.view",
        access: "read",
        requires_confirmation: false,
        handler: "getCustomerOrders",
      },
      {
        name: "get_abandoned_checkout",
        description:
          "Get the most recent abandoned checkout for a phone number, including its recovery URL and total.",
        parameters: {
          type: "object",
          properties: { phone: { type: "string", description: "Customer phone in any format." } },
          required: ["phone"],
          additionalProperties: false,
        },
        required_permission: "integrations.view",
        access: "read",
        requires_confirmation: false,
        handler: "getAbandonedCheckout",
      },
      {
        name: "search_products",
        description: "Search synced store products by title, returning price, status and product URL.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Words to match against the product title." },
            limit: { type: "number", description: "How many products to return, default 5, max 20." },
          },
          required: ["query"],
          additionalProperties: false,
        },
        required_permission: "integrations.view",
        access: "read",
        requires_confirmation: false,
        handler: "searchProducts",
      },
    ],
    data_tables: [
      "integrations",
      "integration_credentials",
      "integration_sync_jobs",
      "products",
      "orders",
      "order_items",
      "abandoned_checkouts",
    ],
  },

  {
    key: "flows",
    depends_on: ["templates", "contacts"],
    name: "Flows",
    description:
      "Scheduled messaging: turn store events into WhatsApp messages with delays, quiet hours and frequency caps.",
    icon: "workflow",
    nav_path: "/app/flows",
    nav_order: 55,
    nav_permission: "flows.view",
    flag_key: "flows",
    flag_default_enabled: false,
    permissions: [
      {
        key: "flows.view",
        name: "View flows",
        description: "See flows, their steps and what has been scheduled or sent.",
        min_role: "marketer",
      },
      {
        key: "flows.manage",
        name: "Manage flows",
        description:
          "Turn flows on or off, edit steps and templates, and change quiet hours and frequency caps.",
        min_role: "admin",
      },
    ],
    analytics: {
      event_types: [
        "flow.scheduled",
        "flow.sent",
        "flow.cancelled",
        "flow.skipped",
        "flow.failed",
        "flow.clicked",
        "cod.confirmed",
        "cod.cancelled",
        "cod.no_response",
      ],

      metrics: ["flow_sends", "flow_skips"],
      dashboard_section: false,
    },
    activity_actions: [
      "flow_toggled",
      "flow_step_updated",
      "send_settings_updated",
      "reconciliation_mismatch",
    ],
    settings_path: "/app/settings",
    data_tables: [
      "flows",
      "flow_steps",
      "scheduled_sends",
      "organization_send_settings",
      "short_links",
    ],
  },

  {
    key: "revenue_attribution",
    depends_on: ["shopify", "campaigns"],
    name: "Sales from messages",
    description:
      "Links orders back to the last promotional message the customer received, and shows honestly which sales could not be linked.",
    icon: "receipt",
    flag_key: "revenue_attribution",
    flag_default_enabled: true,
    nav_path: "/app/receipts",
    nav_order: 65,
    nav_permission: "revenue.view",

    permissions: [
      {
        key: "revenue.view",
        name: "View sales from messages",
        description: "See which campaigns and flows produced sales, and how much.",
        min_role: "marketer",
      },
    ],
    analytics: {
      event_types: [],
      metrics: [
        "revenue_attributed",
        "revenue_unattributed",
        "orders_attributed",
        "revenue_per_message",
        "cost_spent",
        "revenue_per_rupee_spent",
      ],

      dashboard_section: true,
      section_id: "revenue",
      section_label: "Sales from messages",
      section_order: 25,
    },
    activity_actions: [],
    settings_path: "/app/settings",
    data_tables: ["revenue_attributions", "message_rates"],
  },

  {
    key: "billing",
    name: "Billing",
    description: "Plan, usage and invoices for this workspace.",
    icon: "credit-card",
    nav_path: "/app/billing",
    nav_order: 95,
    nav_permission: "billing.view",
    flag_key: "billing",
    flag_default_enabled: false,
    depends_on: [],
    permissions: [
      {
        key: "billing.view",
        name: "View billing",
        description: "See plan, credit balance, usage and invoices.",
        min_role: "admin",
      },
      {
        key: "billing.pay",
        name: "Buy credits and pay",
        description: "Buy credit packs, set up payment mandates, download invoices.",
        min_role: "owner",
      },
      {
        key: "billing.request",
        name: "Request top-up",
        description: "Ask the workspace owner to add credits.",
        min_role: "marketer",
      },
      {
        key: "billing.manage",
        name: "Manage billing",
        description: "Change plan, billing details and spend controls.",
        min_role: "owner",
      },
    ],
    analytics: none,
    activity_actions: [],
    settings_path: "/app/settings",
    usage_meters: [
      { key: "credits_consumed", name: "Credits used", unit: "currency" },
      { key: "credits_purchased", name: "Credits bought", unit: "currency" },
    ],
    data_tables: [
      "billing_accounts",
      "plans",
      "plan_versions",
      "organization_billing_settings",
      "rate_cards",
      "credit_packs",
      "coupons",
      "wallet_ledger",
      "wallet_balances",
      "payments",
      "subscriptions",
      "invoices",
      "invoice_lines",
      "invoice_sequences",
      "topup_tasks",
      "meta_prepaid_ledger",
      "bsp_accounts",
      "billing_notifications",
    ],
  },
  {
    key: "catalog",
    depends_on: ["templates"],
    name: "Catalogue",
    description:
      "One product list the business can actually use: synced from the store, uploaded from a file, or added by hand.",
    icon: "package",
    nav_path: "/app/catalog",
    nav_order: 45,
    nav_permission: "catalog.view",
    flag_key: "catalogs",
    flag_default_enabled: false,
    permissions: [
      {
        key: "catalog.view",
        name: "View catalogue",
        description: "Browse products and collections in this workspace.",
        min_role: "agent",
      },
      {
        key: "catalog.manage",
        name: "Manage catalogue",
        description: "Add, edit, hide and delete products, and organise collections.",
        min_role: "marketer",
      },
      {
        key: "catalog.import",
        name: "Import products",
        description: "Upload a spreadsheet of products into the catalogue.",
        min_role: "marketer",
      },
    ],
    analytics: none,
    activity_actions: [
      "catalog_product_created",
      "catalog_product_updated",
      "catalog_product_deleted",
      "catalog_product_unlinked",
      "catalog_products_hidden",
      "catalog_imported",
      "catalog_collection_created",
      "catalog_collection_updated",
      "catalog_collection_deleted",
    ],
    usage_meters: [
      { key: "catalog_imports", name: "Products imported", unit: "products" },
    ],
    ai_tools: [
      {
        name: "catalog_search",
        description:
          "Search this workspace's product catalogue by words in the title, description, SKU, brand or category. Optionally narrow by maximum price, availability or category. Omit query to list what's currently available. Returns title, price, availability and product URL.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Words to search for across the catalogue. Leave this out to browse what is available.",
            },
            max_price: { type: "number", description: "Only return products at or below this price." },
            availability: {
              type: "string",
              description: "Filter by availability: in_stock, out_of_stock or preorder.",
            },
            category: { type: "string", description: "Only return products in this category." },
            limit: { type: "number", description: "How many products to return, default 10, max 25." },
          },
          required: [],

          additionalProperties: false,
        },
        required_permission: "catalog.view",
        access: "read",
        requires_confirmation: false,
        handler: "catalogSearch",
      },
    ],
    data_tables: ["products", "product_collections", "product_collection_items", "catalog_imports"],
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

/** Every AI tool any feature declares, with its owning feature. */
export function allAiTools(): (AiTool & { feature: string; flag_key: string })[] {
  return FEATURES.flatMap((f) =>
    (f.ai_tools ?? []).map((t) => ({ ...t, feature: f.key, flag_key: f.flag_key })),
  );
}

export function analyticsSections(): FeatureManifest[] {
  return FEATURES.filter((f) => f.analytics.dashboard_section).sort(
    (a, b) => (a.analytics.section_order ?? 999) - (b.analytics.section_order ?? 999),
  );
}
