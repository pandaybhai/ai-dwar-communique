/**
 * Ties an OAuth round trip (Shopify install, Google connect) to the browser of
 * the signed-in user who started it. The start API (called with the user's
 * session) sets an HttpOnly cookie holding a random nonce that is also signed
 * into the state; the public callback accepts the state only from the browser
 * holding the same cookie. A link forwarded to — or forced on — someone else
 * carries the state but not the cookie, so it connects nothing.
 * SameSite=Lax: sent on the top-level redirect back from Shopify/Google.
 */
import { secretEquals } from "@/lib/cron-auth.server";

export type OAuthKind = "shopify" | "google";

const cookieName = (kind: OAuthKind) => `aidwar_oauth_${kind}`;

export function newBinding(): string {
  return crypto.randomUUID();
}

export function bindingCookie(kind: OAuthKind, nonce: string): string {
  return `${cookieName(kind)}=${nonce}; Path=/api/public; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`;
}

export function bindingFrom(request: Request, kind: OAuthKind): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === cookieName(kind)) return rest.join("=") || null;
  }
  return null;
}

/** Constant-time: the state's nonce equals this browser's cookie. */
export function sameBinding(expected: string | null | undefined, provided: string | null | undefined): boolean {
  return secretEquals(provided, expected);
}
