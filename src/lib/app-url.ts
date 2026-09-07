/**
 * The one public address of the app. Payment links, invoice links and every
 * other outbound URL are built from this — never from the request origin,
 * because a link created inside the editor preview must still work a week
 * later on the live site.
 */
export const APP_PUBLIC_URL = "https://aidwar.in";

export function appUrl(path: string): string {
  return `${APP_PUBLIC_URL}${path.startsWith("/") ? path : `/${path}`}`;
}
