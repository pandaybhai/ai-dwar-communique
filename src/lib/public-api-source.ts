/**
 * Batch 38: the metadata.source values of a message the Public API sent —
 * "api" (an API key) and "api_console" (Settings → API & webhooks → Try it).
 * Both are API sends: the status endpoint answers for them, the merchant's
 * webhook hears their statuses and the inbox marks them "via API". Pure.
 */
export const API_SOURCES = ["api", "api_console"] as const;

export function isApiSource(source: unknown): boolean {
  return (API_SOURCES as readonly unknown[]).includes(source);
}
