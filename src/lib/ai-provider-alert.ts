/**
 * Client-safe reading of the AI provider alerts (activity_log rows with
 * action "ai_provider_alert", written by ai-fallback.server.ts at most once an
 * hour while the trouble lasts). An alert is current for 90 minutes: long
 * enough to bridge to the next hourly one, short enough to clear on its own
 * once the provider recovers.
 */
export type ProviderAlertRow = {
  created_at: string;
  details: {
    headline?: string;
    detail?: string;
    served_by?: string | null;
    kind?: string;
    provider?: string;
  };
};

export const PROVIDER_ALERT_FRESH_MS = 90 * 60_000;

export function activeProviderAlert(
  rows: ProviderAlertRow[],
  now: number,
): ProviderAlertRow | null {
  const latest = rows[0];
  if (!latest) return null;
  const at = Date.parse(latest.created_at);
  if (!Number.isFinite(at) || now - at > PROVIDER_ALERT_FRESH_MS) return null;
  return latest;
}
