import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { memoryDb, type MemoryDb, type Row } from "./test-support/memory-db";

/**
 * Batch 75 — the /start qualification step (what they sell, how many
 * customers) and the /start spam guards. Fakes only: the in-memory database,
 * fetch (Graph) and a fake browser. Nothing reaches a live database, WhatsApp
 * or Meta.
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

import { StartQuestions } from "@/components/start/start-questions";
import { LeadsTable } from "@/components/admin/lead-views";
import { checkRealNumber, qualificationFor, REAL_NUMBER_ERROR } from "./start-qualify";
import { afterLeadSubmit, checkStartForm } from "./start-page";
import { filterLeads, leadAnswer, type LeadRow } from "./leads";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const PHONE = "+919812345670";
const LEAD_ID_FOR_PHONE = `Lead.${sha("919812345670")}`;
const QUALIFIED_ID = `LeadQualified.${sha("919812345670")}`;

beforeEach(() => {
  vi.stubEnv("AIDWAR_SUPABASE_SERVICE_ROLE_KEY", "test-only-service-key");
  vi.stubEnv("META_CAPI_TOKEN", "TEST-not-a-real-token");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function world(): MemoryDb & { graph: { url: string; body: Row }[] } {
  const graph: { url: string; body: Row }[] = [];
  const db = memoryDb({ demo_leads: [], activity_log: [], profiles: [] });
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
async function handler(path: string): Promise<Handler> {
  const mod = (await import(path)) as {
    Route: { options: { server: { handlers: Record<string, Handler> } } };
  };
  return mod.Route.options.server.handlers["POST"]!;
}
function post(url: string, body: Row, cookie?: string): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 test",
      "x-forwarded-for": "203.0.113.5",
      referer: "https://aidwar.in/start?utm_source=meta",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
const events = (w: { graph: { body: Row }[] }) =>
  w.graph.flatMap((g) => ((g.body["data"] as Row[] | undefined) ?? []) as Row[]);

async function submitStart(w: MemoryDb, body: Row = {}) {
  const res = await (
    await handler("@/routes/api/public/demo-leads")
  )({
    request: post("https://aidwar.in/api/public/demo-leads", {
      source: "landing_start",
      name: "Asha Rao",
      phone: "98123 45670",
      landing_path: "/start",
      company_website_confirm: "",
      ...body,
    }),
  });
  void w;
  return res;
}
async function qualify(body: Row, cookie?: string) {
  return (await handler("@/routes/api/public/start-qualify"))({
    request: post("https://aidwar.in/api/public/start-qualify", body, cookie),
  });
}

describe("the two questions after name + number", () => {
  it("the card asks them only once the lead is saved; a 400 shows the error; no answer goes on", () => {
    expect(afterLeadSubmit(200)).toBe("questions");
    expect(afterLeadSubmit(400)).toBe("error");
    expect(afterLeadSubmit(500)).toBe("signup");
    expect(afterLeadSubmit(429)).toBe("signup");
    expect(afterLeadSubmit(null)).toBe("signup");
    const form = readFileSync("src/components/start/start-lead-form.tsx", "utf8");
    // Same card for hero/final; the sticky bar opens a sheet; both end at /signup prefilled.
    expect(form).toContain("<StartQuestions onDone={(a) => void answer(a)} busy={saving} />");
    expect(form).toContain("{asked && bar ? <QuestionsSheet");
    expect(form).toContain("writeStartPrefill(person);");
    expect(form).toContain(
      'navigate({ to: "/signup", search: signupSearchFrom(window.location.search)',
    );
  });

  it("chips for both questions, one tap each; Continue waits for both; Skip is always there", () => {
    const html = renderToStaticMarkup(<StartQuestions onDone={() => undefined} />);
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
      "How many customers do you have?",
      "Under 500",
      "500–5,000",
      "5,000+",
      "Continue to sign up",
      "Skip",
    ]) {
      expect(text, label).toContain(label);
    }
    expect(html.match(/role="radiogroup"/g)).toHaveLength(2);
    expect(html.match(/role="radio"/g)).toHaveLength(10);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^]*?Continue to sign up/);
  });

  it("the answers are saved to that lead's qualification (+ business_type where it fits)", async () => {
    const w = world();
    const res = await submitStart(w);
    expect(res.status).toBe(200);
    const cookie = cookieOf(res);
    expect(cookie).toMatch(/^aidwar_start_lead=/);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    const out = await qualify({ sells: "jewellery", customers: "500_5000" }, cookie);
    expect(out.status).toBe(200);
    const lead = w.rows("demo_leads")[0]!;
    expect(lead["qualification"]).toMatchObject({ sells: "jewellery", customers: "500_5000" });
    expect(String((lead["qualification"] as Row)["answered_at"])).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(lead["business_type"]).toBe("retail");
    // Nothing else on the lead moved.
    expect(lead).toMatchObject({ phone: PHONE, name: "Asha Rao", source: "landing_start" });
  });

  it("business_type only when it fits; a second answer never overwrites the first", async () => {
    expect(qualificationFor("food_cafe", "under_500")).toMatchObject({
      ok: true,
      businessType: null,
    });
    expect(qualificationFor("clinic_salon", "under_500")).toMatchObject({
      businessType: "services",
    });
    expect(qualificationFor("education", "5000_plus")).toMatchObject({ businessType: "education" });
    expect(qualificationFor("cars", "under_500")).toEqual({ ok: false });
    const w = world();
    const cookie = cookieOf(await submitStart(w));
    await qualify({ sells: "food_cafe", customers: "under_500" }, cookie);
    expect(w.rows("demo_leads")[0]!["business_type"]).toBeNull();
    const again = await qualify({ sells: "fashion", customers: "5000_plus" }, cookie);
    expect(await again.json()).toMatchObject({ ok: true, saved: false });
    expect(w.rows("demo_leads")[0]!["qualification"]).toMatchObject({
      sells: "food_cafe",
      customers: "under_500",
    });
    // An answer that isn't on the list is refused.
    expect((await qualify({ sells: "x", customers: "under_500" }, cookie)).status).toBe(400);
  });

  it("Skip: nothing is asked of the server and the lead keeps an empty qualification", async () => {
    const w = world();
    await submitStart(w);
    const lead = w.rows("demo_leads")[0]!;
    expect(lead["qualification"] ?? {}).toEqual({});
    expect(leadAnswer(lead as unknown as LeadRow, "sells")).toBe("—");
    const form = readFileSync("src/components/start/start-lead-form.tsx", "utf8");
    // Skip (answers null) sends nothing and goes straight to /signup.
    expect(form).toMatch(
      /if \(answers\) \{[\s\S]*?\/api\/public\/start-qualify[\s\S]*?\}\s*await toSignup\(asked\);/,
    );
  });

  it("the sticky bar (number only) gets the same questions and saves the same way", async () => {
    const w = world();
    const res = await submitStart(w, { name: undefined, phone: "9812345670" });
    const out = await qualify({ sells: "online_store", customers: "5000_plus" }, cookieOf(res));
    expect(out.status).toBe(200);
    expect(w.rows("demo_leads")[0]).toMatchObject({
      name: null,
      business_type: "retail",
      qualification: { sells: "online_store", customers: "5000_plus" },
    });
  });
});

describe("only this browser's own lead", () => {
  it("no cookie, a forged or expired cookie, or another lead's id in the body is refused", async () => {
    const w = world();
    const mine = cookieOf(await submitStart(w));
    const other = (await submitStart(w, { phone: "91234 56780", name: "Ravi" })).headers;
    expect(other.get("set-cookie")).toBeTruthy();
    const otherLead = w.rows("demo_leads").find((r) => r["phone"] === "+919123456780")!;

    expect((await qualify({ sells: "fashion", customers: "under_500" })).status).toBe(403);
    // Forged: right shape, someone else's lead id, wrong signature.
    const forged = `aidwar_start_lead=${String(otherLead["id"])}.zzzzzz.${"A".repeat(32)}`;
    expect((await qualify({ sells: "fashion", customers: "under_500" }, forged)).status).toBe(403);
    // A body naming another lead changes nothing: the cookie decides.
    await qualify(
      { sells: "fashion", customers: "under_500", lead_id: otherLead["id"], id: otherLead["id"] },
      mine,
    );
    expect(
      w.rows("demo_leads").find((r) => r["id"] === otherLead["id"])!["qualification"] ?? {},
    ).toEqual({});
    // Expired after an hour.
    vi.useFakeTimers({ now: Date.now() + 61 * 60 * 1000, toFake: ["Date"] });
    expect((await qualify({ sells: "fashion", customers: "under_500" }, mine)).status).toBe(403);
  });

  it("a /demo lead can never be qualified through this step", async () => {
    const w = world();
    w.rows("demo_leads").push({
      id: "11111111-1111-4111-8111-111111111111",
      source: "landing",
      phone: "+919123456780",
      name: "Ravi",
      business_type: "services",
      qualification: {},
    });
    const { startLeadToken } = await import("./start-lead-cookie.server");
    const cookie = `aidwar_start_lead=${await startLeadToken("11111111-1111-4111-8111-111111111111")}`;
    expect((await qualify({ sells: "fashion", customers: "under_500" }, cookie)).status).toBe(404);
  });
});

describe("Meta: LeadQualified once, Lead unchanged", () => {
  it("LeadQualified goes once with sells/customers, hashed matching only; Lead is still Batch 72's", async () => {
    const w = world();
    const res = await submitStart(w);
    const body = (await res.json()) as Row;
    expect(body["meta"]).toEqual({
      event: "Lead",
      event_id: LEAD_ID_FOR_PHONE,
      params: { content_name: "start_free_trial", lead_source: "landing_start" },
    });
    const cookie = cookieOf(res);
    const out = (await (
      await qualify({ sells: "jewellery", customers: "under_500" }, cookie)
    ).json()) as Row;
    expect(out["meta"]).toEqual({
      event: "LeadQualified",
      event_id: QUALIFIED_ID,
      params: { sells: "jewellery", customers: "under_500" },
    });
    const sent = events(w);
    const lead = sent.filter((e) => e["event_name"] === "Lead");
    const qualified = sent.filter((e) => e["event_name"] === "LeadQualified");
    expect(lead).toHaveLength(1);
    expect(lead[0]).toMatchObject({ event_id: LEAD_ID_FOR_PHONE });
    expect(qualified).toHaveLength(1);
    expect(qualified[0]).toMatchObject({
      event_id: QUALIFIED_ID,
      action_source: "website",
      custom_data: { sells: "jewellery", customers: "under_500" },
    });
    const ud = qualified[0]!["user_data"] as Row;
    expect(ud["ph"]).toEqual([sha("919812345670")]);
    expect(JSON.stringify(qualified[0])).not.toMatch(/98123|Asha/);
    // Answering again sends nothing more.
    await qualify({ sells: "fashion", customers: "5000_plus" }, cookie);
    expect(events(w).filter((e) => e["event_name"] === "LeadQualified")).toHaveLength(1);
  });

  it("the browser fires LeadQualified as trackCustom, only after Accept", async () => {
    const meta = {
      event: "LeadQualified" as const,
      event_id: QUALIFIED_ID,
      params: { sells: "jewellery", customers: "under_500" },
    };
    const fake = (consent: "accepted" | "declined") => {
      const store = new Map<string, string>([["aidwar.meta_consent", `${consent}:${Date.now()}`]]);
      const calls: unknown[][] = [];
      const storage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      };
      vi.stubGlobal("window", {
        localStorage: storage,
        sessionStorage: storage,
        location: { pathname: "/start", search: "", href: "https://aidwar.in/start" },
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
      return calls;
    };
    let calls = fake("declined");
    vi.resetModules();
    let m = await import("./meta-pixel");
    expect(m.fireFromServer(meta)).toBe(false);
    expect(calls).toEqual([]);
    calls = fake("accepted");
    vi.resetModules();
    m = await import("./meta-pixel");
    expect(m.fireFromServer(meta)).toBe(true);
    expect(calls).toEqual([
      ["trackCustom", "LeadQualified", meta.params, { eventID: QUALIFIED_ID }],
    ]);
  });
});

describe("spam guards on /start", () => {
  it("honeypot: answered 'ok', nothing saved, nothing fired, no cookie", async () => {
    const w = world();
    const res = await submitStart(w, { company_website_confirm: "http://spam.example" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, duplicate: false, meta: null });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(w.rows("demo_leads")).toHaveLength(0);
    expect(events(w)).toHaveLength(0);
    // The field is in the form, hidden from people.
    const form = readFileSync("src/components/start/start-lead-form.tsx", "utf8");
    expect(form).toContain('name="company_website_confirm"');
    expect(form).toContain("tabIndex={-1}");
  });

  it("obviously fake numbers are refused with one friendly line; a real number passes", async () => {
    for (const fake of [
      "9999999999",
      "1234567890",
      "9876543210",
      "98765 43210",
      "+91 8765432109",
    ]) {
      expect(checkRealNumber(fake), fake).toEqual({ ok: false, error: REAL_NUMBER_ERROR });
    }
    expect(REAL_NUMBER_ERROR).toBe("Please enter your real WhatsApp number");
    // Too short / too long for India.
    expect(checkRealNumber("+91 98123 4567").ok).toBe(false);
    expect(checkRealNumber("+91 98123 456701").ok).toBe(false);
    // A leading 0 (0123456789, an STD landline) keeps Batch 66's how-to-write-it sentence.
    expect(checkRealNumber("0123456789")).toMatchObject({ ok: false });
    expect(checkRealNumber("98123 45670")).toEqual({ ok: true, phone: PHONE });
    expect(checkRealNumber("+1 415 555 0132")).toEqual({ ok: true, phone: "+14155550132" });
    // The form shows it inline; the server refuses it too.
    expect(checkStartForm({ phone: "9999999999" })).toEqual({
      ok: false,
      field: "phone",
      error: REAL_NUMBER_ERROR,
    });
    const w = world();
    const res = await submitStart(w, { phone: "1234567890" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: REAL_NUMBER_ERROR });
    expect(w.rows("demo_leads")).toHaveLength(0);
    expect(events(w)).toHaveLength(0);
  });

  it("the existing per-IP limit still holds for /start (5 an hour)", async () => {
    const w = world();
    for (let i = 0; i < 5; i++) {
      const res = await submitStart(w, { phone: `9812345${600 + i}` });
      expect(res.status, String(i)).toBe(200);
    }
    expect((await submitStart(w, { phone: "9812345699" })).status).toBe(429);
  });
});

describe("Admin → Leads: Sells and Customers", () => {
  const base = {
    created_at: "2026-11-12T10:05:00.000Z",
    updated_at: "2026-11-12T10:05:00.000Z",
    business_type: null,
    enquiry_band: null,
    primary_need: null,
    business_name: null,
    website: null,
    consent: true,
    consent_version: "start-2026-11-12",
    consent_at: "2026-11-12T10:05:00.000Z",
    landing_path: "/start",
    referrer_host: null,
    first_attribution: {},
    latest_attribution: {},
    source: "landing_start",
    status: "new" as const,
    assigned_to: null,
    demo_at: null,
    next_follow_up_at: null,
    demo_attended_at: null,
    organization_id: null,
    is_test: false,
  };
  const rows: LeadRow[] = [
    {
      ...base,
      id: "a",
      name: "Asha",
      phone: "+919812345670",
      qualification: {
        sells: "jewellery",
        customers: "500_5000",
        answered_at: "2026-11-12T10:06:00Z",
      },
    },
    { ...base, id: "b", name: "Ravi", phone: "+919123456780", qualification: {} },
    {
      ...base,
      id: "c",
      name: null,
      phone: "+919000012345",
      qualification: {
        sells: "food_cafe",
        customers: "under_500",
        answered_at: "2026-11-12T10:07:00Z",
      },
    },
  ];

  it("renders the two columns, '—' when skipped", () => {
    const html = renderToStaticMarkup(<LeadsTable leads={rows} onOpen={() => undefined} />);
    expect(html).toContain(">Sells<");
    expect(html).toContain(">Customers<");
    const cells = (id: string) =>
      [...html.matchAll(new RegExp(`data-testid="${id}">([^<]*)<`, "g"))].map((m) => m[1]);
    expect(cells("lead-sells")).toEqual(["Jewellery", "—", "Food &amp; café"]);
    expect(cells("lead-customers")).toEqual(["500–5,000", "—", "Under 500"]);
  });

  it("filters by either answer, or by 'skipped'", () => {
    const ids = (o: { sells?: string; customers?: string }) =>
      filterLeads(rows, { status: "all", search: "", unassignedOnly: false, ...o }).map(
        (l) => l.id,
      );
    expect(ids({})).toEqual(["a", "b", "c"]);
    expect(ids({ sells: "jewellery" })).toEqual(["a"]);
    expect(ids({ customers: "under_500" })).toEqual(["c"]);
    expect(ids({ sells: "none" })).toEqual(["b"]);
    expect(ids({ sells: "food_cafe", customers: "500_5000" })).toEqual([]);
    const page = readFileSync("src/routes/admin/leads.tsx", "utf8");
    expect(page).toContain('testId="filter-sells"');
    expect(page).toContain('testId="filter-customers"');
  });
});
