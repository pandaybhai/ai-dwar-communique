import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CONSENT_CAN,
  CONSENT_CANNOT,
  consentReturnPath,
  decideConsent,
  loadConsent,
  loginPathFor,
  redirectDomain,
  safeRedirect,
  type ConsentAuth,
} from "./oauth-consent";

/**
 * Batch 52 — the OAuth consent page (/oauth/consent, Supabase's
 * Authorization Path) and Settings > Connected AI apps, on a fake Supabase
 * Auth: a signed-out merchant goes to /login and comes back with the request
 * kept; details show who asks, what it may do and where it returns; Allow /
 * Deny go through approveAuthorization / denyAuthorization without the
 * library's own redirect; an earlier approval goes straight back.
 */

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));
vi.mock("@/integrations/aidwar/client", () => ({ aidwar: { auth: {} } }));

const ID = "a1b2c3d4-0000-4000-8000-000000000052";

function fakeAuth(over: { session?: boolean; details?: unknown; detailsError?: boolean; consentUrl?: string | null } = {}) {
  const calls: Array<{ fn: string; id: string; opts?: unknown }> = [];
  const auth: ConsentAuth = {
    getSession: async () => ({ data: { session: over.session === false ? null : { user: { id: "u1" } } } }),
    oauth: {
      getAuthorizationDetails: async (id) => {
        calls.push({ fn: "details", id });
        if (over.detailsError) return { data: null, error: { message: "not found" } };
        return {
          data: over.details ?? {
            authorization_id: id,
            redirect_uri: "https://claude.ai/api/mcp/auth_callback",
            client: { id: "c1", name: "Claude", uri: "https://claude.ai", logo_uri: "" },
            user: { id: "u1", email: "owner@meezoy.example" },
            scope: "openid email",
          },
          error: null,
        };
      },
      approveAuthorization: async (id, opts) => {
        calls.push({ fn: "approve", id, opts });
        return over.consentUrl === null ? { data: null, error: { message: "x" } } : { data: { redirect_url: over.consentUrl ?? "https://claude.ai/api/mcp/auth_callback?code=abc&state=s" }, error: null };
      },
      denyAuthorization: async (id, opts) => {
        calls.push({ fn: "deny", id, opts });
        return { data: { redirect_url: "https://claude.ai/api/mcp/auth_callback?error=access_denied&state=s" }, error: null };
      },
    },
  };
  return { auth, calls };
}

describe("the consent flow", () => {
  it("signed out: to /login and back with the authorization_id kept", async () => {
    const { auth, calls } = fakeAuth({ session: false });
    const step = await loadConsent(auth, ID);
    expect(step).toEqual({ kind: "login", to: `/login?redirect=${encodeURIComponent(`/oauth/consent?authorization_id=${ID}`)}` });
    expect(calls).toHaveLength(0);
    // /login accepts that return path and sends the merchant back to it after signing in.
    const { Route: Login } = await import("../routes/login");
    const validate = (Login.options as unknown as { validateSearch: (s: Record<string, unknown>) => { redirect?: string } }).validateSearch;
    const back = new URL(`https://aidwar.in${(step as { to: string }).to}`).searchParams.get("redirect");
    expect(validate({ redirect: back })).toEqual({ redirect: consentReturnPath(ID) });
    // …and never a path that leaves the site.
    expect(validate({ redirect: "//evil.example/x" })).toEqual({});
    expect(validate({ redirect: "/\\evil.example" })).toEqual({});
    expect(validate({ redirect: "https://evil.example" })).toEqual({});
  });

  it("signed in: who asks, for which account, and the domain it returns to", async () => {
    const { auth } = fakeAuth();
    const step = await loadConsent(auth, ID);
    expect(step).toEqual({
      kind: "details",
      details: {
        authorizationId: ID,
        clientName: "Claude",
        clientUri: "https://claude.ai",
        redirectUri: "https://claude.ai/api/mcp/auth_callback",
        redirectDomain: "claude.ai",
        scopes: ["openid", "email"],
        userEmail: "owner@meezoy.example",
      },
    });
  });

  it("already approved before: straight back to the app", async () => {
    const { auth } = fakeAuth({ details: { redirect_url: "https://chatgpt.com/connector/oauth/cb?code=1" } });
    expect(await loadConsent(auth, ID)).toEqual({ kind: "redirect", url: "https://chatgpt.com/connector/oauth/cb?code=1" });
  });

  it("a missing, malformed or used request is a clear error", async () => {
    const { auth } = fakeAuth({ detailsError: true });
    expect((await loadConsent(auth, undefined)).kind).toBe("error");
    expect((await loadConsent(auth, "<script>")).kind).toBe("error");
    expect(await loadConsent(auth, ID)).toMatchObject({ kind: "error", message: expect.stringContaining("expired") });
  });

  it("Allow and Deny use approveAuthorization / denyAuthorization without the library's redirect", async () => {
    const { auth, calls } = fakeAuth();
    expect(await decideConsent(auth, ID, "allow")).toEqual({ kind: "redirect", url: "https://claude.ai/api/mcp/auth_callback?code=abc&state=s" });
    expect(await decideConsent(auth, ID, "deny")).toEqual({ kind: "redirect", url: "https://claude.ai/api/mcp/auth_callback?error=access_denied&state=s" });
    expect(calls).toEqual([
      { fn: "approve", id: ID, opts: { skipBrowserRedirect: true } },
      { fn: "deny", id: ID, opts: { skipBrowserRedirect: true } },
    ]);
    expect((await decideConsent(fakeAuth({ consentUrl: null }).auth, ID, "allow")).kind).toBe("error");
    expect((await decideConsent(fakeAuth({ consentUrl: "javascript:alert(1)" }).auth, ID, "allow")).kind).toBe("error");
  });

  it("only real addresses leave the page; a native app's own scheme is allowed", () => {
    expect(safeRedirect("javascript:alert(1)")).toBeNull();
    expect(safeRedirect("data:text/html,x")).toBeNull();
    expect(safeRedirect("cursor://anysphere.cursor-mcp/oauth/callback?code=1")).toBe("cursor://anysphere.cursor-mcp/oauth/callback?code=1");
    expect(redirectDomain("http://localhost:8787/callback")).toBe("localhost:8787");
    expect(loginPathFor(ID)).toContain("redirect=%2Foauth%2Fconsent");
  });

  it("the route keeps only a well-formed authorization_id", async () => {
    const { Route } = await import("../routes/oauth.consent");
    const validate = (Route.options as unknown as { validateSearch: (s: Record<string, unknown>) => unknown }).validateSearch;
    expect(validate({ authorization_id: ID })).toEqual({ authorization_id: ID });
    expect(validate({ authorization_id: "a b" })).toEqual({});
  });
});

describe("the consent page", () => {
  it("says who wants what, the limits, the redirect domain, with Allow and Deny", async () => {
    const { ConsentView } = await import("../routes/oauth.consent");
    const { auth } = fakeAuth();
    const step = await loadConsent(auth, ID);
    const html = renderToStaticMarkup(<ConsentView step={step} />);
    expect(html).toContain("Claude wants to use your AiDwar workspace");
    expect(html).toContain("owner@meezoy.example");
    for (const line of CONSENT_CAN) expect(html).toContain(line.replace(/'/g, "&#x27;"));
    expect(html).toContain(CONSENT_CANNOT.replace(/'/g, "&#x27;"));
    expect(html).toContain("claude.ai");
    expect(html).toMatch(/>Deny<\/button>/);
    expect(html).toMatch(/>Allow<\/button>/);
    // The new design's type and tokens; no third-party logo is loaded.
    expect(html).toContain("font-display");
    expect(html).not.toContain("<img");
  });

  it("an error and the loading state", async () => {
    const { ConsentView } = await import("../routes/oauth.consent");
    expect(renderToStaticMarkup(<ConsentView step={{ kind: "error", message: "Gone." }} />)).toContain("Gone.");
    expect(renderToStaticMarkup(<ConsentView step={null} />)).toContain("Checking the request");
  });

  it("follows the Hallmark floor (tokens, no tracked capitals, focus-visible, reduced motion)", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["../routes/oauth.consent.tsx", "../components/settings-v2/connected-ai-apps.tsx"]) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(src).not.toMatch(/transition-all|uppercase|tracking-\[0\.|tracking-wide|#[0-9a-fA-F]{6}\b| · /);
      expect(src).toContain("focus-visible:");
      expect(src.match(/animate-spin/g)?.length ?? 0).toBe(src.match(/motion-safe:animate-spin/g)?.length ?? 0);
    }
  });
});

describe("Settings > Connected AI apps", () => {
  it("lists the person's own grants, newest first, with Remove behind a confirm", async () => {
    const { grantViews, ConnectedAiAppsView } = await import("../components/settings-v2/connected-ai-apps");
    const grants = grantViews([
      { client: { id: "c1", name: "Claude", uri: "https://claude.ai" }, scopes: ["email"], granted_at: "2026-10-01T00:00:00Z" },
      { client: { id: "c2", name: "Cursor", uri: "not a url" }, scopes: [], granted_at: "2026-10-20T00:00:00Z" },
      { client: {}, scopes: [] },
    ]);
    expect(grants.map((g) => g.name)).toEqual(["Cursor", "Claude"]);
    expect(grants[1]!.site).toBe("claude.ai");
    const html = renderToStaticMarkup(<ConnectedAiAppsView grants={grants} confirming="c1" />);
    expect(html).toContain("Remove its access?");
    expect(html).toContain("Remove access");
    expect(html).toContain("https://aidwar.in/mcp");
    expect(renderToStaticMarkup(<ConnectedAiAppsView grants={[]} />)).toContain("No AI apps are connected");
  });

  it("is a Settings section for everyone, after API and webhooks", async () => {
    const { visibleSections } = await import("@/components/settings-v2/settings-sections");
    const keys = visibleSections({ shopify: false, connections: false, sending: false, api: true, compliance: false, notifications: true, owner: false, aiApps: true }).map((s) => s.key);
    expect(keys).toEqual(["general", "team", "whatsapp", "api", "ai_apps", "notifications", "sources"]);
  });
});
