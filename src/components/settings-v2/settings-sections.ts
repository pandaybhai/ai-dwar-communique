/**
 * Batch 50: the new Settings (docs/design/spec.md, avatar menu → Settings).
 * One page, a left sub-nav, one section at a time picked by `?tab=` so every
 * old link (?tab=team from the avatar menu, ?tab=api from the developer docs,
 * ?tab=integrations from Shop → Shopify, ?google= from Google's return) still
 * lands where it did. Each section is shown by exactly the flags and
 * permissions the classic tab used; nothing new is gated or ungated here.
 */

export type SettingsSectionKey =
  | "general"
  | "team"
  | "whatsapp"
  | "api"
  | "ai_apps"
  | "notifications"
  | "optout"
  | "integrations"
  | "connections"
  | "sending"
  | "sources"
  | "danger";

export type SettingsSection = {
  key: SettingsSectionKey;
  label: string;
  /** One line under the section's heading. */
  blurb: string;
};

const ALL: SettingsSection[] = [
  { key: "general", label: "Workspace", blurb: "How your workspace is named across AiDwar." },
  {
    key: "team",
    label: "Team and roles",
    blurb: "Who works in this workspace and what each person may do.",
  },
  {
    key: "whatsapp",
    label: "WhatsApp",
    blurb: "Your WhatsApp profile, the numbers you send from and their health.",
  },
  {
    key: "api",
    label: "API and webhooks",
    blurb: "Keys for your own systems, the webhook we call, and a console to try requests.",
  },
  {
    key: "ai_apps",
    label: "Connected AI apps",
    blurb: "AI assistants you allowed to use AiDwar as you, and where to remove them.",
  },
  {
    key: "notifications",
    label: "Notifications",
    blurb: "Who on your team is told when a chat needs a person.",
  },
  {
    key: "optout",
    label: "Opt-out keywords",
    blurb: "Words that stop marketing messages to a customer.",
  },
  { key: "integrations", label: "Integrations", blurb: "Your Shopify store." },
  {
    key: "connections",
    label: "Flow connections",
    blurb: "Accounts your flows use: Google Sheets and Razorpay payment links.",
  },
  {
    key: "sending",
    label: "Send settings",
    blurb: "Quiet hours, marketing caps, win-back timing, linking sales to messages and tax.",
  },
  { key: "sources", label: "Lead sources", blurb: "Where new contacts come from." },
  { key: "danger", label: "Danger zone", blurb: "Actions that can't be undone." },
];

export type SettingsAccess = {
  /** shopify flag and integrations.view (the classic Integrations tab's Shopify half). */
  shopify: boolean;
  /** flows_v2 flag and integrations.view (the classic Integrations tab's connections half). */
  connections: boolean;
  /** flows flag and flows.view (the classic Sending tab). */
  sending: boolean;
  /** public_api flag and public_api.manage (the classic API & webhooks tab). */
  api: boolean;
  /** compliance flag (the classic opt-out keywords card under Lead sources). */
  compliance: boolean;
  /** ai_features flag and ai.use (the hand-off alerts card on the Aiden page). */
  notifications: boolean;
  /** The workspace owner (the delete card shows only to them). */
  owner: boolean;
  /** Batch 52: Connected AI apps — the person's own OAuth grants (never a workspace setting). */
  aiApps?: boolean;
};

/** The sections this person sees, in sub-nav order (the danger zone last). */
export function visibleSections(a: SettingsAccess): SettingsSection[] {
  return ALL.filter((s) => {
    switch (s.key) {
      case "integrations":
        return a.shopify;
      case "connections":
        return a.connections;
      case "sending":
        return a.sending;
      case "api":
        return a.api;
      case "ai_apps":
        return a.aiApps === true;
      case "optout":
        return a.compliance;
      case "notifications":
        return a.notifications;
      case "danger":
        return a.owner;
      default:
        return true;
    }
  });
}

/**
 * The section an address asks for. `?tab=` names a section (the classic tab
 * names are kept: general, team, whatsapp, integrations, sending, sources,
 * api); Google's return (`?google=`) opens Flow connections. The classic
 * Integrations tab held Shopify and Flow connections together, so
 * ?tab=integrations without Shopify opens Flow connections. Anything unknown
 * or hidden opens Workspace.
 */
export function sectionFor(
  tab: string | null | undefined,
  hasGoogleReturn: boolean,
  visible: SettingsSection[],
): SettingsSectionKey {
  const shown = new Set(visible.map((s) => s.key));
  const asked = tab === "workspace" ? "general" : tab;
  if (asked && shown.has(asked as SettingsSectionKey)) return asked as SettingsSectionKey;
  if (asked === "integrations" && shown.has("connections")) return "connections";
  if (!asked && hasGoogleReturn && shown.has("connections")) return "connections";
  return "general";
}
