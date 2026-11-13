import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { memoryDb, type MemoryDb, type Row } from "./test-support/memory-db";

/**
 * Batch 75 additions — the "finish sign-up" WhatsApp reminder to /start leads
 * who didn't sign up, the resume link, linking a lead at sign-up, and "Talk
 * to Aiden on WhatsApp" as a new account's first action. Fakes only: the
 * in-memory database and a recording template sender. Nothing reaches a live
 * database, WhatsApp or Meta; no template is submitted.
 */

const h = vi.hoisted(() => ({
  db: null as null | { supabase: unknown },
  sends: [] as Array<{
    phone: string;
    variables: Record<string, string>;
    template: string;
    button: unknown;
  }>,
  sendError: null as null | string,
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.db!.supabase }));
vi.mock("@/lib/billing-notify.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./billing-notify.server")>()),
  resolvePlatformOrg: async () => "org-platform",
}));
vi.mock("@/lib/campaigns.server", () => ({
  loadSenderContext: async () => ({ fake: "sender" }),
  sendCampaignTemplate: async (
    _s: unknown,
    _org: string,
    _sender: unknown,
    recipient: { phone: string; variables: Record<string, string> },
    template: { name: string },
    ctx: { buttonParams?: Record<number, string> },
  ) => {
    h.sends.push({
      phone: recipient.phone,
      variables: recipient.variables,
      template: template.name,
      button: ctx.buttonParams?.[0],
    });
    return h.sendError
      ? { messageId: null, error: h.sendError }
      : { messageId: "wamid.1", error: null };
  },
}));

import { runStartReminders, REMIND_AFTER_MS } from "./start-reminders.server";
import { continueToken, readContinueToken, startLeadToken } from "./start-lead-cookie.server";
import { FINISH_SIGNUP_TEMPLATE_NAME, isPlatformNoticeTemplate } from "./platform-notice-templates";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60 * 1000;

beforeEach(() => {
  vi.stubEnv("AIDWAR_SUPABASE_SERVICE_ROLE_KEY", "test-only-service-key");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  h.sends = [];
  h.sendError = null;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function lead(id: string, over: Row = {}): Row {
  return {
    id,
    source: "landing_start",
    is_test: false,
    name: "Asha Rao",
    phone: "+919812345670",
    created_at: ago(31 * MIN),
    nudged_at: null,
    linked_user_id: null,
    organization_id: null,
    qualification: {},
    ...over,
  };
}

function world(
  opts: {
    leads?: Row[];
    template?: string | null;
    tier?: string | null;
    sentToday?: number;
    extra?: Record<string, Row[]>;
  } = {},
): MemoryDb {
  const messages: Row[] = Array.from({ length: opts.sentToday ?? 0 }, (_, i) => ({
    id: `m${i}`,
    organization_id: "org-platform",
    direction: "outbound",
    type: "template",
    created_at: ago(60 * MIN),
  }));
  const db = memoryDb({
    demo_leads: opts.leads ?? [lead("lead-1")],
    message_templates:
      opts.template === null
        ? []
        : [
            {
              organization_id: "org-platform",
              name: FINISH_SIGNUP_TEMPLATE_NAME,
              language: "en",
              status: opts.template ?? "APPROVED",
              components: [],
            },
          ],
    platform_settings: [{ id: 1, onboarding_whatsapp_account_id: "acct-aidwar" }],
    whatsapp_accounts: [
      { id: "acct-aidwar", messaging_tier: opts.tier === undefined ? "TIER_250" : opts.tier },
    ],
    contacts: [],
    profiles: [],
    messages,
    ...(opts.extra ?? {}),
  });
  h.db = { supabase: db.supabase };
  return db;
}

describe("the finish-sign-up reminder", () => {
  it("goes once, 30 minutes after the lead, from AiDwar's number with a resume link for that lead", async () => {
    const w = world({
      leads: [
        lead("lead-1"),
        lead("lead-young", { created_at: ago(10 * MIN), phone: "+919123456780" }),
      ],
    });
    const out = await runStartReminders(w.supabase as never, { now: NOW });
    expect(out).toEqual({ sent: 1, skipped: null });
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]).toMatchObject({
      phone: "+919812345670",
      variables: { "1": "Asha" },
      template: "aidwar_finish_signup",
    });
    // The button value is a token that resumes exactly lead-1.
    expect(await readContinueToken(String(h.sends[0]!.button), NOW)).toBe("lead-1");
    expect(w.rows("demo_leads").find((r) => r["id"] === "lead-1")!["nudged_at"]).toBe(
      new Date(NOW).toISOString(),
    );
    // The young lead waits; a second run never sends lead-1 again.
    expect(await runStartReminders(w.supabase as never, { now: NOW + MIN })).toEqual({
      sent: 0,
      skipped: null,
    });
    expect(h.sends).toHaveLength(1);
    expect(REMIND_AFTER_MS).toBe(30 * MIN);
  });

  it("never after sign-up: a linked lead, or a number that already has an account (then linked)", async () => {
    const w = world({
      leads: [
        lead("lead-linked", { linked_user_id: "user-9" }),
        lead("lead-account", { phone: "+919123456780" }),
      ],
      extra: { profiles: [{ id: "user-7", phone: "+919123456780" }] },
    });
    expect(await runStartReminders(w.supabase as never, { now: NOW })).toEqual({
      sent: 0,
      skipped: null,
    });
    expect(h.sends).toHaveLength(0);
    expect(w.rows("demo_leads").find((r) => r["id"] === "lead-account")).toMatchObject({
      linked_user_id: "user-7",
      nudged_at: null,
    });
  });

  it("never to an opted-out number", async () => {
    const w = world({
      extra: {
        contacts: [
          {
            id: "c1",
            organization_id: "org-platform",
            phone: "+919812345670",
            opt_in_status: "opted_out",
          },
        ],
      },
    });
    await runStartReminders(w.supabase as never, { now: NOW });
    expect(h.sends).toHaveLength(0);
    expect(w.rows("demo_leads")[0]!["nudged_at"]).toBeNull();
  });

  it("skipped (logged) while the template is missing or not approved, then sent once it is", async () => {
    let w = world({ template: null });
    expect(await runStartReminders(w.supabase as never, { now: NOW })).toEqual({
      sent: 0,
      skipped: "template_missing",
    });
    w = world({ template: "PENDING" });
    expect(await runStartReminders(w.supabase as never, { now: NOW })).toEqual({
      sent: 0,
      skipped: "template_pending",
    });
    expect(w.rows("demo_leads")[0]!["nudged_at"]).toBeNull();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('"reason":"template_pending"'),
    );
    // Approved on the next tick: the same lead goes.
    (w.rows("message_templates")[0] as Row)["status"] = "APPROVED";
    expect(await runStartReminders(w.supabase as never, { now: NOW + MIN })).toEqual({
      sent: 1,
      skipped: null,
    });
  });

  it("stops for the day at the number's daily business-initiated limit (TIER_250)", async () => {
    let w = world({ sentToday: 250 });
    expect(await runStartReminders(w.supabase as never, { now: NOW })).toEqual({
      sent: 0,
      skipped: "daily_limit",
    });
    expect(h.sends).toHaveLength(0);
    // 249 used: one more goes, then the rest wait for tomorrow.
    w = world({
      sentToday: 249,
      leads: [
        lead("a"),
        lead("b", { phone: "+919123456780" }),
        lead("c", { phone: "+919000012345" }),
      ],
    });
    expect(await runStartReminders(w.supabase as never, { now: NOW })).toEqual({
      sent: 1,
      skipped: "daily_limit",
    });
    expect(w.rows("demo_leads").filter((r) => r["nudged_at"])).toHaveLength(1);
    // No tier known yet: the smallest limit (250) applies.
    w = world({ sentToday: 250, tier: null });
    expect((await runStartReminders(w.supabase as never, { now: NOW })).skipped).toBe(
      "daily_limit",
    );
  });

  it("a refused send leaves the lead to be tried again; old leads (over a day) are never reminded", async () => {
    h.sendError = "(#131026) Message undeliverable";
    let w = world();
    expect(await runStartReminders(w.supabase as never, { now: NOW })).toEqual({
      sent: 0,
      skipped: null,
    });
    expect(w.rows("demo_leads")[0]!["nudged_at"]).toBeNull();
    h.sendError = null;
    w = world({ leads: [lead("old", { created_at: ago(25 * 60 * MIN) })] });
    expect(await runStartReminders(w.supabase as never, { now: NOW })).toEqual({
      sent: 0,
      skipped: null,
    });
  });

  it("runs from the existing minute worker; the template is hidden from campaigns", () => {
    const worker = readFileSync("src/routes/api/internal/knowledge-worker.ts", "utf8");
    expect(worker).toContain('await import("@/lib/start-reminders.server")');
    expect(worker).toContain("start_reminders: startReminders");
    expect(isPlatformNoticeTemplate("aidwar_finish_signup")).toBe(true);
  });
});

type Handler = (a: { request: Request }) => Promise<Response>;
async function handler(path: string): Promise<Handler> {
  const mod = (await import(path)) as {
    Route: { options: { server: { handlers: Record<string, Handler> } } };
  };
  return mod.Route.options.server.handlers["POST"]!;
}
const post = (url: string, body: Row, cookie?: string) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

describe("the resume link (/start/continue?t=…)", () => {
  it("resumes the right lead only — name, number and saved answers back, and that lead's cookie", async () => {
    const w = world({
      leads: [
        lead("lead-a", {
          qualification: { sells: "jewellery", customers: "500_5000", answered_at: "x" },
        }),
        lead("lead-b", { name: "Ravi", phone: "+919123456780" }),
      ],
    });
    const res = await (
      await handler("@/routes/api/public/start-continue")
    )({
      request: post("https://aidwar.in/api/public/start-continue", {
        t: await continueToken("lead-a"),
      }),
    });
    expect(res.status).toBe(200);
    // Batch 78: + the business name and whether the number is verified (the
    // same link is in the "✅ Verified" reply); no Meta event for an unverified lead.
    expect(await res.json()).toEqual({
      ok: true,
      signed_up: false,
      name: "Asha Rao",
      phone: "+919812345670",
      business_name: "",
      verified: false,
      sells: "jewellery",
      customers: "500_5000",
      meta: null,
    });
    // The cookie it sets answers for lead-a and nobody else.
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const q = await (
      await handler("@/routes/api/public/start-qualify")
    )({
      request: post(
        "https://aidwar.in/api/public/start-qualify",
        { sells: "fashion", customers: "under_500" },
        cookie,
      ),
    });
    expect(q.status).toBe(200);
    expect(w.rows("demo_leads").find((r) => r["id"] === "lead-b")!["qualification"]).toEqual({});
  });

  it("a tampered, expired or wrong-kind token resumes nothing", async () => {
    world({ leads: [lead("lead-a")] });
    const call = async (t: string) =>
      (await handler("@/routes/api/public/start-continue"))({
        request: post("https://aidwar.in/api/public/start-continue", { t }),
      });
    const good = await continueToken("lead-a");
    const [id, exp] = good.split(".");
    expect((await call(`${id}.${exp}.${"A".repeat(32)}`)).status).toBe(410);
    expect((await call(good.replace("lead-a", "lead-b"))).status).toBe(410);
    // The /start cookie's token is signed differently: it can't stand in for a link.
    expect((await call(await startLeadToken("lead-a"))).status).toBe(410);
    // 48 hours later it has expired.
    expect(await readContinueToken(good, Date.now() + 49 * 60 * MIN)).toBeNull();
    expect(await readContinueToken(good, Date.now() + 47 * 60 * MIN)).toBe("lead-a");
  });

  it("a lead that already signed up is sent to log in, and gets no cookie", async () => {
    world({ leads: [lead("lead-a", { linked_user_id: "user-1" })] });
    const res = await (
      await handler("@/routes/api/public/start-continue")
    )({
      request: post("https://aidwar.in/api/public/start-continue", {
        t: await continueToken("lead-a"),
      }),
    });
    expect(await res.json()).toEqual({ ok: true, signed_up: true });
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("sign-up links the /start lead (so the reminder never goes)", () => {
  function withUser(w: MemoryDb, user: Row | null) {
    Object.assign(w.supabase as object, {
      auth: { admin: { getUserById: async () => ({ data: { user } }) } },
    });
  }
  const USER = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";

  it("links when the new account (under 15 min) signed up with the lead's number", async () => {
    const w = world({ leads: [lead("lead-a")] });
    withUser(w, {
      id: USER,
      created_at: new Date(Date.now() - MIN).toISOString(),
      user_metadata: { phone: "+919812345670" },
    });
    const cookie = `aidwar_start_lead=${await startLeadToken("lead-a")}`;
    const res = await (
      await handler("@/routes/api/public/start-link")
    )({
      request: post("https://aidwar.in/api/public/start-link", { user_id: USER }, cookie),
    });
    expect(await res.json()).toEqual({ linked: true });
    expect(w.rows("demo_leads")[0]!["linked_user_id"]).toBe(USER);
    // Then the reminder skips it.
    await runStartReminders(w.supabase as never, { now: Date.now() + 31 * MIN });
    expect(h.sends).toHaveLength(0);
  });

  it("no cookie, another number, or an old account links nothing", async () => {
    const w = world({ leads: [lead("lead-a")] });
    const cookie = `aidwar_start_lead=${await startLeadToken("lead-a")}`;
    const call = async (c?: string) => {
      const res = await (
        await handler("@/routes/api/public/start-link")
      )({
        request: post("https://aidwar.in/api/public/start-link", { user_id: USER }, c),
      });
      return (await res.json()) as Row;
    };
    withUser(w, {
      id: USER,
      created_at: new Date().toISOString(),
      user_metadata: { phone: "+919812345670" },
    });
    expect(await call()).toEqual({ linked: false });
    withUser(w, {
      id: USER,
      created_at: new Date().toISOString(),
      user_metadata: { phone: "+919123456780" },
    });
    expect(await call(cookie)).toEqual({ linked: false });
    withUser(w, {
      id: USER,
      created_at: new Date(Date.now() - 20 * MIN).toISOString(),
      user_metadata: { phone: "+919812345670" },
    });
    expect(await call(cookie)).toEqual({ linked: false });
    expect(w.rows("demo_leads")[0]!["linked_user_id"]).toBeNull();
    // /signup calls it right after a successful sign-up from /start, never blocking it.
    const signup = readFileSync("src/routes/signup.tsx", "utf8");
    expect(signup).toContain("if (data.user?.id && prefill.phone) linkStartLead(data.user.id);");
  });
});

describe("after sign-up: Talk to Aiden on WhatsApp first", () => {
  it("a big green button with the wa.me link (code prefilled), on every journey step but Aiden's own", async () => {
    const { TalkToAidenCard } = await import("@/components/onboarding/talk-to-aiden");
    const link = "https://wa.me/919121881110?text=Hi%20Aiden%2C%20my%20code%20is%20AD-7K2P9Q";
    const html = renderToStaticMarkup(<TalkToAidenCard code="AD-7K2P9Q" waLink={link} />);
    expect(html).toContain(`href="${link.replace(/&/g, "&amp;")}"`);
    expect(html).toContain("Talk to Aiden on WhatsApp →");
    expect(html).toMatch(/bg-success[^"]*min-h-14|min-h-14[^"]*bg-success/);
    expect(html).toContain("AD-7K2P9Q");
    const journey = readFileSync("src/components/onboarding/onboarding-journey.tsx", "utf8");
    expect(journey).toContain('{organizationId && current !== "aiden" ? (');
    expect(journey).toContain("<TalkToAidenBanner organizationId={organizationId} />");
    // The dashboard card and the Aiden step share the same primary button.
    const handoff = readFileSync("src/components/aiden-handoff.tsx", "utf8");
    expect(handoff).toContain("Talk to Aiden on WhatsApp →");
    expect(handoff).not.toContain("Say hello to Aiden");
    // The AD-code flow itself is untouched: the same endpoint, link and code.
    const banner = readFileSync("src/components/onboarding/talk-to-aiden.tsx", "utf8");
    expect(banner.replace(/\s+/g, " ")).toContain(
      'callApi<{ code?: string; wa_link?: string; show_setup?: boolean }>( "/api/onboarding/start", { body: { organization_id: organizationId, mode: "card" }',
    );
  });

  it("Admin → Leads shows 'Reminded ✓' once the reminder went", async () => {
    const { LeadsTable } = await import("@/components/admin/lead-views");
    const row = {
      id: "a",
      created_at: "2026-11-12T10:00:00Z",
      updated_at: "2026-11-12T10:00:00Z",
      business_type: null,
      enquiry_band: null,
      primary_need: null,
      name: "Asha",
      business_name: null,
      phone: "+919812345670",
      website: null,
      consent: true,
      consent_version: "start-2026-11-12",
      consent_at: "2026-11-12T10:00:00Z",
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
    const html = renderToStaticMarkup(
      <LeadsTable
        leads={[
          { ...row, nudged_at: "2026-11-12T10:31:00Z" },
          { ...row, id: "b", nudged_at: null },
        ]}
        onOpen={() => undefined}
      />,
    );
    expect(html.match(/Reminded ✓/g)).toHaveLength(1);
  });
});
