/**
 * The tag a campaign send carries in Meta's biz_opaque_callback_data. Meta
 * echoes it on every status webhook for that message, so a status that
 * arrives before the message row is written still finds its campaign
 * recipient: aidwar:c:<campaign id>:r:<recipient id>.
 */
export function campaignCallbackData(campaignId: string, recipientId: string): string {
  return `aidwar:c:${campaignId}:r:${recipientId}`;
}

export function parseCampaignCallbackData(
  value: unknown,
): { campaignId: string; recipientId: string } | null {
  const m = /^aidwar:c:([0-9a-f-]{36}):r:([0-9a-f-]{36})$/i.exec(String(value ?? ""));
  return m ? { campaignId: m[1]!, recipientId: m[2]! } : null;
}
