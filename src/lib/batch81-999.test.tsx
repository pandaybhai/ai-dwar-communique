import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { memoryDb, type MemoryDb, type Row } from "./test-support/memory-db";

/**
 * Batch 81 — /999 conversion pass: ₹999 as the hero, the growth sticky bar,
 * and a phone-first checkout with no password. Fakes only: no live database,
 * auth, WhatsApp, Meta or gateway is reached.
 */

const h = vi.hoisted(() => ({ db: null as null | { supabase: unknown } }));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.db!.supabase }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children, to }: { children: unknown; to: string }) => (
    <a href={to}>{children as never}</a>
  ),
  useNavigate: () => async () => undefined,
}));

import { runCheckout, provisionalWorkspaceName, type CheckoutDeps } from "./checkout-999-flow";
import {
  ANCHOR,
  EXIT,
  HERO,
  PRICE_BLOCK,
  STICKY,
  fieldError,
  hasTyped,
  revealRest,
  stickyVisible,
  type CheckoutValues,
} from "./page-999";
import { createOrRecallAccount, maskEmail, randomPassword } from "./checkout-999.server";

const OWNER = "22222222-2222-4222-8222-222222222222";
const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "55555555-5555-4555-8555-555555555555";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

const GOOD: CheckoutValues = { phone: "98123 45670", name: "Asha Rao", email: "asha@example.com" };

function fakeDeps(over: Partial<CheckoutDeps> = {}) {
  const calls: string[] = [];
  const state = { session: null as null | { userId: string; token: string } };
  const deps: CheckoutDeps = {
    saveLead: async (body) => {
      calls.push(`lead:${String(body["phone"])}`);
      return { ok: true };
    },
    session: async () => state.session,
    account: async (input) => {
      calls.push(`account:${input.email}`);
      return { status: "created", token_hash: "th_1", user_id: OWNER };
    },
    signInWithToken: async (t) => {
      calls.push(`token:${t}`);
      state.session = { userId: OWNER, token: "tok" };
      return state.session;
    },
    startPay: async (_t, body) => {
      calls.push(`pay${body["organization_id"] ? ":org" : ""}`);
      return {
        status: 200,
        body: {
          ok: true,
          payment_id: "pay-1",
          organization_id: ORG,
          checkout: { payment_session_id: "s", mode: "sandbox" },
        },
      };
    },
    createWorkspace: async (name) => {
      calls.push(`workspace:${name}`);
      return { orgId: ORG };
    },
    openGateway: async () => {
      calls.push("gateway");
      return { error: null };
    },
    confirm: async () => {
      calls.push("confirm");
      return "paid";
    },
    onRegistered: () => calls.push("registered"),
    wait: async () => undefined,
    ...over,
  };
  return { deps, calls, state };
}

/* ============================================================ checkout === */

describe("phone first, no password", () => {
  it("only the WhatsApp number at first; name and email slide in once it's a valid number", () => {
    expect(revealRest({ phone: "", name: "", email: "" })).toBe(false);
    expect(revealRest({ phone: "98123", name: "", email: "" })).toBe(false);
    expect(revealRest({ phone: "+1 917 700 2867", name: "", email: "" })).toBe(false);
    expect(revealRest({ phone: "98123 45670", name: "", email: "" })).toBe(true);
    const sheet = readFileSync("src/components/p999/checkout-999.tsx", "utf8");
    expect(sheet).toContain('const fields = FIELD_ORDER.filter((f) => f === "phone" || revealed)');
    // No password field and no business name in the checkout.
    expect(sheet).not.toMatch(/name: "password"|LABELS\[.*password|Create password/);
    expect(sheet).not.toContain('"business_name"');
    expect(fieldError("email", { ...GOOD, email: "asha@" })).toBe("Enter a valid email");
  });

  it("no password: the server makes the account, this browser is signed in by its one-time token, then pays", async () => {
    const { deps, calls } = fakeDeps();
    const out = await runCheckout(GOOD, deps);
    expect(out).toEqual({
      kind: "paid",
      paymentId: "pay-1",
      organizationId: ORG,
      firstName: "Asha",
    });
    expect(calls).toEqual([
      "lead:98123 45670",
      "account:asha@example.com",
      "token:th_1",
      "registered",
      "pay",
      "gateway",
      "confirm",
    ]);
    // The browser side: verifyOtp with the server's token — the existing auth API.
    const sheet = readFileSync("src/components/p999/checkout-999.tsx", "utf8");
    expect(sheet).toContain("aidwar.auth.verifyOtp({");
    expect(sheet).toContain('type: "magiclink",');
    expect(sheet).not.toContain("aidwar.auth.signUp(");
  });

  it("no workspace yet: one is made under a provisional name; the business name is asked after paying", async () => {
    let first = true;
    const { deps, calls } = fakeDeps({
      startPay: async (_t, body) => {
        calls.push(`pay${body["organization_id"] ? ":org" : ""}`);
        if (first) {
          first = false;
          return { status: 409, body: { code: "needs_workspace" } };
        }
        return {
          status: 200,
          body: {
            ok: true,
            payment_id: "p2",
            organization_id: ORG,
            checkout: { payment_session_id: "s", mode: "sandbox" },
          },
        };
      },
    });
    expect((await runCheckout(GOOD, deps)).kind).toBe("paid");
    expect(calls).toContain("workspace:Asha's business");
    expect(provisionalWorkspaceName("  ")).toBe("My business");
    const sheet = readFileSync("src/components/p999/checkout-999.tsx", "utf8");
    expect(sheet).toContain("What's your business called?");
    expect(sheet).toContain(
      'await aidwar.from("organizations").update({ name }).eq("id", organizationId);',
    );
  });

  it("an email or number that already has an account: 'Welcome back' with a one-time link — no pay, never a dead end", async () => {
    const { deps, calls } = fakeDeps({
      account: async () => ({ status: "existing", sent_to: "as•••@example.com" }),
    });
    expect(await runCheckout(GOOD, deps)).toEqual({
      kind: "existing",
      sentTo: "as•••@example.com",
    });
    expect(calls).not.toContain("pay");
    const sheet = readFileSync("src/components/p999/checkout-999.tsx", "utf8");
    expect(sheet).toContain("Welcome back");
    expect(sheet).toContain("Resend the link");
    expect(sheet).toContain("Use a different email");
  });

  it("already signed in (e.g. back from the emailed link): straight to pay; the email isn't asked", async () => {
    const { deps, calls, state } = fakeDeps();
    state.session = { userId: OWNER, token: "tok" };
    expect((await runCheckout({ ...GOOD, email: "" }, deps, { signedIn: true })).kind).toBe("paid");
    expect(calls.some((c) => c.startsWith("account"))).toBe(false);
  });

  it("success: set a password (optional) with the existing auth API, or have a link emailed; then setup", () => {
    const sheet = readFileSync("src/components/p999/checkout-999.tsx", "utf8");
    expect(sheet).toContain("aidwar.auth.updateUser({ password })");
    expect(sheet).toContain("aidwar.auth.resetPasswordForEmail(email, {");
    expect(sheet).toContain("redirectTo: `${window.location.origin}/set-password`,");
    expect(sheet).toContain('navigate({ to: "/app/start", search: { step: "connect" } })');
    const page = readFileSync("src/routes/set-password.tsx", "utf8");
    expect(page).toContain("aidwar.auth.updateUser({ password })");
    expect(page).toContain('{ name: "robots", content: "noindex" }');
  });
});

/* ============================================================== server === */

describe("the account, on the server", () => {
  function world(extra: Record<string, Row[]> = {}) {
    const db = memoryDb({
      demo_leads: [{ id: LEAD, source: "landing_999", phone: "+919812345670" }],
      profiles: [],
      ...extra,
    });
    const auth = {
      created: [] as Row[],
      otp: [] as Row[],
      existing: new Set<string>(),
      admin: {
        createUser: async (input: Row) => {
          if (auth.existing.has(String(input["email"]))) {
            return {
              data: { user: null },
              error: { message: "A user with this email address has already been registered" },
            };
          }
          auth.created.push(input);
          return { data: { user: { id: OWNER } }, error: null };
        },
        generateLink: async () => ({
          data: { properties: { hashed_token: "hashed_123" } },
          error: null,
        }),
      },
      signInWithOtp: async (input: Row) => {
        auth.otp.push(input);
        return { error: null };
      },
    };
    Object.assign(db.supabase as object, { auth });
    return { db, auth } as { db: MemoryDb; auth: typeof auth };
  }
  const input = { leadId: LEAD, phone: "98123 45670", name: "Asha Rao", email: "Asha@Example.com" };

  it("new: made with a random strong password and the same metadata as /signup; a one-time token comes back", async () => {
    const { db, auth } = world();
    const out = await createOrRecallAccount(db.supabase as never, input);
    expect(out).toEqual({ ok: true, status: "created", token_hash: "hashed_123", user_id: OWNER });
    const made = auth.created[0]!;
    expect(made).toMatchObject({
      email: "asha@example.com",
      email_confirm: true,
      user_metadata: {
        full_name: "Asha Rao",
        phone: "+919812345670",
        signup_source: "landing_999",
      },
    });
    expect(String(made["password"]).length).toBeGreaterThanOrEqual(32);
    expect(JSON.stringify(out)).not.toContain(String(made["password"]));
    expect(randomPassword()).not.toBe(randomPassword());
  });

  it("existing email: never signed in for them — a one-time log-in link to that account, masked", async () => {
    const { db, auth } = world();
    auth.existing.add("asha@example.com");
    const out = await createOrRecallAccount(db.supabase as never, input);
    expect(out).toEqual({ ok: true, status: "existing", sent_to: "as•••@example.com" });
    expect(auth.otp[0]).toMatchObject({
      email: "asha@example.com",
      options: {
        shouldCreateUser: false,
        emailRedirectTo: expect.stringMatching(/\/999\?resume=1$/),
      },
    });
    expect(maskEmail("ab@x.in")).toBe("ab•••@x.in");
  });

  it("existing number: the link goes to the account that has that number (not the typed email)", async () => {
    const { db, auth } = world({
      profiles: [{ id: "u2", phone: "+919812345670", email: "owner@shop.in" }],
    });
    const out = await createOrRecallAccount(db.supabase as never, input);
    expect(out).toMatchObject({ status: "existing", sent_to: "ow•••@shop.in" });
    expect(auth.created).toHaveLength(0);
    expect(auth.otp[0]!["email"]).toBe("owner@shop.in");
  });

  it("only for a browser whose own /999 lead has this number", async () => {
    const { db, auth } = world();
    expect(
      await createOrRecallAccount(db.supabase as never, { ...input, leadId: null }),
    ).toMatchObject({ ok: false, status: 409 });
    expect(
      await createOrRecallAccount(db.supabase as never, { ...input, phone: "91234 56781" }),
    ).toMatchObject({ ok: false, status: 409 });
    expect(
      await createOrRecallAccount(db.supabase as never, { ...input, email: "nope" }),
    ).toMatchObject({ ok: false, field: "email" });
    expect(auth.created).toHaveLength(0);
  });
});

/* ============================================================== leaving === */

describe("exit intent and the sticky bar", () => {
  it("one gentle save screen when leaving with something typed — once per session; never the back button", () => {
    expect(hasTyped({ phone: "", name: "", email: "" })).toBe(false);
    expect(hasTyped({ phone: "98", name: "", email: "" })).toBe(true);
    expect(EXIT).toEqual({
      title: "Your setup is saved.",
      body: "₹999 with a 7-day money-back — no risk.",
      continue: "Continue to pay",
      close: "Close",
    });
    const sheet = readFileSync("src/components/p999/checkout-999.tsx", "utf8");
    expect(sheet).toContain('window.sessionStorage.setItem(EXIT_SEEN_KEY, "1");');
    expect(sheet).toContain('if (hasTyped(values) && !seen && stage.kind !== "exit") {');
    // ✕, Escape, the scrim and a swipe down all ask the same way.
    expect(sheet).toContain("onClick={requestClose}");
    expect(sheet).toContain('if (e.key === "Escape") requestClose();');
    expect(sheet).toContain("if (info.offset.y > 120 || info.velocity.y > 700) requestClose();");
    expect(sheet).not.toMatch(/history\.(pushState|replaceState)|popstate|beforeunload/);
  });

  it("sticky bar: from 30% scrolled (or the hero button gone), hidden only in checkout; 'Finish setup' after an unpaid close", async () => {
    expect(
      stickyVisible({ scrolledFraction: 0.29, heroCtaVisible: true, checkoutOpen: false }),
    ).toBe(false);
    expect(
      stickyVisible({ scrolledFraction: 0.3, heroCtaVisible: true, checkoutOpen: false }),
    ).toBe(true);
    expect(
      stickyVisible({ scrolledFraction: 0.95, heroCtaVisible: false, checkoutOpen: false }),
    ).toBe(true);
    expect(
      stickyVisible({ scrolledFraction: 0.5, heroCtaVisible: false, checkoutOpen: true }),
    ).toBe(false);
    expect(STICKY.proofs).toEqual([
      "7-day money-back",
      "Live in 10 minutes",
      "Zero markup on messages",
      "Cancel anytime",
    ]);
    expect(STICKY.rotateMs).toBe(4000);
    const { StickyBar } = await import("@/components/p999/sections-999");
    const normal = renderToStaticMarkup(
      <StickyBar on onStart={() => undefined} onWarm={() => undefined} />,
    );
    expect(normal).toContain("₹999/month");
    expect(normal).toContain("Get started →");
    expect(normal).toContain("min-h-14"); // 56px — thumb height
    expect(normal).toContain("env(safe-area-inset-bottom)");
    const finish = renderToStaticMarkup(
      <StickyBar on finishSetup onStart={() => undefined} onWarm={() => undefined} />,
    );
    expect(finish).toContain("Finish setup — ₹999 →");
    const page = readFileSync("src/components/p999/page-999.tsx", "utf8");
    expect(page).toContain("if (state && state.typed && !state.paid) setUnfinished(true);");
  });
});

/* ================================================================ page === */

describe("₹999 is the hero", () => {
  it("hero price block + 'Get AiDwar for ₹999 →', the anchor row, and 3 more price blocks (4 CTAs to one checkout)", async () => {
    const { Page999 } = await import("@/components/p999/page-999");
    const html = renderToStaticMarkup(
      <Page999
        rates={{ marketing: 0.8631, utility: 0.115, effective_from: null }}
        aidenLink={null}
        returningPaymentId={null}
      />,
    );
    const text = html
      .replace(/<style[\s\S]*?<\/style>/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&#x27;/g, "'");
    expect(html).toContain('data-testid="hero-price"');
    expect(text).toContain(HERO.priceLine);
    expect(text).toContain("Get AiDwar for ₹999");
    for (const a of ANCHOR) {
      expect(text).toContain(a.label);
      expect(text).toContain(a.value);
    }
    for (const where of ["demo", "calculator", "get"]) {
      expect(html).toContain(`data-testid="price-block-${where}"`);
    }
    expect(text.split(PRICE_BLOCK.cta.replace(" →", "")).length - 1).toBeGreaterThanOrEqual(4);
    // No competitor names, no invented proof.
    expect(text).not.toMatch(/Interakt|Wati|AiSensy|Gallabox|Claude|ChatGPT|OpenAI/i);
    expect(text).not.toContain(
      "Most businesses are answering customers with Aiden the same evening",
    );
    expect(text).toContain("1,909");
  });

  it("the site font no longer blocks first paint (preloaded, attached by a script)", () => {
    const root = readFileSync("src/routes/__root.tsx", "utf8");
    expect(root).toContain('{ rel: "preload", as: "style", href: FONT_CSS },');
    expect(root).toContain("{ children: FONT_LOADER },");
    expect(root).not.toMatch(/rel: "stylesheet",\s*href: "https:\/\/fonts\.googleapis\.com/);
  });

  it("/999 paints from its own inlined CSS; the app sheet loads without blocking — only there", async () => {
    const { LEAN_CSS_ROUTES, LEAN_CSS_ID, leanCssLoader, ensureAppCss } =
      await import("./lean-css");
    // Batch 82: /199 (a copy of /999) paints from its own inlined CSS too.
    expect([...LEAN_CSS_ROUTES]).toEqual(["/999", "/199"]);

    // The root: preload + loader on a lean route, the blocking link everywhere else.
    const root = readFileSync("src/routes/__root.tsx", "utf8");
    expect(root).toContain("const lean = matches.some((m) => LEAN_CSS_ROUTES.has(m.routeId));");
    expect(root).toContain(
      'lean ? { rel: "preload", as: "style", href: appCss } : { rel: "stylesheet", href: appCss },',
    );
    expect(root).toContain("...(lean ? [{ children: leanCssLoader(appCss) }] : []),");

    // The route inlines the page's own Tailwind build; the page re-attaches the
    // app sheet after a client-side navigation in.
    const route = readFileSync("src/routes/999.tsx", "utf8");
    expect(route).toContain('import css999 from "../styles-999.css?inline";');
    expect(route).toContain("styles: [{ children: css999 }],");
    expect(readFileSync("src/components/p999/page-999.tsx", "utf8")).toContain(
      "useEffect(() => ensureAppCss(appCss), []);",
    );

    // The inline sheet is built from the page's files only, and its base rules
    // are styles.css's own light :root values — nothing moves when the app sheet lands.
    const lean = readFileSync("src/styles-999.css", "utf8");
    const app = readFileSync("src/styles.css", "utf8");
    expect(lean).toContain('@import "tailwindcss" source(none);');
    expect(lean.match(/@source "[^"]+";/g)).toEqual([
      '@source "./components/p999";',
      '@source "./routes/999.tsx";',
    ]);
    const token = (name: string) => app.match(new RegExp(`\\n  --${name}: ([^;]+);`))![1]!;
    expect(lean).toContain(`border-color: ${token("border")};`);
    expect(lean).toContain(`background-color: ${token("background")};`);
    expect(lean).toContain(`color: ${token("foreground")};`);
    expect(lean).toContain(`font-family: ${token("font-body")};`);

    // The loader: one stylesheet, never a second when a blocking link already has it.
    const head = { appended: [] as Array<Record<string, string>> };
    const doc = {
      byId: null as unknown,
      blocking: null as unknown,
      getElementById: (id: string) => (id === LEAN_CSS_ID ? doc.byId : null),
      querySelector: () => doc.blocking,
      createElement: () => ({}) as Record<string, string>,
      head: {
        appendChild: (l: Record<string, string>) => {
          head.appended.push(l);
          doc.byId = l;
        },
      },
    };
    const run = () => new Function("document", leanCssLoader("/assets/styles-x.css"))(doc);
    run();
    run();
    expect(head.appended).toEqual([
      { id: LEAN_CSS_ID, rel: "stylesheet", href: "/assets/styles-x.css" },
    ]);
    doc.byId = null;
    doc.blocking = {};
    head.appended = [];
    run();
    expect(head.appended).toEqual([]);

    vi.stubGlobal("document", { ...doc, byId: null, blocking: null, getElementById: () => null });
    try {
      const before = head.appended.length;
      ensureAppCss("/assets/styles-x.css");
      expect(head.appended.length).toBe(before + 1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/* =============================================================== alert === */

describe("the team hears about checkouts that stopped at payment", () => {
  it("the new-lead alert waits for paid, or 10 minutes at payment, and says which", async () => {
    const { alertVariables, leadSettled } = await import("./lead-alerts.server");
    const now = Date.parse("2026-11-15T12:00:00Z");
    const base = {
      id: "l",
      name: "Asha",
      phone: "+919812345670",
      source: "landing_999",
      business_type: null,
      qualification: null,
    };
    const atPay = {
      ...base,
      created_at: "2026-11-15T11:40:00Z",
      checkout_at: "2026-11-15T11:55:00Z",
      paid_at: null,
    };
    expect(leadSettled(atPay as never, now)).toBe(false); // 5 minutes at payment: not yet
    const stopped = { ...atPay, checkout_at: "2026-11-15T11:49:00Z" };
    expect(leadSettled(stopped as never, now)).toBe(true);
    expect(alertVariables(stopped as never)["5"]).toBe(
      "Website /999 · reached payment, didn't pay",
    );
    const paid = { ...atPay, paid_at: "2026-11-15T11:56:00Z" };
    expect(leadSettled(paid as never, now)).toBe(true);
    expect(alertVariables(paid as never)["5"]).toBe("Website /999 · paid ✓");
    const { LEAD_SOURCE_FILTERS } = await import("./leads");
    // Batch 82: the filter covers /199's checkout leads too.
    expect(LEAD_SOURCE_FILTERS.find((f) => f.value === "abandoned")!.label).toBe(
      "/999 or /199 · reached payment, didn't pay",
    );
  });
});
