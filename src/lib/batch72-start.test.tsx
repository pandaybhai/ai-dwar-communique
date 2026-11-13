import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { memoryDb, type MemoryDb, type Row } from "./test-support/memory-db";

/**
 * Batch 72 — the /start ad landing page and a Lead that Meta can use.
 * Fakes only: the in-memory database, fetch (Graph) and a fake browser.
 * Nothing reaches a live database, WhatsApp or Meta.
 */

const h = vi.hoisted(() => ({ db: null as null | { supabase: unknown } }));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.db!.supabase }));
vi.mock("@/lib/billing-notify.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./billing-notify.server")>()),
  resolvePlatformOrg: async () => "org-platform",
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ to, className, children }: { to: string; className?: string; children: unknown }) => (
    <a href={to} className={className}>
      {children as never}
    </a>
  ),
  useNavigate: () => async () => undefined,
}));

import { StartPage } from "@/components/start/start-page";
import {
  checkStartForm,
  lowestPaidPrice,
  nextBarState,
  pricingTeaser,
  signupSearchFrom,
  stickyBarVisible,
} from "./start-page";
import { fbcFromFbclid, leadEventId, pixelZone } from "./meta-events";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
// Batch 75: a realistic number — /start now refuses straight runs like 98765 43210.
const PHONE = "+919812345670";
const LEAD_ID_FOR_PHONE = `Lead.${sha("919812345670")}`;
const FAKE_TOKEN = "TEST-not-a-real-token";
const OWNER = "5c0f1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b";

const PLANS = [
  { key: "starter", name: "Starter", currency: "INR", price_monthly: 2499 },
  { key: "growth", name: "Growth", currency: "INR", price_monthly: 4999 },
  { key: "enterprise", name: "Enterprise", currency: "INR", price_monthly: null },
];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("/start: the page", () => {
  const html = renderToStaticMarkup(<StartPage plans={PLANS} gstRegistered={false} />);

  it("is noindex,follow, not in the sitemap, and a public pixel page", () => {
    const route = readFileSync("src/routes/start.tsx", "utf8");
    expect(route).toContain('{ name: "robots", content: "noindex,follow" }');
    expect(readFileSync("src/routes/sitemap[.]xml.ts", "utf8")).not.toMatch(/["'`]\/start["'`]/);
    expect(pixelZone("/start")).toBe("public");
  });

  // Batch 73 replaced the page's copy (design + motion + copy only); the full
  // Batch 73 copy, in order, is checked in batch73-start-v2.test.tsx. What
  // Batch 72 needs from the copy still holds: the true figure and the form line.
  it("keeps Batch 72's true figure and the form's promise line", () => {
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("1,900+");
    expect(text).toContain("customers reached in one Diwali campaign");
    expect(text).toContain("Free trial · No card · Live in 10 minutes");
  });

  it("no site navigation and no link farm: only Privacy and Terms (twice the consent link)", () => {
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect([...new Set(hrefs)].sort()).toEqual(["/privacy", "/terms"]);
    expect(html).not.toMatch(/<nav\b/);
    expect(html).toContain("© Meezoy Ventures Pvt Ltd");
    // The logo is not a link.
    expect(html).toMatch(/<span[^>]*aria-label="AiDwar"/);
  });

  // Batch 78: the card opens on step 1 (seven big tap cards); the fields and
  // the consent line are step 3, so they are checked in the card's source.
  it("the forms: real labels, +91 chip, numeric keypad, big targets; the consent line under the button", () => {
    expect(html.match(/role="radio"/g)!.length).toBe(14); // hero + final, 7 cards each
    expect(html.match(/min-h-14/g)!.length).toBeGreaterThanOrEqual(14);
    const card = readFileSync("src/components/start/start-lead-form.tsx", "utf8");
    expect(card.match(/<label/g)!.length).toBeGreaterThanOrEqual(1);
    expect(card).toContain('label="Your name"');
    expect(card).toContain('label="WhatsApp number"');
    expect(card).toContain('inputMode="numeric"');
    expect(card).toContain('autoComplete="tel-national"');
    expect(card).toContain(">\n                +91\n              <");
    expect(card).toContain(
      "By continuing you agree we may contact you on WhatsApp about your trial.",
    );
  });

  it("pricing comes from the public plans: change a price and the text changes", () => {
    expect(pricingTeaser(PLANS)).toBe(
      "Start free. Plans from ₹2,499/month. Pay for WhatsApp messages only when you send.",
    );
    const cheaper = [...PLANS, { key: "lite", name: "Lite", currency: "INR", price_monthly: 999 }];
    expect(pricingTeaser(cheaper)).toContain("Plans from ₹999/month.");
    expect(renderToStaticMarkup(<StartPage plans={cheaper} gstRegistered={false} />)).toContain(
      "₹999/month",
    );
    expect(pricingTeaser(PLANS, true)).toContain("₹2,499/month + GST.");
    expect(pricingTeaser([])).toBe("Start free. Pay for WhatsApp messages only when you send.");
    expect(lowestPaidPrice([{ price_monthly: 0 }, { price_monthly: null }])).toBeNull();
  });
});

describe("/start: the sticky bar", () => {
  it("hidden on load; shown once the hero form scrolls up out of view; hidden again at the final form", () => {
    const hero = {};
    const final = {};
    let s = { heroFormVisible: true, heroFormAbove: false, finalFormVisible: false };
    expect(stickyBarVisible(s)).toBe(false);
    s = nextBarState(
      s,
      [{ target: hero, isIntersecting: false, boundingClientRect: { top: -300 } }],
      hero,
      final,
    );
    expect(stickyBarVisible(s)).toBe(true);
    s = nextBarState(
      s,
      [{ target: final, isIntersecting: true, boundingClientRect: { top: 200 } }],
      hero,
      final,
    );
    expect(stickyBarVisible(s)).toBe(false);
    s = nextBarState(
      s,
      [{ target: final, isIntersecting: false, boundingClientRect: { top: 900 } }],
      hero,
      final,
    );
    expect(stickyBarVisible(s)).toBe(true);
    s = nextBarState(
      s,
      [{ target: hero, isIntersecting: true, boundingClientRect: { top: 100 } }],
      hero,
      final,
    );
    expect(stickyBarVisible(s)).toBe(false);
    // Below the hero form (not yet reached): hidden.
    s = nextBarState(
      s,
      [{ target: hero, isIntersecting: false, boundingClientRect: { top: 1200 } }],
      hero,
      final,
    );
    expect(stickyBarVisible(s)).toBe(false);
  });

  // Batch 78: the bar has no field any more (one button), so it no longer
  // needs to ride above the on-screen keyboard (visualViewport).
  it("the bar sits above the home indicator; the cookie banner sits above the bar", () => {
    const bar = readFileSync("src/components/start/start-sticky-bar.tsx", "utf8");
    expect(bar).toContain("env(safe-area-inset-bottom)");
    expect(bar).not.toContain("<input");
    expect(bar).toContain("--aidwar-bottom-bar");
    expect(readFileSync("src/components/consent-banner.tsx", "utf8")).toContain(
      'bottom: "var(--aidwar-bottom-bar, 0px)"',
    );
  });
});

describe("/start: step 1 and the hand-over to /signup", () => {
  it("the form's own check: 10 digits get +91; a bad number is refused with Batch 66's sentence", () => {
    expect(checkStartForm({ name: "Asha Rao", phone: "98123 45670" })).toEqual({
      ok: true,
      name: "Asha Rao",
      phone: PHONE,
    });
    expect(checkStartForm({ phone: "12345" })).toMatchObject({ ok: false, field: "phone" });
    expect(checkStartForm({ name: "A", phone: "9812345670" })).toMatchObject({
      ok: false,
      field: "name",
    });
  });

  it("the number never goes in a URL: only campaign tags are carried to /signup", () => {
    expect(
      signupSearchFrom("?utm_source=meta&utm_campaign=launch&phone=9812345670&name=Asha&fbclid=x"),
    ).toEqual({
      utm_source: "meta",
      utm_campaign: "launch",
    });
    const form = readFileSync("src/components/start/use-start-funnel.ts", "utf8");
    expect(form).toContain(
      'navigate({ to: "/signup", search: signupSearchFrom(window.location.search)',
    );
    // Batch 78: the hand-off is useToSignup (after WhatsApp verification, or
    // "Continue without verifying"), still through this tab's storage.
    expect(form).toMatch(
      /writeStartPrefill\(\{\s*name: f\.name\.trim\(\),\s*phone: f\.savedPhone \?\? f\.phone/,
    );
  });

  it("sign-up reads the prefill from this tab's storage (editable fields)", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
    const { writeStartPrefill, readStartPrefill, clearStartPrefill } =
      await import("./start-prefill");
    // Batch 78: the business name rides along (sign-up has no field for it).
    writeStartPrefill({ name: "Asha Rao", phone: PHONE });
    expect(readStartPrefill()).toEqual({ name: "Asha Rao", phone: PHONE, business: "" });
    clearStartPrefill();
    expect(readStartPrefill()).toEqual({ name: "", phone: "", business: "" });
    const signup = readFileSync("src/routes/signup.tsx", "utf8");
    expect(signup).toContain("defaultValue={prefill.name}");
    expect(signup).toContain("defaultValue={prefill.phone}");
    expect(signup).toContain('Label htmlFor="full_name">Your name (optional)');
  });
});

// ------------------------------------------------------------------ the server

function world(
  extra: Record<string, Row[]> = {},
): MemoryDb & { graph: { url: string; body: Row }[] } {
  const graph: { url: string; body: Row }[] = [];
  const db = memoryDb({ demo_leads: [], activity_log: [], profiles: [], ...extra });
  Object.assign(db.supabase as object, {
    auth: {
      admin: {
        getUserById: async (id: string) => ({
          data: {
            user:
              id === OWNER
                ? {
                    id,
                    email: "Asha@Example.com",
                    created_at: new Date(Date.now() - 60_000).toISOString(),
                    user_metadata: { phone: PHONE, full_name: "Asha Rao" },
                  }
                : null,
          },
        }),
      },
    },
  });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    graph.push({ url: String(url), body: JSON.parse(String(init.body ?? "{}")) as Row });
    return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
  });
  h.db = { supabase: db.supabase };
  return Object.assign(db, { graph });
}

type Handler = (a: { request: Request }) => Promise<Response>;
async function handler(path: string): Promise<Handler> {
  const mod = (await import(path)) as {
    Route: { options: { server: { handlers: Record<string, Handler> } } };
  };
  return mod.Route.options.server.handlers["POST"]!;
}
const post = (url: string, body: Row) =>
  new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 test",
      "x-forwarded-for": "203.0.113.5",
      referer: "https://aidwar.in/start?utm_source=meta",
    },
    body: JSON.stringify(body),
  });

describe("(server) submitLead: the landing_start path, and /demo unchanged", () => {
  beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => undefined));

  // Batch 78: step 3 sends the two answers and the business name with the
  // number, all at once (nothing is saved before).
  it("stores source landing_start, /start, the +91 number, the name, utm attribution only", async () => {
    const w = world();
    const { submitLead } = await import("./leads.server");
    const out = await submitLead(
      w.supabase,
      {
        source: "landing_start",
        name: "Asha Rao",
        business_name: "Asha Jewels",
        sells: "jewellery",
        customers: "500_5000",
        phone: "98123 45670",
        attribution: {
          utm_source: "meta",
          utm_campaign: "launch",
          fbclid: "IwAR0abcdefghij",
          gclid: "x",
        },
      } as never,
      { ip: "203.0.113.5", referrer: "https://aidwar.in/start" },
    );
    expect(out).toMatchObject({ ok: true, duplicate: false, phone: PHONE, name: "Asha Rao" });
    expect(w.rows("demo_leads")[0]).toMatchObject({
      source: "landing_start",
      landing_path: "/start",
      phone: PHONE,
      name: "Asha Rao",
      business_type: "retail",
      enquiry_band: null,
      primary_need: null,
      business_name: "Asha Jewels",
      qualification: { sells: "jewellery", customers: "500_5000" },
      consent: true,
      consent_version: "start-2026-11-12",
      first_attribution: { utm_source: "meta", utm_campaign: "launch" },
    });
    expect(JSON.stringify(w.rows("demo_leads")[0])).not.toMatch(/fbclid|gclid|IwAR0/);
  });

  // Batch 78: the sticky bar has no field any more and a number on its own is
  // refused (no more number-only rows); a repeat full submission still continues.
  it("a number on its own is refused; a repeat number still continues (duplicate, no error)", async () => {
    const w = world();
    const { submitLead } = await import("./leads.server");
    const meta = { ip: "203.0.113.5", referrer: null };
    expect(
      await submitLead(w.supabase, { source: "landing_start", phone: "9812345670" } as never, meta),
    ).toMatchObject({ ok: false, status: 400 });
    expect(w.rows("demo_leads")).toHaveLength(0);
    const full = {
      source: "landing_start",
      name: "Asha Rao",
      business_name: "Asha Jewels",
      sells: "fashion",
      customers: "under_500",
    };
    const a = await submitLead(w.supabase, { ...full, phone: "9812345670" } as never, meta);
    const b = await submitLead(w.supabase, { ...full, phone: "+91 98123 45670" } as never, meta);
    expect(a).toMatchObject({ ok: true, duplicate: false, name: "Asha Rao" });
    expect(b).toMatchObject({ ok: true, duplicate: true });
    expect(w.rows("demo_leads")).toHaveLength(1);
    expect(await submitLead(w.supabase, { ...full, phone: "123" } as never, meta)).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("/demo still requires its fields and its own number format", async () => {
    const w = world();
    const { submitLead } = await import("./leads.server");
    const meta = { ip: null, referrer: null };
    const full = {
      business_type: "retail",
      enquiry_band: "0-20",
      primary_need: "replies",
      name: "Asha Rao",
      business_name: "ZOORI",
      phone: "+91 98123 45670",
      consent: true,
      consent_version: "2026-09-15",
    };
    expect(
      await submitLead(w.supabase, { ...full, business_type: "" } as never, meta),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      await submitLead(w.supabase, { ...full, business_name: "" } as never, meta),
    ).toMatchObject({ ok: false, status: 400 });
    expect(await submitLead(w.supabase, { ...full, consent: false } as never, meta)).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(
      await submitLead(w.supabase, { ...full, phone: "9812345670" } as never, meta),
    ).toMatchObject({ ok: false, status: 400 });
    expect(await submitLead(w.supabase, full as never, meta)).toMatchObject({ ok: true });
    expect(w.rows("demo_leads")[0]).toMatchObject({
      business_type: "retail",
      consent_version: "2026-09-15",
    });
    expect(w.rows("demo_leads")[0]!["source"]).toBeUndefined(); // the column default ('landing') applies
  });
});

describe("(server) the Lead: one id per person, always sent, hashed matching only", () => {
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubEnv("META_CAPI_TOKEN", FAKE_TOKEN);
    const { resetMetaCapiForTests } = await import("./meta-capi.server");
    resetMetaCapiForTests();
  });

  it("the id is 'Lead.' + sha256 of the E.164 number, however it was typed", async () => {
    expect(await leadEventId("+91 98123 45670")).toBe(LEAD_ID_FOR_PHONE);
    expect(await leadEventId("9812345670")).toBe(LEAD_ID_FOR_PHONE);
    expect(await leadEventId("09812345670")).toBe(LEAD_ID_FOR_PHONE);
    expect(await leadEventId(null, OWNER)).toBe(`Lead.${OWNER}`);
    expect(fbcFromFbclid("IwAR0abcdefghij", 1794466925583)).toBe(
      "fb.1.1794466925583.IwAR0abcdefghij",
    );
    expect(fbcFromFbclid("bad id!", 1)).toBeNull();
  });

  // Batch 78: step 3 no longer sends Lead — it sends LeadUnverified (Lead waits
  // for the WhatsApp proof); the matching is Batch 72's, unchanged.
  it("/start: server LeadUnverified sent (no cookie consent needed) with ph/fn/ln/external_id/country hashes, ip, ua, fbc from fbclid", async () => {
    const w = world();
    const POST = await handler("@/routes/api/public/demo-leads");
    const res = await POST({
      request: post("https://aidwar.in/api/public/demo-leads", {
        source: "landing_start",
        name: "Asha Rao",
        business_name: "Asha Jewels",
        sells: "jewellery",
        customers: "500_5000",
        phone: "98123 45670",
        meta_consent: false,
        fbclid: "IwAR0abcdefghij",
        fbclid_at: 1794466925583,
      }),
    });
    const body = (await res.json()) as Row;
    const unverifiedId = LEAD_ID_FOR_PHONE.replace(/^Lead\./, "LeadUnverified.");
    const params = { lead_source: "landing_start", sells: "jewellery", customers: "500_5000" };
    expect(body).toMatchObject({
      ok: true,
      meta: { event: "LeadUnverified", event_id: unverifiedId, params },
    });
    expect(w.graph).toHaveLength(1);
    const event = (w.graph[0]!.body["data"] as Row[])[0]!;
    expect(event).toMatchObject({
      event_name: "LeadUnverified",
      event_id: unverifiedId,
      action_source: "website",
      custom_data: params,
    });
    const leadId = String(w.rows("demo_leads")[0]!["id"]);
    expect(event["user_data"]).toEqual({
      ph: [sha("919812345670")],
      fn: [sha("asha")],
      ln: [sha("rao")],
      external_id: [sha(leadId)],
      country: [sha("in")],
      client_ip_address: "203.0.113.5",
      client_user_agent: "Mozilla/5.0 test",
      fbc: "fb.1.1794466925583.IwAR0abcdefghij",
    });
    // No raw personal data anywhere in what went to Meta.
    expect(JSON.stringify(w.graph[0]!.body)).not.toMatch(/9812345670|98123|Asha|Rao|asha@/i);
  });

  it("/demo sends the Lead; sign-up sends only CompleteRegistration (Batch 78: 'Lead' means verified only)", async () => {
    const w = world();
    const POST = await handler("@/routes/api/public/demo-leads");
    const res = await POST({
      request: post("https://aidwar.in/api/public/demo-leads", {
        business_type: "retail",
        enquiry_band: "0-20",
        primary_need: "replies",
        name: "Asha Rao",
        business_name: "ZOORI",
        phone: "+91 98123 45670",
        consent: true,
        consent_version: "2026-09-15",
        meta_consent: false,
      }),
    });
    expect(((await res.json()) as Row)["meta"]).toMatchObject({
      event_id: LEAD_ID_FOR_PHONE,
      params: { content_name: "demo", lead_source: "landing" },
    });
    expect((w.graph[0]!.body["data"] as Row[])[0]!["event_id"]).toBe(LEAD_ID_FOR_PHONE);

    // Sign-up (account created): CompleteRegistration only.
    const relay = await handler("@/routes/api/public/meta-event");
    await relay({
      request: post("https://aidwar.in/api/public/meta-event", {
        event: "CompleteRegistration",
        user_id: OWNER,
        url: "https://aidwar.in/signup",
      }),
    });
    const names = w.graph.map((g) => (g.body["data"] as Row[])[0]!["event_name"]);
    expect(names).toEqual(["Lead", "CompleteRegistration"]);

    // A new person signing up straight away: still no Lead (Batch 72 sent
    // one with content_name "signup"; Batch 78 retired it).
    const w2 = world();
    const relay2 = await handler("@/routes/api/public/meta-event");
    await relay2({
      request: post("https://aidwar.in/api/public/meta-event", {
        event: "CompleteRegistration",
        user_id: OWNER,
      }),
    });
    const names2 = w2.graph.map((g) => (g.body["data"] as Row[])[0]!["event_name"]);
    expect(names2).toEqual(["CompleteRegistration"]);
  });
});

describe("(browser) the Lead pixel: only after Accept, same id", () => {
  function fakeBrowser(consent: "accepted" | "declined" | null, path = "/start") {
    const store = new Map<string, string>();
    if (consent) store.set("aidwar.meta_consent", `${consent}:${Date.now()}`);
    const calls: unknown[][] = [];
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    vi.stubGlobal("window", {
      localStorage: storage,
      sessionStorage: storage,
      location: { pathname: path, search: "", href: `https://aidwar.in${path}` },
      addEventListener: () => undefined,
      requestIdleCallback: () => undefined,
      fbq: Object.assign((...a: unknown[]) => calls.push(a), { queue: [] }),
    });
    vi.stubGlobal("document", {
      readyState: "loading",
      head: { appendChild: () => undefined },
      createElement: () => ({}),
      querySelector: () => ({}),
    });
    vi.stubGlobal("fetch", async () => new Response("{}"));
    return calls;
  }

  it("fires Lead with the server's id only with consent", async () => {
    const meta = {
      event: "Lead" as const,
      event_id: LEAD_ID_FOR_PHONE,
      params: { content_name: "start_free_trial", lead_source: "landing_start" },
    };
    let calls = fakeBrowser("declined");
    vi.resetModules();
    let m = await import("./meta-pixel");
    expect(m.fireFromServer(meta)).toBe(false);
    expect(calls).toEqual([]);

    calls = fakeBrowser("accepted");
    vi.resetModules();
    m = await import("./meta-pixel");
    expect(m.fireFromServer(meta)).toBe(true);
    expect(calls).toEqual([["track", "Lead", meta.params, { eventID: LEAD_ID_FOR_PHONE }]]);
  });

  it("sign-up's browser sends CompleteRegistration and no Lead (Batch 78: 'Lead' means verified only)", async () => {
    const calls = fakeBrowser("accepted", "/signup");
    vi.resetModules();
    const m = await import("./meta-pixel");
    m.trackRegistration(OWNER, PHONE);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.some((c) => c[1] === "CompleteRegistration")).toBe(true);
    expect(calls.some((c) => c[1] === "Lead")).toBe(false);
  });
});

describe("/start: the hero phone is an example, not a real customer's chat", () => {
  it("the chat header is 'Your Jewellery Store' (YS); ZOORI appears only in the logo strip, the case study and the bar's line", async () => {
    const { PhoneChat } = await import("@/components/start/phone-chat");
    const chat = renderToStaticMarkup(<PhoneChat />);
    expect(chat).toContain("Your Jewellery Store");
    expect(chat).toMatch(/>\s*YS\s*</);
    expect(chat).not.toMatch(/ZOORI|>\s*ZJ\s*</);
    expect(chat).toContain("An example WhatsApp chat");

    const page = renderToStaticMarkup(<StartPage plans={PLANS} gstRegistered={false} />);
    const text = page.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    // Batch 73: ZOORI only where it is true — the logo marquee (its list twice,
    // the copy aria-hidden), the case study's name and the sticky bar's
    // "Join ZOORI Jewels, Meezoy and more". Never in a chat.
    expect(text.match(/ZOORI/g)).toHaveLength(4);
    expect(text.match(/ZOORI Jewels/g)).toHaveLength(4);
    expect(text).toContain("Live on AiDwar Growth");
  });
});

describe("Super Admin > Leads: a /start lead with only a number", () => {
  beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => undefined));

  it("the list renders and searches with a landing_start row that has only a phone (null answers read '—')", async () => {
    const w = world();
    const { submitLead, listLeads } = await import("./leads.server");
    const meta = { ip: "203.0.113.5", referrer: null };
    // A number-only /start row from before Batch 78 (the old sticky bar);
    // such rows stay in the table, so the list must still read them.
    w.rows("demo_leads").push({
      id: "old-start-lead",
      source: "landing_start",
      phone: PHONE,
      name: null,
      business_name: null,
      business_type: null,
      enquiry_band: null,
      primary_need: null,
      qualification: null,
      is_test: false,
      first_attribution: {},
      latest_attribution: {},
      landing_path: "/start",
      consent: true,
      consent_version: "start-2026-11-12",
      consent_at: "2026-11-12T10:00:00.000Z",
      referrer_host: null,
      website: null,
    });
    // A /demo lead next to it, with every answer.
    expect(
      await submitLead(
        w.supabase,
        {
          business_type: "retail",
          enquiry_band: "21-100",
          primary_need: "campaigns",
          name: "Ravi Kumar",
          business_name: "Kumar Sarees",
          phone: "+91 91234 56789",
          consent: true,
          consent_version: "2026-09-15",
        } as never,
        { ip: "198.51.100.7", referrer: null },
      ),
    ).toMatchObject({ ok: true });

    const { leads } = await listLeads(w.supabase as never);
    // The database fills these in; the in-memory fake doesn't.
    const rows = leads.map((l) => ({
      ...l,
      status: "new" as const,
      created_at: "2026-11-12T10:05:00.000Z",
      updated_at: "2026-11-12T10:05:00.000Z",
      assigned_to: null,
    }));
    const start = rows.find((l) => l.source === "landing_start")!;
    expect(start).toMatchObject({
      phone: PHONE,
      name: null,
      business_name: null,
      business_type: null,
    });

    const { filterLeads, labelFor, BUSINESS_TYPES, leadTitle } = await import("./leads");
    const { LeadsTable, LeadSummary } = await import("@/components/admin/lead-views");

    const html = renderToStaticMarkup(<LeadsTable leads={rows} onOpen={() => undefined} />);
    expect(html).toContain(PHONE);
    expect(html).toContain("From /start");
    expect(html).toContain("Kumar Sarees");
    expect(html).toContain("Campaigns and follow-ups");
    expect(html).not.toMatch(/null|undefined/);
    // The /start row: the number is its heading, and its two answer cells read "—".
    const startRow = html.slice(
      html.indexOf(PHONE),
      html.indexOf("Kumar Sarees") > html.indexOf(PHONE) ? html.indexOf("Kumar Sarees") : undefined,
    );
    expect(startRow.match(/—/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(html.match(/From \/start/g)).toHaveLength(1);

    // Search: by name / business / number, never throwing on a missing name or business.
    const search = (q: string) =>
      filterLeads(rows, { status: "all", search: q, unassignedOnly: false }).map((l) => l.phone);
    expect(search("")).toHaveLength(2);
    expect(search("98123")).toEqual([PHONE]);
    expect(search("kumar")).toEqual(["+919123456789"]);
    expect(search("sarees")).toEqual(["+919123456789"]);
    expect(search("nobody")).toEqual([]);
    expect(filterLeads(rows, { status: "new", search: "", unassignedOnly: true })).toHaveLength(2);

    // The side sheet's summary.
    const sheet = renderToStaticMarkup(<LeadSummary lead={start} />);
    expect(sheet).toContain(PHONE);
    expect(sheet).toContain("Business type");
    expect(sheet).toContain("/start");
    expect(sheet).toContain("vstart-2026-11-12");
    expect(sheet.match(/>—</g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(sheet).not.toMatch(/null|undefined/);
    expect(leadTitle(start)).toBe(PHONE);
    expect(labelFor(BUSINESS_TYPES, null)).toBe("—");
    expect(labelFor(BUSINESS_TYPES, "retail")).toBe("Retail / D2C store");
  });
});
