/**
 * Batch 52: the OAuth consent step (Supabase OAuth 2.1 server, Authorization
 * Path /oauth/consent). An AI app (Claude, ChatGPT, Codex, Cursor) sends the
 * merchant here with ?authorization_id=…; the merchant signs in if needed
 * (and comes straight back), sees who is asking and what it may do, and
 * allows or denies. Supabase then sends the browser back to the app.
 *
 * Plain functions over the browser's Supabase client, so the steps are
 * tested without a browser (batch52-consent.test.tsx).
 */

export type ConsentDetails = {
  authorizationId: string;
  clientName: string;
  clientUri: string | null;
  redirectUri: string;
  redirectDomain: string;
  scopes: string[];
  userEmail: string | null;
};

export type ConsentStep =
  | { kind: "login"; to: string }
  | { kind: "redirect"; url: string }
  | { kind: "details"; details: ConsentDetails }
  | { kind: "error"; message: string };

/** The parts of supabase-js's auth client this uses (auth.oauth.* since 2.78). */
export type ConsentAuth = {
  getSession: () => Promise<{ data: { session: unknown | null } }>;
  oauth: {
    getAuthorizationDetails: (id: string) => Promise<{ data: unknown; error: { message: string } | null }>;
    approveAuthorization: (id: string, o: { skipBrowserRedirect: boolean }) => Promise<{ data: { redirect_url?: string } | null; error: { message: string } | null }>;
    denyAuthorization: (id: string, o: { skipBrowserRedirect: boolean }) => Promise<{ data: { redirect_url?: string } | null; error: { message: string } | null }>;
  };
};

const ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export function validAuthorizationId(raw: unknown): string | null {
  return typeof raw === "string" && ID_RE.test(raw) ? raw : null;
}

/** Where /login sends the merchant back to: this page, the request kept. */
export function consentReturnPath(authorizationId: string): string {
  return `/oauth/consent?authorization_id=${encodeURIComponent(authorizationId)}`;
}

export function loginPathFor(authorizationId: string): string {
  return `/login?redirect=${encodeURIComponent(consentReturnPath(authorizationId))}`;
}

/** "claude.ai" from https://claude.ai/api/mcp/auth_callback; the raw value if it isn't a URL. */
export function redirectDomain(uri: string): string {
  try {
    const u = new URL(uri);
    return u.protocol === "http:" || u.protocol === "https:" ? u.host : `${u.protocol}//${u.host}`.replace(/\/\/$/, "");
  } catch {
    return uri;
  }
}

/** Only an http(s) address leaves this page (never javascript: or data:). */
export function safeRedirect(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    if (u.protocol === "https:" || u.protocol === "http:") return u.toString();
    // Native apps (Codex, Cursor desktop) come back on their own scheme.
    if (/^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && !["javascript:", "data:", "vbscript:", "file:", "blob:"].includes(u.protocol)) return u.toString();
    return null;
  } catch {
    return null;
  }
}

const MISSING = "This link is missing its sign-in request. Start connecting again from your AI assistant.";
const GONE = "This sign-in request has expired or was already used. Start connecting again from your AI assistant.";

export async function loadConsent(auth: ConsentAuth, rawId: unknown): Promise<ConsentStep> {
  const id = validAuthorizationId(rawId);
  if (!id) return { kind: "error", message: MISSING };
  const { data: sessionData } = await auth.getSession();
  if (!sessionData.session) return { kind: "login", to: loginPathFor(id) };
  const { data, error } = await auth.oauth.getAuthorizationDetails(id);
  if (error || !data || typeof data !== "object") return { kind: "error", message: GONE };
  const d = data as Record<string, unknown>;
  // Already approved before: Supabase answers with where to go at once.
  if (!("authorization_id" in d)) {
    const url = safeRedirect(d["redirect_url"]);
    return url ? { kind: "redirect", url } : { kind: "error", message: GONE };
  }
  const client = (d["client"] ?? {}) as { name?: string; uri?: string };
  const user = (d["user"] ?? {}) as { email?: string };
  const redirectUri = String(d["redirect_uri"] ?? "");
  return {
    kind: "details",
    details: {
      authorizationId: String(d["authorization_id"]),
      clientName: (client.name ?? "").trim() || "An AI app",
      clientUri: typeof client.uri === "string" && client.uri ? client.uri : null,
      redirectUri,
      redirectDomain: redirectDomain(redirectUri),
      scopes: String(d["scope"] ?? "")
        .split(/\s+/)
        .filter(Boolean),
      userEmail: typeof user.email === "string" ? user.email : null,
    },
  };
}

export async function decideConsent(
  auth: ConsentAuth,
  authorizationId: string,
  decision: "allow" | "deny",
): Promise<ConsentStep> {
  const call = decision === "allow" ? auth.oauth.approveAuthorization : auth.oauth.denyAuthorization;
  const { data, error } = await call.call(auth.oauth, authorizationId, { skipBrowserRedirect: true });
  const url = safeRedirect(data?.redirect_url);
  if (error || !url)
    return { kind: "error", message: decision === "allow" ? "We couldn't finish connecting. Please start again from your AI assistant." : GONE };
  return { kind: "redirect", url };
}

/** What the page promises, word for word (the MCP tools keep these promises). */
export const CONSENT_CAN = [
  "Read your workspace: campaigns, their results and sales, templates, products, segments, customers, chat flows, the chats that need you and Aiden's questions.",
  "Draft campaigns, chat flows and templates, and prepare tags, changes to scheduled campaigns and your answers to Aiden, for you to review.",
  "Sending, submitting, changing or switching anything on always needs your confirmation.",
];
export const CONSENT_CANNOT =
  "It can't message a customer on its own, change Aiden, billing, your team or settings, or delete anything.";
