/**
 * Batch 50: ⌘K entries that open a Settings section directly, so typing
 * "profile", "API" or "team" in the new shell's palette jumps there. Palette
 * entries only: each is a link to /app/settings?tab=…, offered under the same
 * flags and permissions that show the section (settings-sections.ts).
 */
import { JUMP_COPY } from "./copy";

export type SettingsJump = {
  key: string;
  label: string;
  /** cmdk matches against this. */
  value: string;
  tab: string;
};

export function settingsJumps(input: {
  /** /app/settings is among the pages this person may open. */
  settingsVisible: boolean;
  isFeatureEnabled: (key: string) => boolean;
  can: (permission: string) => boolean;
}): SettingsJump[] {
  if (!input.settingsVisible) return [];
  const jumps: SettingsJump[] = [
    {
      key: "profile",
      label: JUMP_COPY.profile,
      value: "whatsapp profile business photo about settings",
      tab: "whatsapp",
    },
    {
      key: "team",
      label: JUMP_COPY.team,
      value: "team members roles invite people settings",
      tab: "team",
    },
  ];
  if (input.isFeatureEnabled("public_api") && input.can("public_api.manage")) {
    jumps.push({
      key: "api",
      label: JUMP_COPY.api,
      value: "api keys webhooks developer console settings",
      tab: "api",
    });
  }
  return jumps;
}
