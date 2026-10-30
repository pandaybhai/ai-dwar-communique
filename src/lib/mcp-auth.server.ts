/**
 * Batch 52: who is calling AiDwar MCP (https://aidwar.in/mcp).
 *
 * The caller is an AI app (Claude, ChatGPT, Codex, Cursor) holding an access
 * token from AiDwar's Supabase OAuth 2.1 server, issued after the merchant
 * approved it on /oauth/consent. The token is the merchant's own user JWT
 * plus a `client_id` claim; the app's own sessions never carry client_id.
 *
 * - The resource metadata (RFC 9728) points clients at the Supabase
 *   authorization server; its `authorization_servers` entry must equal the
 *   issuer in Supabase's discovery document exactly.
 * - A request without a usable token gets 401 with
 *   `WWW-Authenticate: Bearer resource_metadata="…"`, so clients start OAuth.
 * - A token is accepted only when its signature checks out against the
 *   project's keys (getClaims), it hasn't expired, its issuer is this
 *   project's auth server, its audience is "authenticated", it carries a
 *   client_id, and its session still exists (getUser: a grant revoked in
 *   Settings > Connected AI apps stops working at once).
 */

export type McpTokenClaims = {
  sub: string;
  iss: string;
  aud: string | string[];
  exp: number;
  role?: string;
  client_id?: string;
  email?: string;
  [key: string]: unknown;
};

export type McpCaller = { userId: string; clientId: string; email: string | null };

export type TokenVerifier = {
  /** Signature + expiry check; Supabase's auth.getClaims. */
  getClaims: (token: string) => Promise<{ claims: McpTokenClaims | null; error: string | null }>;
  /** The session still exists (not signed out, grant not revoked); Supabase's auth.getUser. */
  sessionAlive: (token: string) => Promise<boolean>;
  /** The expected issuer: https://<ref>.supabase.co/auth/v1. */
  issuer: string;
  now?: () => number;
};

export type TokenCheck =
  | { ok: true; caller: McpCaller }
  | { ok: false; error: "invalid_request" | "invalid_token"; description: string };

/** The Supabase project's auth server, e.g. https://hcsacmqzspnfqoftoifu.supabase.co/auth/v1. */
export function authorizationServer(supabaseUrl = process.env["AIDWAR_SUPABASE_URL"] ?? ""): string {
  if (!supabaseUrl) throw new Error("Missing AiDwar backend configuration.");
  return `${new URL(supabaseUrl).origin}/auth/v1`;
}

/** The MCP endpoint's own address on this origin (https://aidwar.in/mcp in production). */
export function mcpResource(origin: string): string {
  return `${origin}/mcp`;
}

export function resourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource/mcp`;
}

/** RFC 9728 protected resource metadata for /mcp. */
export function protectedResourceMetadata(origin: string, issuer = authorizationServer()) {
  return {
    resource: mcpResource(origin),
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "email", "profile"],
    resource_name: "AiDwar",
    resource_documentation: `${origin}/developers#mcp`,
  };
}

export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers":
    "authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "www-authenticate, mcp-session-id, mcp-protocol-version",
  "access-control-max-age": "86400",
};

export function metadataResponse(origin: string, issuer?: string): Response {
  return Response.json(protectedResourceMetadata(origin, issuer), {
    headers: { ...CORS_HEADERS, "cache-control": "public, max-age=3600" },
  });
}

/** 401 that tells an MCP client where to sign in. */
export function unauthorized(
  origin: string,
  problem?: { error: string; description: string },
): Response {
  const parts = [`Bearer resource_metadata="${resourceMetadataUrl(origin)}"`];
  if (problem) {
    parts.push(`error="${problem.error}"`);
    parts.push(`error_description="${problem.description.replace(/"/g, "'")}"`);
  }
  return Response.json(
    {
      error: problem?.error ?? "unauthorized",
      error_description:
        problem?.description ?? "Sign in to AiDwar to use it from your AI assistant.",
    },
    { status: 401, headers: { ...CORS_HEADERS, "www-authenticate": parts.join(", ") } },
  );
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  if (!/^bearer\s+/i.test(header)) return null;
  const token = header.replace(/^bearer\s+/i, "").trim();
  return token || null;
}

/**
 * The payload of a JWT without checking it. Only for a token another check
 * has already verified (oauthClientIdOf) — never to decide who someone is.
 */
export function unverifiedJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const value = JSON.parse(json) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The OAuth client a (verified) token was issued to; null for an app session. */
export function oauthClientIdOf(token: string): string | null {
  const id = unverifiedJwtPayload(token)?.["client_id"];
  return typeof id === "string" && id ? id : null;
}

/**
 * The app's own /api routes act for a signed-in person. A token an AI app
 * holds (client_id set) may not use them: it would get past the draft-then-
 * confirm rule (and could send a free-text message). Returns the 403 to
 * send back, or null for every app session.
 */
export function refuseOAuthClientToken(token: string): Response | null {
  if (!oauthClientIdOf(token)) return null;
  return Response.json(
    {
      error:
        "AI apps connected to AiDwar can't use this. They work through the AiDwar MCP tools at /mcp, which ask you to confirm before anything is sent.",
    },
    { status: 403 },
  );
}

export async function verifyMcpToken(token: string | null, v: TokenVerifier): Promise<TokenCheck> {
  if (!token) return { ok: false, error: "invalid_request", description: "Sign in to AiDwar to use it from your AI assistant." };
  if (token.split(".").length !== 3) return { ok: false, error: "invalid_token", description: "That isn't an AiDwar access token." };
  const { claims, error } = await v.getClaims(token);
  if (error || !claims) return { ok: false, error: "invalid_token", description: "The access token is invalid or has expired. Sign in again." };
  const nowSec = Math.floor((v.now ? v.now() : Date.now()) / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= nowSec)
    return { ok: false, error: "invalid_token", description: "The access token has expired. Sign in again." };
  if (claims.iss !== v.issuer)
    return { ok: false, error: "invalid_token", description: "That token wasn't issued by AiDwar." };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes("authenticated") || (claims.role && claims.role !== "authenticated"))
    return { ok: false, error: "invalid_token", description: "That token isn't for a signed-in AiDwar user." };
  if (typeof claims.sub !== "string" || !claims.sub)
    return { ok: false, error: "invalid_token", description: "That token has no user." };
  if (typeof claims.client_id !== "string" || !claims.client_id)
    return {
      ok: false,
      error: "invalid_token",
      description: "Connect through your AI assistant's sign-in (OAuth); app session tokens aren't accepted here.",
    };
  if (!(await v.sessionAlive(token)))
    return { ok: false, error: "invalid_token", description: "This connection was signed out or removed. Sign in again." };
  return {
    ok: true,
    caller: {
      userId: claims.sub,
      clientId: claims.client_id,
      email: typeof claims.email === "string" ? claims.email : null,
    },
  };
}

/** The real verifier: the project's Supabase Auth (JWKS-cached getClaims, then getUser). */
export async function supabaseTokenVerifier(): Promise<TokenVerifier> {
  const { createClient } = await import("@supabase/supabase-js");
  const url = process.env["AIDWAR_SUPABASE_URL"] ?? "";
  const anon =
    process.env["AIDWAR_SUPABASE_ANON_KEY"] ??
    (import.meta.env?.["VITE_AIDWAR_SUPABASE_ANON_KEY"] as string | undefined) ??
    "";
  if (!url || !anon) throw new Error("Missing AiDwar backend configuration.");
  const client = createClient(new URL(url).origin, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    issuer: authorizationServer(url),
    getClaims: async (token) => {
      const { data, error } = await client.auth.getClaims(token);
      return { claims: (data?.claims as McpTokenClaims | undefined) ?? null, error: error ? error.message : null };
    },
    sessionAlive: async (token) => {
      const { data, error } = await client.auth.getUser(token);
      return !error && Boolean(data?.user);
    },
  };
}
