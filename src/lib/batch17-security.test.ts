import { readFileSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./test-support/fake-db";

/**
 * Batch 17 (7): security smalls — OAuth callbacks bound to the signed-in user
 * who started them, constant-time cron secret, customer files never served as
 * runnable pages, onboarding re-link needs owner/ai.configure, segment
 * previews need contacts.view.
 */

const h = vi.hoisted(() => ({
  db: null as null | { supabase: unknown },
  role: "owner" as string,
  allowed: new Set<string>(["integrations.manage", "ai.configure", "contacts.view"]),
  exchange: vi.fn(async () => ({ ok: false })),
  googleExchange: vi.fn(async () => ({ error: "stop here" })),
  state: { organizationId: "org", shopDomain: "shop-a.myshopify.com", userId: "u1", bind: "nonce-1" } as Record<string, string>,
}));
vi.mock("@/lib/whatsapp-api.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp-api.server")>()),
  requireOrgMember: async () => ({ supabase: h.db!.supabase, organizationId: "org", userId: "u1", role: h.role }),
  requirePermission: async (_a: unknown, perm: string) => (h.allowed.has(perm) ? null : new Response("no", { status: 403 })),
  logServerActivity: async () => {},
}));
vi.mock("@/lib/permissions.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/permissions.server")>()),
  hasPermission: async (_s: unknown, _o: string, _u: string, perm: string) => h.allowed.has(perm),
}));
vi.mock("@/lib/shopify.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/shopify.server")>()),
  resolveShopifyApp: async () => ({ apiKey: "k", apiSecret: "s", source: "public" }),
  verifyOAuthHmac: async () => true,
  verifyInstallState: async () => h.state,
  exchangeAccessToken: h.exchange,
  getServiceClient: () => (h.db ?? fakeDb(() => undefined)).supabase,
}));
vi.mock("@/lib/flow-connections.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/flow-connections.server")>()),
  readState: () => ({ org: "org", user: "u1", bind: "nonce-g" }),
  googleOAuthConfigured: () => true,
  exchangeGoogleCode: h.googleExchange,
}));
vi.mock("@/lib/whatsapp-webhook.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp-webhook.server")>()),
  getServiceClient: () => (h.db ?? fakeDb(() => undefined)).supabase,
}));

import { bindingCookie, bindingFrom, sameBinding } from "./oauth-binding.server";
import { secretEquals } from "./cron-auth.server";
import { mediaResponseHeaders } from "./media-serve";
import { signInstallState, verifyInstallState } from "./shopify.server";
import { Route as ShopifyCallback } from "../routes/api/public/shopify-callback";
import { Route as GoogleCallback } from "../routes/api/public/google-oauth-callback";
import { Route as FlowScan } from "../routes/api/internal/flow-scan";
import { Route as OnboardingStart } from "../routes/api/onboarding/start";
import { Route as EvaluateSegment } from "../routes/api/contacts/evaluate-segment";
import { Route as Audience } from "../routes/api/campaigns/audience";

type Handler = (ctx: { request: Request }) => Promise<Response>;
const handler = (r: unknown, m: "GET" | "POST") => (r as { options: { server: { handlers: Record<string, Handler> } } }).options.server.handlers[m]!;

afterEach(() => {
  vi.clearAllMocks();
  h.role = "owner";
  h.allowed = new Set(["integrations.manage", "ai.configure", "contacts.view"]);
  delete process.env["CRON_SECRET"];
});

describe("(7) OAuth callbacks need the signed-in user who started them", () => {
  it("the binding cookie is HttpOnly, Secure, SameSite=Lax, scoped to the callbacks; compared in constant time", () => {
    const c = bindingCookie("shopify", "abc");
    expect(c).toMatch(/^aidwar_oauth_shopify=abc; Path=\/api\/public; HttpOnly; Secure; SameSite=Lax; Max-Age=3600$/);
    const req = new Request("http://x/", { headers: { cookie: "a=1; aidwar_oauth_shopify=abc; b=2" } });
    expect(bindingFrom(req, "shopify")).toBe("abc");
    expect(bindingFrom(req, "google")).toBeNull();
    expect(sameBinding("abc", "abc")).toBe(true);
    expect(sameBinding("abc", "abd")).toBe(false);
    expect(sameBinding("abc", null)).toBe(false);
  });

  it("the Shopify state carries the browser nonce (signed)", async () => {
    const real = await vi.importActual<typeof import("./shopify.server")>("./shopify.server");
    const state = await real.signInstallState({ organizationId: "o", shopDomain: "s.myshopify.com", userId: "u", bind: "n1" }, "secret");
    expect(await real.verifyInstallState(state, "secret")).toEqual({ organizationId: "o", shopDomain: "s.myshopify.com", userId: "u", bind: "n1" });
    // (the mocked copies stay in place for the routes below)
    expect(typeof signInstallState).toBe("function");
    expect(typeof verifyInstallState).toBe("function");
  });

  const shopify = (cookie?: string) =>
    handler(ShopifyCallback, "GET")({
      request: new Request("https://aidwar.in/api/public/shopify-callback?shop=shop-a.myshopify.com&code=c&state=st&hmac=h", {
        headers: cookie ? { cookie } : {},
      }),
    });

  it("Shopify: a forwarded link (no cookie / another browser) connects nothing", async () => {
    for (const cookie of [undefined, "aidwar_oauth_shopify=someone-else"]) {
      const res = await shopify(cookie);
      expect(res.headers.get("location")).toContain("shopify_error=state");
    }
    expect(h.exchange).not.toHaveBeenCalled();
  });

  it("Shopify: the starter lost integrations.manage → nothing connected", async () => {
    h.allowed.delete("integrations.manage");
    const res = await shopify("aidwar_oauth_shopify=nonce-1");
    expect(res.headers.get("location")).toContain("shopify_error=state");
    expect(h.exchange).not.toHaveBeenCalled();
  });

  it("Shopify: same browser, still allowed → the install goes ahead", async () => {
    await shopify("aidwar_oauth_shopify=nonce-1");
    expect(h.exchange).toHaveBeenCalledTimes(1);
  });

  const google = (cookie?: string) =>
    handler(GoogleCallback, "GET")({
      request: new Request("https://aidwar.in/api/public/google-oauth-callback?code=c&state=st", { headers: cookie ? { cookie } : {} }),
    });

  it("Google: no cookie, a wrong one, or no permission → failed before the code is exchanged; the starter's browser → exchanged", async () => {
    for (const cookie of [undefined, "aidwar_oauth_google=other"]) {
      expect((await google(cookie)).headers.get("location")).toContain("google=failed");
    }
    h.allowed.delete("integrations.manage");
    await google("aidwar_oauth_google=nonce-g");
    expect(h.googleExchange).not.toHaveBeenCalled();
    h.allowed.add("integrations.manage");
    await google("aidwar_oauth_google=nonce-g");
    expect(h.googleExchange).toHaveBeenCalledTimes(1);
  });

  it("the start APIs set the cookie with the nonce they sign into the state", () => {
    const shop = readFileSync(new URL("../routes/api/integrations/shopify.ts", import.meta.url), "utf8");
    expect(shop).toMatch(/signInstallState\(\{ organizationId, shopDomain, userId, bind \}/);
    expect(shop).toMatch(/"Set-Cookie": bindingCookie\("shopify", bind\)/);
    const g = readFileSync(new URL("../routes/api/integrations/flow-connections.ts", import.meta.url), "utf8");
    expect(g).toMatch(/signState\(\{ org: organizationId, user: userId \?\? "", bind \}\)/);
    expect(g).toMatch(/"Set-Cookie": bindingCookie\("google", bind\)/);
  });
});

describe("(7) cron secret: constant-time", () => {
  it("secretEquals", () => {
    expect(secretEquals("abc", "abc")).toBe(true);
    expect(secretEquals("abd", "abc")).toBe(false);
    expect(secretEquals("ab", "abc")).toBe(false);
    expect(secretEquals(null, "abc")).toBe(false);
    expect(secretEquals("abc", undefined)).toBe(false);
  });

  it("a wrong secret of the right length is refused", async () => {
    process.env["CRON_SECRET"] = "s3cret";
    const res = await handler(FlowScan, "POST")({ request: new Request("http://x/", { method: "POST", headers: { "x-cron-secret": "s3cres" } }) });
    expect(res.status).toBe(401);
  });

  it("no /api/internal route outside billing/campaigns compares the secret with !== / ===", () => {
    const dir = new URL("../routes/api/internal/", import.meta.url);
    const fenced = ["billing-monthly.ts", "billing-notify.ts", "billing-sweep.ts", "plan-billing.ts", "campaign-worker.ts"];
    for (const f of readdirSync(dir)) {
      const src = readFileSync(new URL(f, dir), "utf8");
      if (!src.includes("CRON_SECRET") || fenced.includes(f)) continue;
      expect(src, f).not.toMatch(/provided !== expected|=== cronSecret|provided !== secret/);
      expect(src, f).toMatch(/secretEquals\(/);
    }
  });
});

describe("(7) customer files are never served as runnable pages", () => {
  it("HTML, SVG, XML and unknown types download, sandboxed, nosniff", () => {
    for (const mime of ["text/html", "image/svg+xml", "application/xml", "text/html; charset=utf-8", "application/x-weird", ""]) {
      expect(mediaResponseHeaders(mime)).toMatchObject({
        "content-type": "application/octet-stream",
        "content-disposition": "attachment",
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
      });
    }
  });

  it("photos, voice notes, videos and PDFs stay inline (nosniff too)", () => {
    for (const mime of ["image/jpeg", "image/png", "image/webp", "audio/ogg; codecs=opus", "video/mp4", "application/pdf"]) {
      const out = mediaResponseHeaders(mime);
      expect(out["content-disposition"]).toBe("inline");
      expect(out["x-content-type-options"]).toBe("nosniff");
      expect(out["content-type"]).toBe(mime.split(";")[0]);
    }
  });
});

describe("(7) onboarding re-link: owner or ai.configure only", () => {
  const start = (body: Record<string, unknown>) =>
    handler(OnboardingStart, "POST")({ request: new Request("http://x/", { method: "POST", body: JSON.stringify({ organization_id: "org", ...body }) }) });

  it("a member without ai.configure can't (re-)link; the dashboard card just stays hidden", async () => {
    h.role = "agent";
    h.allowed.delete("ai.configure");
    const db = fakeDb(() => undefined);
    h.db = db;
    expect((await start({ phone: "+919800000001" })).status).toBe(403);
    const card = await start({ mode: "card" });
    expect(card.status).toBe(200);
    expect(await card.json()).toEqual({ show_setup: false });
    // Nothing was read or written for them (not even their profile phone).
    expect(db.ops).toEqual([]);
  });

  it("an admin with ai.configure, or the owner, gets through the gate", async () => {
    for (const role of ["admin", "owner"]) {
      h.role = role;
      const db = fakeDb(() => undefined);
      h.db = db;
      await start({ phone: "+919800000001" });
      expect(db.ops.some((o) => o.table === "profiles")).toBe(true);
    }
  });
});

describe("(7) segment preview / audience need contacts.view", () => {
  for (const [name, route] of [["evaluate-segment", EvaluateSegment], ["campaigns/audience", Audience]] as const) {
    it(`${name}: 403 without contacts.view`, async () => {
      h.allowed.delete("contacts.view");
      h.db = fakeDb(() => undefined);
      const res = await handler(route, "POST")({ request: new Request("http://x/", { method: "POST", body: JSON.stringify({ organization_id: "org", filters: {} }) }) });
      expect(res.status).toBe(403);
    });
  }
});
