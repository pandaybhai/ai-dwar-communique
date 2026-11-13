import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { memoryDb, type MemoryDb, type Row } from "./test-support/memory-db";

/**
 * Batch 78 — /start: questions first, three easy taps, the number last,
 * proved on WhatsApp ("VERIFY V-XXXX" to AiDwar's own number) before Meta's
 * Lead fires. Fakes only: the in-memory database, recording WhatsApp
 * senders, a stubbed fetch for Graph and a fake token. Nothing reaches a
 * live database, WhatsApp or Meta.
 */

const h = vi.hoisted(() => ({
  db: null as null | { supabase: unknown },
  replies: [] as Array<{ to: string; body: string; kind: string }>,
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.db!.supabase }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ to, className, children }: { to: string; className?: string; children: unknown }) => (
    <a href={to} className={className}>
      {children as never}
    </a>
  ),
  useNavigate: () => async () => undefined,
}));
vi.mock("@/lib/billing-notify.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./billing-notify.server")>()),
  resolvePlatformOrg: async () => "org-platform",
}));
vi.mock("@/lib/service-text.server", () => ({
  sendServiceText: async (_s: unknown, args: { to: string; body: string; metadata?: Row }) => {
    h.replies.push({ to: args.to, body: args.body, kind: String(args.metadata?.["kind"] ?? "") });
    return { ok: true, messageId: "wamid.reply" };
  },
}));

import { INDIA_MOBILE_ERROR, indiaWhatsApp } from "./phone";
import { checkRealNumber, REAL_NUMBER_ERROR } from "./start-qualify";
import {
  INITIAL_FUNNEL,
  afterDetailsSent,
  back,
  checkDetails,
  createFunnelStore,
  pickCustomers,
  pickSells,
  progressOf,
} from "./start-funnel";
import { readVerifyCode, VERIFY_CODE_RE } from "./lead-verify";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const PHONE = "+919812345670";
const WA = "919812345670";
const AIDWAR = "919121881110";
const LEAD_ID = `Lead.${sha(WA)}`;
const UNVERIFIED_ID = `LeadUnverified.${sha(WA)}`;
const MIN = 60 * 1000;

beforeEach(() => {
  vi.stubEnv("AIDWAR_SUPABASE_SERVICE_ROLE_KEY", "test-only-service-key");
  vi.stubEnv("META_CAPI_TOKEN", "TEST-not-a-real-token");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  h.replies = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type Graph = { url: string; body: Row };
function world(): MemoryDb & { graph: Graph[] } {
  const graph: Graph[] = [];
  const db = memoryDb({
    demo_leads: [],
    lead_verifications: [],
    activity_log: [],
    profiles: [],
    platform_settings: [{ id: 1, onboarding_whatsapp_account_id: "acct-aidwar" }],
    whatsapp_accounts: [
      {
        id: "acct-aidwar",
        organization_id: "org-platform",
        display_phone_number: "+91 91218 81110",
      },
    ],
    contacts: [],
    tags: [],
    contact_tags: [],
    contact_notes: [],
  });
  Object.assign(db.supabase as object, {
    auth: { admin: { getUserById: async () => ({ data: { user: null } }) } },
  });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    graph.push({ url: String(url), body: JSON.parse(String(init.body ?? "{}")) as Row });
    return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
  });
  h.db = { supabase: db.supabase };
  return Object.assign(db, { graph });
}

type Handler = (a: { request: Request }) => Promise<Response>;
async function route(path: string, method: "GET" | "POST" = "POST"): Promise<Handler> {
  const mod = (await import(path)) as {
    Route: { options: { server: { handlers: Record<string, Handler> } } };
  };
  return mod.Route.options.server.handlers[method]!;
}
function req(url: string, body: Row | null, cookie?: string, method = "POST"): Request {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 test",
      "x-forwarded-for": "203.0.113.5",
      referer: "https://aidwar.in/start",
      ...(cookie ? { cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const STEP3 = {
  source: "landing_start",
  sells: "jewellery",
  customers: "500_5000",
  name: "Asha Rao",
  business_name: "Asha Jewels",
  phone: "98123 45670",
  landing_path: "/start",
  company_website_confirm: "",
  fbclid: "IwAR0abcdefghij",
  fbclid_at: 1794466925583,
};
/** "a=1; Path…, b=2; Path…" → "a=1; b=2" */
function cookiesOf(res: Response): string {
  const all = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
  return all.map((c) => c.split(";")[0]).join("; ");
}
const events = (w: { graph: Graph[] }) =>
  w.graph.flatMap((g) => ((g.body["data"] as Row[] | undefined) ?? []) as Row[]);
async function submit(w: MemoryDb, body: Row = {}) {
  void w;
  return (await route("@/routes/api/public/demo-leads"))({
    request: req("https://aidwar.in/api/public/demo-leads", { ...STEP3, ...body }),
  });
}
const channel = {
  organizationId: "org-platform",
  phoneNumberId: "pn-1",
  accessToken: "token",
  conversationId: "conv-1",
  to: WA,
};
async function inbound(w: MemoryDb, waId: string, body: string, now?: number) {
  const { handleVerifyMessage } = await import("./lead-verify.server");
  return handleVerifyMessage(w.supabase as never, {
    channel: { ...channel, to: waId },
    waId,
    body,
    ...(now === undefined ? {} : { now }),
  });
}

/* ------------------------------------------------------------ the card --- */

describe("the 3-step card", () => {
  it("one tap = picked and on to the next; Back keeps every answer; 1/3 → 2/3 → 3/3", () => {
    let f = INITIAL_FUNNEL;
    expect(f.step).toBe("sells");
    expect(progressOf(f.step)).toBe(1);
    f = pickSells(f, "fashion");
    expect(f).toMatchObject({ step: "customers", sells: "fashion" });
    expect(progressOf(f.step)).toBe(2);
    f = pickCustomers(f, "5000_plus");
    expect(f).toMatchObject({ step: "details", customers: "5000_plus" });
    expect(progressOf(f.step)).toBe(3);
    f = { ...f, name: "Asha", business: "Asha Jewels", phone: "98123 45670" };
    f = back(f);
    expect(f).toMatchObject({
      step: "customers",
      sells: "fashion",
      customers: "5000_plus",
      name: "Asha",
    });
    f = back(f);
    expect(f).toMatchObject({ step: "sells", sells: "fashion", customers: "5000_plus" });
    expect(back(f).step).toBe("sells");
    // No Continue button: the taps themselves move on.
    const card = readFileSync("src/components/start/start-lead-form.tsx", "utf8");
    expect(card).toContain("window.setTimeout(onPick, 160)");
    expect(card).not.toMatch(/>\s*Continue\s*</);
  });

  it("the cards: 7 with icons in 2 columns, 3 for customers, 56px tall, a check when picked", async () => {
    const { funnelStore } = await import("./start-funnel");
    const { StartLeadForm } = await import("@/components/start/start-lead-form");
    const render = () => renderToStaticMarkup(<StartLeadForm variant="hero" />);
    funnelStore.set(INITIAL_FUNNEL);
    let html = render();
    const text = html
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ");
    for (const label of [
      "What do you sell?",
      "Jewellery",
      "Fashion",
      "Food & café",
      "Online store",
      "Clinic & salon",
      "Education",
      "Other",
      "1/3",
    ]) {
      expect(text, label).toContain(label);
    }
    expect(html).toContain("grid-cols-2");
    expect(html.match(/role="radio"/g)).toHaveLength(7);
    expect(html.match(/min-h-14/g)!.length).toBeGreaterThanOrEqual(7);
    expect(html.match(/<svg/g)!.length).toBeGreaterThanOrEqual(7);
    funnelStore.set({ ...INITIAL_FUNNEL, step: "customers", sells: "jewellery" });
    html = render();
    expect(html).toContain("How many customers do you have?");
    expect(html.match(/role="radio"/g)).toHaveLength(3);
    expect(html).toContain("Back");
    expect(html).toContain("2/3");
    funnelStore.set({ ...INITIAL_FUNNEL, step: "sells", sells: "fashion" });
    expect(render()).toMatch(/aria-checked="true"[^]*?Fashion/);
    funnelStore.set(INITIAL_FUNNEL);
  });

  it("step 3: name, business name, WhatsApp number (+91, numeric keypad), Verify on WhatsApp, the copy", async () => {
    const { funnelStore } = await import("./start-funnel");
    const { StartLeadForm } = await import("@/components/start/start-lead-form");
    funnelStore.set({
      ...INITIAL_FUNNEL,
      step: "details",
      sells: "jewellery",
      customers: "under_500",
    });
    const html = renderToStaticMarkup(<StartLeadForm variant="hero" />);
    funnelStore.set(INITIAL_FUNNEL);
    const text = html
      .replace(/<[^>]+>/g, " ")
      .replace(/&#x27;/g, "'")
      .replace(/\s+/g, " ");
    expect(text).toContain("Where should we send your free trial?");
    expect(text).toContain("Your name");
    expect(text).toContain("Business name");
    expect(text).toContain("WhatsApp number");
    expect(text).toContain("Verify on WhatsApp");
    expect(text).toContain("Free trial · No card · We'll confirm your number on WhatsApp");
    expect(text).toContain("3/3");
    expect(html).toMatch(/inputmode="numeric"|inputMode="numeric"/);
    expect(html).toMatch(/autocomplete="tel-national"|autoComplete="tel-national"/);
    expect(html).toContain(">+91<");
    expect(html).toContain('name="company_website_confirm"');
  });

  it("nothing is saved before step 3: the card posts only from step 3, and the server refuses less", async () => {
    const card = readFileSync("src/components/start/start-lead-form.tsx", "utf8");
    expect(card.match(/fetch\("\/api\/public\/demo-leads"/g)).toHaveLength(1);
    expect(card).toContain('if (f.step !== "details" || sending) return;');
    const w = world();
    for (const partial of [
      { sells: undefined },
      { customers: undefined },
      { name: "" },
      { business_name: "" },
      { phone: "" },
    ]) {
      expect((await submit(w, partial)).status, JSON.stringify(partial)).toBe(400);
    }
    expect(w.rows("demo_leads")).toHaveLength(0);
    expect(events(w)).toHaveLength(0);
  });

  it("step 3's own check: all three needed, the phone rule, inline errors by field", () => {
    expect(
      checkDetails({ name: "Asha Rao", business: "Asha Jewels", phone: "98123 45670" }),
    ).toEqual({
      ok: true,
      name: "Asha Rao",
      business: "Asha Jewels",
      phone: PHONE,
    });
    expect(checkDetails({ name: "", business: "x y", phone: "9812345670" })).toMatchObject({
      field: "name",
    });
    expect(checkDetails({ name: "Asha", business: "", phone: "9812345670" })).toMatchObject({
      field: "business",
    });
    expect(checkDetails({ name: "Asha", business: "AJ", phone: "73078015438" })).toEqual({
      ok: false,
      field: "phone",
      error: INDIA_MOBILE_ERROR,
    });
  });

  it("the sticky bar only scrolls to the card: one button, no field, no request", () => {
    const bar = readFileSync("src/components/start/start-sticky-bar.tsx", "utf8");
    expect(bar).not.toContain("<input");
    expect(bar).not.toContain("fetch(");
    expect(bar).not.toContain("StartLeadForm");
    expect(bar).toContain("onClick={onStart}");
    expect(bar).toContain("Start free trial");
    const page = readFileSync("src/components/start/start-page.tsx", "utf8");
    expect(page).toContain("onStart={toForm}");
    expect(page).toMatch(/heroForm\.current\?\.scrollIntoView/);
    // One shared store: hero, final and the bar all carry on from the same step.
    const store = createFunnelStore();
    let seen = 0;
    store.subscribe(() => (seen += 1));
    store.set((f) => pickSells(f, "education"));
    expect(store.get()).toMatchObject({ step: "customers", sells: "education" });
    expect(seen).toBe(1);
  });
});

/* -------------------------------------------------------- verification --- */

describe("WhatsApp verification", () => {
  it("step 3 saves the lead once, complete, and answers a VERIFY code bound to lead + number + nonce", async () => {
    const w = world();
    const res = await submit(w);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Row;
    const leads = w.rows("demo_leads");
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({
      source: "landing_start",
      name: "Asha Rao",
      business_name: "Asha Jewels",
      phone: PHONE,
      qualification: { sells: "jewellery", customers: "500_5000" },
    });
    const verify = body["verify"] as Row;
    const code = readVerifyCode(decodeURIComponent(String(verify["wa_link"])));
    expect(code).toMatch(/^V-[A-Z2-9]{4}$/);
    expect(verify["wa_link"]).toBe(`https://wa.me/${AIDWAR}?text=VERIFY%20${code}`);
    expect(verify["message"]).toBe(`VERIFY ${code}`);
    const cookies = cookiesOf(res);
    expect(cookies).toMatch(/aidwar_start_lead=/);
    expect(cookies).toMatch(/aidwar_start_nonce=/);
    for (const c of res.headers.getSetCookie()) expect(c).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    const nonce = /aidwar_start_nonce=([^;]+)/.exec(cookies)![1]!;
    const row = w.rows("lead_verifications")[0]!;
    expect(row).toMatchObject({ lead_id: leads[0]!["id"], code, phone: PHONE });
    expect(row["used_at"] ?? null).toBeNull();
    expect(row["browser_nonce_hash"]).toBe(sha(nonce));
    expect(row["browser_nonce_hash"]).not.toBe(nonce);
    const ttl = Date.parse(String(row["expires_at"])) - Date.now();
    expect(ttl).toBeGreaterThan(14 * MIN);
    expect(ttl).toBeLessThanOrEqual(15 * MIN);
    // A repeat within 10 minutes is the same lead, never a second row.
    await submit(w);
    expect(w.rows("demo_leads")).toHaveLength(1);
  });

  it("only the matching sender wa_id verifies; a wrong number never learns whose code it is", async () => {
    const w = world();
    const res = await submit(w);
    const code = String(((await res.json()) as { verify: Row }).verify["message"]).slice(7);
    expect(await inbound(w, "919000000001", `VERIFY ${code}`)).toBe(true);
    expect(h.replies.at(-1)).toMatchObject({
      to: "919000000001",
      kind: "lead_verify_wrong_number",
    });
    expect(h.replies.at(-1)!.body).not.toMatch(/98123|Asha|Jewels/);
    expect(w.rows("demo_leads")[0]!["verified_at"]).toBeUndefined();
    expect(w.rows("lead_verifications")[0]!["attempts"]).toBe(1);

    expect(await inbound(w, WA, `Hi! VERIFY ${code.toLowerCase()}`)).toBe(true);
    const reply = h.replies.at(-1)!;
    expect(reply.kind).toBe("lead_verify_verified");
    expect(reply.body).toMatch(
      /^✅ Verified, Asha! Tap to finish your free trial: https:\/\/aidwar\.in\/start\/continue\?t=/,
    );
    expect(w.rows("demo_leads")[0]!["verified_at"]).toBeTruthy();
    expect(w.rows("lead_verifications")[0]!["used_at"]).toBeTruthy();
    // Single use: sending it again just repeats the link, nothing changes.
    const at = w.rows("demo_leads")[0]!["verified_at"];
    await inbound(w, WA, `VERIFY ${code}`);
    expect(h.replies.at(-1)!.kind).toBe("lead_verify_repeat");
    expect(w.rows("demo_leads")[0]!["verified_at"]).toBe(at);
    // Unknown code.
    await inbound(w, WA, "VERIFY V-ZZZZ");
    expect(h.replies.at(-1)!.kind).toBe("lead_verify_unknown");
    // No code at all: not ours (the platform pipeline carries on).
    expect(await inbound(w, WA, "hello")).toBe(false);
  });

  it("an expired code fails; a locked one too", async () => {
    const w = world();
    const res = await submit(w);
    const code = String(((await res.json()) as { verify: Row }).verify["message"]).slice(7);
    await inbound(w, WA, `VERIFY ${code}`, Date.now() + 16 * MIN);
    expect(h.replies.at(-1)!.kind).toBe("lead_verify_expired");
    expect(w.rows("demo_leads")[0]!["verified_at"]).toBeUndefined();
    (w.rows("lead_verifications")[0] as Row)["attempts"] = 5;
    await inbound(w, WA, `VERIFY ${code}`);
    expect(h.replies.at(-1)!.kind).toBe("lead_verify_expired");
  });

  it("the page polls with its cookies; a wrong nonce sees nothing; verified → /signup prefilled", async () => {
    const w = world();
    const res = await submit(w);
    const cookies = cookiesOf(res);
    const code = String(((await res.json()) as { verify: Row }).verify["message"]).slice(7);
    const poll = async (cookie: string) =>
      (await (
        await route("@/routes/api/public/start-verify", "GET")
      )({
        request: req("https://aidwar.in/api/public/start-verify", null, cookie, "GET"),
      }).then((r) => r.json())) as Row;
    expect(await poll(cookies)).toEqual({ state: "waiting" });
    const wrongNonce = cookies.replace(
      /aidwar_start_nonce=[^;]+/,
      "aidwar_start_nonce=" + "x".repeat(32),
    );
    expect(await poll(wrongNonce)).toEqual({ state: "none" });
    expect(await poll("")).toEqual({ state: "none" });
    await inbound(w, WA, `VERIFY ${code}`);
    expect(await poll(cookies)).toEqual({ state: "verified" });
    expect(await poll(wrongNonce)).toEqual({ state: "none" });
    // The claim gives /signup's prefill (from the lead, not the browser).
    const claim = await (
      await route("@/routes/api/public/start-verify")
    )({
      request: req("https://aidwar.in/api/public/start-verify", { action: "claim" }, cookies),
    });
    expect(claim.status).toBe(200);
    expect(await claim.json()).toMatchObject({
      state: "verified",
      prefill: { name: "Asha Rao", phone: PHONE, business_name: "Asha Jewels" },
    });
    const wrong = await (
      await route("@/routes/api/public/start-verify")
    )({
      request: req("https://aidwar.in/api/public/start-verify", { action: "claim" }, wrongNonce),
    });
    expect(wrong.status).toBe(409);
    // The page: poll every 2 s while visible, at most 15 minutes, then /signup prefilled.
    const card = readFileSync("src/components/start/use-start-funnel.ts", "utf8");
    expect(card).toContain("if (stop || document.hidden) return;");
    expect(card).toContain("POLL_FOR_MS");
    expect(card).toContain("void toSignup(next)");
    const { POLL_MS, POLL_FOR_MS } = await import("./lead-verify");
    expect([POLL_MS, POLL_FOR_MS]).toEqual([2000, 15 * MIN]);
  });

  it("'Continue without verifying' shows after 60 s and goes to /signup anyway", async () => {
    const { funnelStore } = await import("./start-funnel");
    const { StartLeadForm } = await import("@/components/start/start-lead-form");
    const verify = {
      wa_link: `https://wa.me/${AIDWAR}?text=VERIFY%20V-ABCD`,
      message: "VERIFY V-ABCD",
      expires_at: "",
    };
    const at = (shownAgo: number) => {
      funnelStore.set({
        ...afterDetailsSent(
          { ...INITIAL_FUNNEL, name: "Asha" },
          PHONE,
          verify,
          Date.now() - shownAgo,
        ),
      });
      return renderToStaticMarkup(<StartLeadForm variant="hero" />);
    };
    const fresh = at(5_000);
    expect(fresh).toContain("Open WhatsApp to verify");
    expect(fresh).toContain("Tap send in WhatsApp — we&#x27;ll do the rest.");
    expect(fresh).toContain(`href="https://wa.me/${AIDWAR}?text=VERIFY%20V-ABCD"`);
    expect(fresh).not.toContain("Continue without verifying");
    expect(at(61_000)).toContain("Continue without verifying");
    funnelStore.set(INITIAL_FUNNEL);
    const { SKIP_AFTER_MS } = await import("./lead-verify");
    expect(SKIP_AFTER_MS).toBe(60_000);
    // No code (verification unavailable): straight on to /signup — nobody is stuck.
    expect(afterDetailsSent(INITIAL_FUNNEL, PHONE, null, 0).step).toBe("verified");
  });

  it("verification not available (20261420 not applied / no AiDwar number): the lead is saved, verify is null", async () => {
    const w = world();
    (w.rows("platform_settings")[0] as Row)["onboarding_whatsapp_account_id"] = null;
    const res = await submit(w);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Row)["verify"]).toBeNull();
    expect(w.rows("demo_leads")).toHaveLength(1);
  });

  it("VERIFY is the first stage of the platform-number pipeline (before AD codes and strangers)", () => {
    const src = readFileSync("src/lib/merchant-channel.server.ts", "utf8");
    const verify = src.indexOf("VERIFY_CODE_RE.test(body)");
    expect(verify).toBeGreaterThan(0);
    expect(verify).toBeLessThan(src.indexOf("const ownerOrgs = await ownerOrganizationIds"));
    expect(verify).toBeLessThan(src.indexOf("if (byCode && !interactiveId)"));
    expect(VERIFY_CODE_RE.test("VERIFY V-7K2P")).toBe(true);
    expect(VERIFY_CODE_RE.test("AD-1234")).toBe(false);
    // Merchant (non-platform) inbound is untouched.
    expect(readFileSync("src/lib/whatsapp-webhook.server.ts", "utf8")).not.toContain("lead-verify");
  });
});

/* ---------------------------------------------------------------- Meta --- */

describe("Meta events", () => {
  it("step 3 → LeadUnverified (not Lead); verification → Lead once per number, with the answers; no LeadQualified", async () => {
    const w = world();
    const res = await submit(w);
    const body = (await res.json()) as Row;
    expect(body["meta"]).toEqual({
      event: "LeadUnverified",
      event_id: UNVERIFIED_ID,
      params: { lead_source: "landing_start", sells: "jewellery", customers: "500_5000" },
    });
    expect(events(w).map((e) => e["event_name"])).toEqual(["LeadUnverified"]);
    const cookies = cookiesOf(res);
    const code = String((body["verify"] as Row)["message"]).slice(7);
    await inbound(w, WA, `VERIFY ${code}`);
    // The webhook itself sends nothing to Meta (no browser, no fbc there).
    expect(events(w).map((e) => e["event_name"])).toEqual(["LeadUnverified"]);
    const claim = async () =>
      (await (
        await route("@/routes/api/public/start-verify")
      )({
        request: req(
          "https://aidwar.in/api/public/start-verify",
          { fbclid: "IwAR0abcdefghij", fbclid_at: 1794466925583, action: "claim" },
          cookies,
        ),
      }).then((r) => r.json())) as Row;
    const out = await claim();
    expect(out["meta"]).toEqual({
      event: "Lead",
      event_id: LEAD_ID,
      params: {
        lead_source: "landing_start",
        sells: "jewellery",
        customers: "500_5000",
        verified: true,
      },
    });
    const lead = events(w).filter((e) => e["event_name"] === "Lead");
    expect(lead).toHaveLength(1);
    expect(lead[0]).toMatchObject({
      event_id: LEAD_ID,
      action_source: "website",
      custom_data: {
        lead_source: "landing_start",
        sells: "jewellery",
        customers: "500_5000",
        verified: true,
      },
    });
    const ud = lead[0]!["user_data"] as Row;
    const leadId = String(w.rows("demo_leads")[0]!["id"]);
    expect(ud).toMatchObject({
      ph: [sha(WA)],
      fn: [sha("asha")],
      ln: [sha("rao")],
      external_id: [sha(leadId)],
      fbc: "fb.1.1794466925583.IwAR0abcdefghij",
    });
    expect(JSON.stringify(lead[0])).not.toMatch(/98123|Asha|Jewels/);
    // Once per number: claiming again, the resume link, the worker — nothing more.
    await claim();
    const { continueToken } = await import("./start-lead-cookie.server");
    const cont = await (
      await route("@/routes/api/public/start-continue")
    )({
      request: req("https://aidwar.in/api/public/start-continue", {
        t: await continueToken(leadId),
      }),
    });
    expect(await cont.json()).toMatchObject({ verified: true, business_name: "Asha Jewels" });
    const { runVerifiedLeadEvents } = await import("./lead-verify.server");
    await runVerifiedLeadEvents(w.supabase as never, { now: Date.now() + 5 * MIN });
    expect(events(w).filter((e) => e["event_name"] === "Lead")).toHaveLength(1);
    expect(events(w).map((e) => e["event_name"])).not.toContain("LeadQualified");
  });

  it("an unverified lead never gets Lead (claim refused, resume link sends nothing)", async () => {
    const w = world();
    const res = await submit(w);
    const claim = await (
      await route("@/routes/api/public/start-verify")
    )({
      request: req(
        "https://aidwar.in/api/public/start-verify",
        { action: "claim" },
        cookiesOf(res),
      ),
    });
    expect(claim.status).toBe(409);
    const { continueToken } = await import("./start-lead-cookie.server");
    const leadId = String(w.rows("demo_leads")[0]!["id"]);
    const cont = await (
      await route("@/routes/api/public/start-continue")
    )({
      request: req("https://aidwar.in/api/public/start-continue", {
        t: await continueToken(leadId),
      }),
    });
    expect(await cont.json()).toMatchObject({ verified: false, meta: null });
    expect(events(w).map((e) => e["event_name"])).toEqual(["LeadUnverified"]);
  });

  it("the worker sends Lead for a verified lead whose page never did — once", async () => {
    const w = world();
    const res = await submit(w);
    const code = String(((await res.json()) as { verify: Row }).verify["message"]).slice(7);
    await inbound(w, WA, `VERIFY ${code}`);
    // The database's default (is_test false); the in-memory fake has none.
    (w.rows("demo_leads")[0] as Row)["is_test"] = false;
    const { runVerifiedLeadEvents } = await import("./lead-verify.server");
    // Too soon (the page gets 2 minutes to send it itself).
    await runVerifiedLeadEvents(w.supabase as never, { now: Date.now() });
    expect(events(w).filter((e) => e["event_name"] === "Lead")).toHaveLength(0);
    await runVerifiedLeadEvents(w.supabase as never, { now: Date.now() + 3 * MIN });
    const lead = events(w).filter((e) => e["event_name"] === "Lead");
    expect(lead).toHaveLength(1);
    expect(lead[0]).toMatchObject({ event_id: LEAD_ID, action_source: "system_generated" });
    // Batch 77's stored matching rides along (fbc from the visit's fbclid).
    expect((lead[0]!["user_data"] as Row)["fbc"]).toBe("fb.1.1794466925583.IwAR0abcdefghij");
    await runVerifiedLeadEvents(w.supabase as never, { now: Date.now() + 4 * MIN });
    expect(events(w).filter((e) => e["event_name"] === "Lead")).toHaveLength(1);
    expect(readFileSync("src/routes/api/internal/knowledge-worker.ts", "utf8")).toContain(
      "verified_leads: verifiedLeads",
    );
  });

  it("CompleteRegistration / StartTrial are untouched; /demo still sends its Lead", () => {
    const relay = readFileSync("src/routes/api/public/meta-event.ts", "utf8");
    expect(relay).toContain('event === "CompleteRegistration"');
    expect(relay).toContain('event === "StartTrial"');
    const leads = readFileSync("src/routes/api/public/demo-leads.ts", "utf8");
    expect(leads).toContain('safeParams({ content_name: "demo", lead_source: "landing" })');
  });
});

/* --------------------------------------------------------------- phone --- */

describe("phone numbers typed with the +91 chip", () => {
  it("'91 70028 67193', '917002867193', '07002867193', '7002867193' are all +917002867193", () => {
    for (const typed of [
      "91 70028 67193",
      "917002867193",
      "07002867193",
      "7002867193",
      "+91 70028 67193",
    ]) {
      expect(indiaWhatsApp(typed), typed).toEqual({ phone: "+917002867193" });
      expect(checkRealNumber(typed), typed).toEqual({ ok: true, phone: "+917002867193" });
    }
  });

  it("+1 / +7 are never added; 5-digit, landline and non-mobile numbers are refused", () => {
    for (const typed of [
      "1917002867193", // was +1 917002867193
      "73078015438", // was +7 3078015438
      "12345",
      "04023456789", // a landline (040 Hyderabad)
      "4023456789",
      "5002867193",
      "+1 642 555 0123",
      "",
    ]) {
      expect(checkRealNumber(typed), typed).toEqual({ ok: false, error: INDIA_MOBILE_ERROR });
    }
    expect(INDIA_MOBILE_ERROR).toBe("Please enter your 10-digit WhatsApp number");
    // Batch 75's fake-number checks stay.
    for (const fake of ["9999999999", "9876543210", "6789012345"]) {
      expect(checkRealNumber(fake), fake).toEqual({ ok: false, error: REAL_NUMBER_ERROR });
    }
  });

  it("/signup: the same rule, and a honeypot", async () => {
    const { signupPhone } = await import("@/routes/signup");
    expect(signupPhone("91 70028 67193")).toEqual({ phone: "+917002867193" });
    expect(signupPhone("07002867193")).toEqual({ phone: "+917002867193" });
    expect(signupPhone("+1 642 555 0123")).toEqual({ error: INDIA_MOBILE_ERROR });
    expect(signupPhone("73078015438")).toEqual({ error: INDIA_MOBILE_ERROR });
    expect(signupPhone("9999999999")).toEqual({ error: REAL_NUMBER_ERROR });
    const signup = readFileSync("src/routes/signup.tsx", "utf8");
    expect(signup).toContain('name="company_website_confirm"');
    expect(signup).toMatch(/if \(String\(form\.get\("company_website_confirm"\)[^]*?return;\s*\}/);
    // Sign-up itself (email + password) is otherwise untouched.
    expect(signup).toContain("aidwar.auth.signUp({");
  });

  it("Settings numbers of an Indian workspace: a slip is refused, never a foreign number", async () => {
    const { typedPersonPhone } = await import("./phone");
    expect(typedPersonPhone("73078015438", "91")).toEqual({ error: INDIA_MOBILE_ERROR });
    expect(typedPersonPhone("7002867193", "91")).toEqual({
      phone: "+917002867193",
      addedCountry: true,
    });
    // Typed on purpose with "+": still allowed there.
    expect(typedPersonPhone("+44 7700 900123", "91")).toEqual({
      phone: "+447700900123",
      addedCountry: false,
    });
    // Another workspace's country: Batch 69's rule unchanged.
    expect(typedPersonPhone("7700900123", "44")).toEqual({
      phone: "+447700900123",
      addedCountry: true,
    });
  });
});

/* ----------------------------------------------- alert, reminder, admin --- */

describe("the alert, the reminder and Admin → Leads", () => {
  it("the alert's Source says '· verified' only once verified (same template)", async () => {
    const { alertVariables } = await import("./lead-alerts.server");
    const lead = {
      id: "l1",
      name: "Asha Rao",
      phone: PHONE,
      source: "landing_start",
      created_at: "",
      business_type: null,
      qualification: { sells: "jewellery", customers: "500_5000" },
    };
    expect(alertVariables(lead)["5"]).toBe("Website /start");
    expect(alertVariables({ ...lead, verified_at: "2026-11-13T10:00:00Z" })["5"]).toBe(
      "Website /start · verified",
    );
  });

  it("the reminder is unchanged (it doesn't look at verification)", () => {
    const src = readFileSync("src/lib/start-reminders.server.ts", "utf8");
    expect(src).not.toContain("verified_at");
  });

  it("Admin → Leads: Verified ✓ / Not verified badge, a filter, the business name column", async () => {
    const { LeadsTable } = await import("@/components/admin/lead-views");
    const { filterLeads } = await import("./leads");
    const base = {
      created_at: "2026-11-13T10:00:00Z",
      updated_at: "2026-11-13T10:00:00Z",
      source: "landing_start",
      status: "new",
      assigned_to: null,
      is_test: false,
      phone: PHONE,
      name: "Asha Rao",
      first_attribution: {},
      latest_attribution: {},
    };
    const rows = [
      { ...base, id: "a", business_name: "Asha Jewels", verified_at: "2026-11-13T10:01:00Z" },
      { ...base, id: "b", business_name: null, verified_at: null, phone: "+919123456780" },
    ] as never[];
    const html = renderToStaticMarkup(<LeadsTable leads={rows} onOpen={() => undefined} />);
    expect(html).toContain("Verified ✓");
    expect(html).toContain("Not verified");
    expect(html).toContain("Business name");
    expect(html).toContain("Asha Jewels");
    const pick = (verified: "all" | "yes" | "no") =>
      filterLeads(rows, { status: "all", search: "", unassignedOnly: false, verified }).map(
        (l: { id: string }) => l.id,
      );
    expect(pick("all")).toEqual(["a", "b"]);
    expect(pick("yes")).toEqual(["a"]);
    expect(pick("no")).toEqual(["b"]);
    expect(readFileSync("src/routes/admin/leads.tsx", "utf8")).toContain(
      'data-testid="filter-verified"',
    );
  });
});
