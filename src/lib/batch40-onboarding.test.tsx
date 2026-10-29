import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { fakeDb, type FakeOp } from "./test-support/fake-db";

/**
 * Batch 40 — onboarding that converts. No live database, WhatsApp or Meta:
 * every write goes to a fake, every send to a recorder.
 */

const h = vi.hoisted(() => ({
  sent: [] as Array<{
    body: string;
    buttons?: unknown;
    metadata?: Record<string, unknown> | undefined;
  }>,
  templates: [] as Array<{
    name: string;
    variables: Record<string, string>;
    buttonParams?: Record<number, string>;
  }>,
  answer: {
    status: "ok",
    output: "Our cotton kurta is ₹1,200.",
    sources: [{ id: "doc" }],
    runId: "run-1",
    needsOwner: false,
  } as Record<string, unknown>,
  added: [] as string[],
}));

vi.mock("@/lib/scripts.server", () => ({ getScript: async (_s: unknown, key: string) => key }));
vi.mock("@/lib/onboarding-cards.server", () => ({ renderCard: async () => null }));
vi.mock("@/lib/owner-replies.server", () => ({
  onboardingChannelFor: async () => null,
  ownerOrganizationIds: async () => [],
  memberOrganizationIds: async () => [],
  orgNames: async () => new Map(),
  prefixFor: () => "",
  withPrefix: (_p: string, t: string) => t,
  recordOnboardingGap: async () => {},
  handleOwnerAnswer: async () => false,
  handleOwnerPick: async () => false,
  openPendingReplies: async () => [],
  ownerToldOfWaitingCustomer: async () => false,
}));
vi.mock("@/lib/service-text.server", () => {
  const send = async (
    _s: unknown,
    a: { body?: string; caption?: string; buttons?: unknown; metadata?: Record<string, unknown> },
  ) => {
    h.sent.push({ body: a.body ?? a.caption ?? "", buttons: a.buttons, metadata: a.metadata });
    return { ok: true, messageId: "m", error: null };
  };
  return {
    sendServiceText: send,
    sendServiceImage: send,
    sendServiceButtons: send,
    sendServiceList: send,
  };
});
vi.mock("@/lib/ai-tasks.server", () => ({
  merchantAnswer: async () => h.answer,
  playgroundAnswer: async () => h.answer,
  classifyBusinessFact: async () => ({ isFact: false }),
}));
vi.mock("@/lib/campaigns.server", () => ({
  loadSenderContext: async () => ({ id: "sender" }),
  sendCampaignTemplate: async (
    _s: unknown,
    _org: string,
    _sender: unknown,
    recipient: { variables: Record<string, string> },
    template: { name: string },
    context: { buttonParams?: Record<number, string> },
  ) => {
    h.templates.push({
      name: template.name,
      variables: recipient.variables,
      ...(context.buttonParams ? { buttonParams: context.buttonParams } : {}),
    });
    return { messageId: "wamid", error: null };
  },
}));
vi.mock("@/lib/billing-notify.server", () => ({ resolvePlatformOrg: async () => "org-platform" }));
vi.mock("@/lib/knowledge.server", () => ({
  TRIAL_LINK_LIMIT_REPLY: "limit",
  listingLabel: () => null,
  addWebsiteSource: async (_s: unknown, _org: string, url: string) => {
    h.added.push(url);
    return { ok: true, sourceId: "src-1", itemCount: 0, queued: true };
  },
  saveFact: async () => ({ ok: true }),
}));
vi.mock("@/lib/whatsapp-api.server", () => ({ logServerActivity: async () => {} }));
vi.mock("@/lib/ai-agent.server", () => ({ syncAiSwitch: async () => {} }));
vi.mock("@/lib/whatsapp-numbers.server", () => ({
  getWhatsAppConnection: async () => ({ connection: null }),
}));

import { classifyEmbeddedSignup, ES_OUTCOME_KINDS, type EsSignal } from "./embedded-signup-outcome";
import { Recovery } from "@/components/onboarding/step-connect";
import { waitForSessionInfo } from "@/components/whatsapp-embedded-signup";
import {
  journeyLink,
  landingStep,
  parseStep,
  resumeStep,
  summariseFunnel,
  type JourneyFacts,
} from "./onboarding-journey";
import { loadJourneyState, recordFunnelStep } from "./onboarding-journey.server";
import {
  journeyBegin,
  journeyGoLive,
  journeyMark,
  journeyTest,
  type JourneyAuth,
} from "./onboarding-journey-api.server";
import {
  runOnboardingNudges,
  RESUME_LINK_TEMPLATE_NAME,
  CODE_TEMPLATE_NAME,
  EXPIRE_AFTER_MS,
} from "./onboarding-nudges.server";
import {
  CONNECT_LINK,
  handleMerchantInbound,
  handleNumberConnected,
} from "./merchant-channel.server";
import { loginSearch } from "@/routes/app/route";
import { nameFromHost, normaliseSiteInput, parseSiteBrand, safeColor } from "./site-peek";

beforeEach(() => {
  h.sent.length = 0;
  h.templates.length = 0;
  h.added.length = 0;
  h.answer = {
    status: "ok",
    output: "Our cotton kurta is ₹1,200.",
    sources: [{ id: "doc" }],
    runId: "run-1",
    needsOwner: false,
  };
});

const filterValue = (op: FakeOp, name: string, column: string): unknown =>
  op.filters.find(([n, a]) => n === name && a[0] === column)?.[1][1];

/** A small stateful world: analytics_events and onboarding_sessions remember writes. */
function world(init: {
  events?: string[];
  session?: Record<string, unknown> | null;
  accounts?: Array<Record<string, unknown>>;
  mode?: string;
  sources?: Array<Record<string, unknown>>;
  tests?: number;
  linkTemplate?: "APPROVED" | "PENDING" | null;
  codeTemplate?: "APPROVED" | null;
  ledger?: boolean;
}) {
  const events = new Set(init.events ?? []);
  const inserted: string[] = [];
  let session = init.session ? { ...init.session } : null;
  let mode = init.mode ?? "off";
  const db = fakeDb((op) => {
    if (op.table === "analytics_events") {
      if (op.kind === "insert") {
        const type = (op.payload as { event_type: string }).event_type;
        inserted.push(type);
        events.add(type);
        return { data: null, error: null };
      }
      const eq = filterValue(op, "eq", "event_type") as string | undefined;
      if (eq) return { data: events.has(eq) ? { id: "ev" } : null, error: null };
      const inList = op.filters.find(([n, a]) => n === "in" && a[0] === "event_type")?.[1][1] as
        string[] | undefined;
      return {
        data: (inList ?? []).filter((t) => events.has(t)).map((t) => ({ event_type: t })),
        error: null,
      };
    }
    if (op.table === "onboarding_sessions") {
      const single = op.filters.some(([n]) => n === "maybeSingle");
      const status = filterValue(op, "eq", "status");
      const statusIn = op.filters.find(([n, a]) => n === "in" && a[0] === "status")?.[1][1] as
        string[] | undefined;
      // Time filters (lt/gt on dates) only on the expiry sweeps: a live test session never matches them.
      const sweep =
        op.kind === "update" &&
        op.filters.some(
          ([n, a]) => n === "lt" && (a[0] === "expires_at" || a[0] === "last_inbound_at"),
        );
      const matches =
        Boolean(session) &&
        !sweep &&
        (!status || session!["status"] === status) &&
        (!statusIn || statusIn.includes(String(session!["status"])));
      if (op.kind === "update") {
        if (matches) session = { ...session!, ...(op.payload as object) };
        const rows = matches ? [{ id: session!["id"] }] : [];
        return { data: single ? (rows[0] ?? null) : rows, error: null };
      }
      return { data: single ? (matches ? session : null) : matches ? [session] : [], error: null };
    }
    if (op.table === "whatsapp_accounts") return { data: init.accounts ?? [], error: null };
    if (op.table === "ai_agents") {
      if (op.kind === "update") {
        mode = (op.payload as { mode: string }).mode;
        return { data: null, error: null };
      }
      return { data: { id: "agent-1", mode }, error: null };
    }
    if (op.table === "ai_runs") {
      if (op.select?.[1]) return { data: null, error: null, count: 0 };
      return {
        data: Array.from({ length: init.tests ?? 0 }, (_, i) => ({ id: `r${i}` })),
        error: null,
      };
    }
    if (op.table === "knowledge_sources") return { data: init.sources ?? [], error: null };
    if (op.table === "organizations")
      return { data: { name: "Asha Studio", branding: {} }, error: null };
    if (op.table === "profiles")
      return { data: { phone: "+919800000001", full_name: "Asha" }, error: null };
    if (op.table === "message_templates") {
      const name = filterValue(op, "eq", "name");
      const status =
        name === RESUME_LINK_TEMPLATE_NAME
          ? init.linkTemplate
          : name === CODE_TEMPLATE_NAME
            ? init.codeTemplate
            : null;
      return {
        data: status ? { name, language: "en_US", components: [], status } : null,
        error: null,
      };
    }
    if (op.table === "platform_settings")
      return { data: { onboarding_whatsapp_account_id: "acc-onb" }, error: null };
    if (op.table === "contacts")
      return { data: { id: "contact-1", name: "Asha Rao" }, error: null };
    if (op.table === "wallet_ledger")
      return {
        data: init.ledger ? { id: "ledger-12345", created_at: new Date().toISOString() } : null,
        error: null,
      };
    return undefined;
  });
  return {
    ...db,
    inserted,
    events,
    get session() {
      return session;
    },
    get mode() {
      return mode;
    },
  };
}

const auth = (db: ReturnType<typeof world>): JourneyAuth => ({
  supabase: db.supabase,
  organizationId: "org-1",
  userId: "user-1",
  role: "owner",
  canConfigure: true,
});

// ------------------------------------------------------------------ (1)
describe("every Embedded Signup outcome shows its recovery path", () => {
  const cases: Array<[EsSignal, string]> = [
    [{ event: "CANCEL", currentStep: "WABA_SETUP" }, "cancelled"],
    [{}, "cancelled"],
    [{ sdkFailed: true }, "popup_blocked"],
    [
      { event: "ERROR", message: "This phone number is already registered with WhatsApp." },
      "number_on_app",
    ],
    [
      { message: "We couldn't finish the sign-up with Meta: Business verification is required" },
      "business_verification",
    ],
    [{ message: "(#200) Permissions error", code: 200 }, "permission_missing"],
    [
      { message: "This number is already connected to another AiDwar workspace.", httpStatus: 409 },
      "number_elsewhere",
    ],
    [
      { message: "We couldn't reach Meta to finish the sign-up.", httpStatus: 502 },
      "meta_unreachable",
    ],
    [
      {
        message: "WhatsApp sign-up isn't configured yet. Please contact support.",
        httpStatus: 500,
      },
      "not_configured",
    ],
    [{ event: "ERROR", message: "Something odd" }, "unknown"],
  ];

  it.each(cases)("%j → %s", (signal, kind) => {
    const outcome = classifyEmbeddedSignup(signal);
    expect(outcome.kind).toBe(kind);
    expect(outcome.title.length).toBeGreaterThan(10);
    expect(outcome.body.length).toBeGreaterThan(10);
    expect(outcome.steps.length).toBeGreaterThan(0);
  });

  it("every kind is reachable and renders its title and every step as an alert", () => {
    const seen = new Set(cases.map(([signal]) => classifyEmbeddedSignup(signal).kind));
    expect([...seen].sort()).toEqual([...ES_OUTCOME_KINDS].sort());
    for (const [signal] of cases) {
      const outcome = classifyEmbeddedSignup(signal);
      const html = renderToStaticMarkup(<Recovery outcome={outcome} />);
      expect(html).toContain('role="alert"');
      expect(html).toContain(`data-outcome="${outcome.kind}"`);
      for (const step of outcome.steps)
        expect(html).toContain(
          step
            .replace(/'/g, "&#x27;")
            .replace(/&/g, "&amp;")
            .replace(/&amp;#x27;/g, "&#x27;"),
        );
    }
  });

  it("closing it on the phone-number screen points at the number, the usual blocker", () => {
    const outcome = classifyEmbeddedSignup({ event: "CANCEL", currentStep: "PHONE_NUMBER_SETUP" });
    expect(outcome.kind).toBe("cancelled");
    expect(outcome.body).toMatch(/isn't on the WhatsApp app/);
  });

  it("the account ids arriving after the code no longer fail the connect (the race)", async () => {
    const info: { waba_id?: string; phone_number_id?: string } = {};
    setTimeout(() => Object.assign(info, { waba_id: "111111", phone_number_id: "222222" }), 30);
    await expect(waitForSessionInfo(() => info, 1000, 5)).resolves.toEqual({
      waba_id: "111111",
      phone_number_id: "222222",
    });
    await expect(waitForSessionInfo(() => ({}), 40, 5)).resolves.toEqual({});
  });
});

// ------------------------------------------------------------------ (2)
describe("resume after reload lands on the same step", () => {
  const facts = (over: Partial<JourneyFacts> = {}): JourneyFacts => ({
    hasOrg: true,
    hasMaterial: true,
    connected: false,
    connectSkipped: false,
    tested: false,
    wentLive: false,
    ...over,
  });

  it("no step asked: the first unfinished one", () => {
    expect(resumeStep(facts({ hasMaterial: false }))).toBe("business");
    expect(resumeStep(facts())).toBe("connect");
    expect(resumeStep(facts({ connectSkipped: true }))).toBe("aiden");
    expect(resumeStep(facts({ connected: true, tested: true }))).toBe("live");
    expect(resumeStep(facts({ connected: true, tested: true, wentLive: true }))).toBe("done");
    // Went live in Draft without testing or connecting: finished, never sent back.
    expect(resumeStep(facts({ wentLive: true }))).toBe("done");
  });

  it("the step in the URL is where a reload lands — going back included, skipping ahead never", () => {
    const atAiden = facts({ connected: true });
    expect(landingStep(atAiden, "aiden")).toBe("aiden");
    expect(landingStep(atAiden, "business")).toBe("business");
    expect(landingStep(atAiden, "connect")).toBe("connect");
    expect(landingStep(atAiden, "live")).toBe("aiden");
    expect(landingStep(facts({ connected: true, tested: true, wentLive: true }), null)).toBe(
      "live",
    );
    expect(parseStep("connect")).toBe("connect");
    expect(parseStep("nope")).toBeNull();
  });

  it("the step comes from facts in the database, not from the browser", async () => {
    const db = world({
      events: ["onboarding.started"],
      sources: [
        {
          id: "src-1",
          type: "website",
          name: "asha.in",
          status: "ready",
          item_count: 9,
          config: { url: "https://asha.in/" },
        },
      ],
      accounts: [
        { display_phone_number: "+91 98000 00002", verified_name: "Asha Studio", status: "active" },
      ],
    });
    const state = await loadJourneyState(db.supabase, "org-1");
    expect(state.step).toBe("aiden");
    expect(state.active).toBe(true);
    expect(state.website?.host).toBe("asha.in");
    expect(state.number?.display).toBe("+91 98000 00002");
  });

  it("a workspace from before Batch 40 is never sent into the journey", async () => {
    const db = world({
      mode: "replying",
      accounts: [{ display_phone_number: "1", status: "active" }],
    });
    const state = await loadJourneyState(db.supabase, "org-1");
    expect(state.active).toBe(false);
  });

  it("the login wall keeps where the owner was going", () => {
    expect(loginSearch("/app/start?step=connect")).toEqual({ redirect: "/app/start?step=connect" });
    expect(loginSearch("/app/settings")).toEqual({ redirect: "/app/settings" });
    expect(loginSearch("/app")).toEqual({});
  });
});

// ------------------------------------------------------------------ (3)
describe("the nudge deep-links to the right step", () => {
  const old = new Date(Date.now() - 2 * 86_400_000).toISOString();

  it("a web sign-up stopped at Connect gets the link button to ?step=connect", async () => {
    const db = world({
      events: ["onboarding.started"],
      sources: [
        {
          id: "src-1",
          type: "website",
          name: "asha.in",
          status: "ready",
          item_count: 3,
          config: {},
        },
      ],
      session: {
        id: "s1",
        organization_id: "org-1",
        phone: "+919800000001",
        code: "AD-ABCD23",
        status: "pending",
        nudges_sent: 0,
        created_at: old,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
      linkTemplate: "APPROVED",
      codeTemplate: "APPROVED",
    });
    await runOnboardingNudges(db.supabase);
    const link = h.templates.find((t) => t.name === RESUME_LINK_TEMPLATE_NAME);
    expect(link?.buttonParams).toEqual({ 0: "connect" });
    expect(link?.variables["3"]).toMatch(/connecting your WhatsApp/);
    expect(h.templates.some((t) => t.name === CODE_TEMPLATE_NAME)).toBe(false);
    expect(journeyLink("connect")).toBe("https://aidwar.in/app/start?step=connect");
  });

  it("until Meta approves the link template, the old code nudge goes out exactly as before", async () => {
    const db = world({
      events: ["onboarding.started"],
      sources: [
        {
          id: "src-1",
          type: "website",
          name: "asha.in",
          status: "ready",
          item_count: 3,
          config: {},
        },
      ],
      session: {
        id: "s1",
        organization_id: "org-1",
        phone: "+919800000001",
        code: "AD-ABCD23",
        status: "pending",
        nudges_sent: 0,
        created_at: old,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
      linkTemplate: "PENDING",
      codeTemplate: "APPROVED",
    });
    await runOnboardingNudges(db.supabase);
    expect(h.templates.map((t) => t.name)).toEqual([CODE_TEMPLATE_NAME]);
    expect(h.templates[0]!.variables["3"]).toBe("AD-ABCD23");
  });

  it("the chat's Connect reply opens the journey's connect step, and a quiet month (not a week) ends a session", () => {
    expect(CONNECT_LINK).toBe("https://aidwar.in/app/start?step=connect");
    expect(EXPIRE_AFTER_MS).toBe(30 * 86_400_000);
  });
});

// ------------------------------------------------------------------ (4)
describe("funnel events fire once per step", () => {
  it("a step already recorded is never written again", async () => {
    const db = world({});
    expect(await recordFunnelStep(db.supabase, { organizationId: "org-1", step: "started" })).toBe(
      true,
    );
    expect(await recordFunnelStep(db.supabase, { organizationId: "org-1", step: "started" })).toBe(
      false,
    );
    expect(db.inserted).toEqual(["onboarding.started"]);
  });

  it("each journey action records its own step once, however often it runs", async () => {
    const db = world({});
    await journeyBegin(auth(db), { url: "asha.in" });
    await journeyBegin(auth(db), { url: "asha.in" });
    await journeyMark(auth(db), { step: "connect_opened" });
    await journeyMark(auth(db), { step: "connect_opened" });
    await journeyTest(auth(db), { question: "How much is the kurta?" });
    await journeyTest(auth(db), { question: "Do you have it in blue?" });
    expect(db.inserted).toEqual([
      "onboarding.started",
      "onboarding.connect_opened",
      "onboarding.aiden_tested",
    ]);
    expect(h.added).toEqual(["https://asha.in/", "https://asha.in/"]);
  });

  it("a test Aiden couldn't answer records nothing, and the browser can't record a server step", async () => {
    h.answer = { status: "ok", output: "", sources: [], runId: "r" };
    const db = world({});
    const reply = await journeyTest(auth(db), { question: "?" });
    expect(reply.body["answered"]).toBe(false);
    expect((await journeyMark(auth(db), { step: "went_live" })).status).toBe(400);
    expect(db.inserted).toEqual([]);
  });

  it("the admin summary counts workspaces step by step and where each stopped", () => {
    const summary = summariseFunnel([
      { organizationId: "a", startedAt: "", steps: ["started", "website_read", "connect_opened"] },
      {
        organizationId: "b",
        startedAt: "",
        steps: [
          "started",
          "website_read",
          "connect_opened",
          "connected",
          "aiden_tested",
          "went_live",
        ],
      },
      { organizationId: "c", startedAt: "", steps: ["started"] },
    ]);
    expect(summary.total).toBe(3);
    expect(summary.steps.map((s) => s.reached)).toEqual([3, 2, 2, 1, 1, 1]);
    expect(summary.steps[3]!.fromPrevious).toBe(50);
    expect(Object.fromEntries(summary.stoppedAt.map((s) => [s.step, s.count]))).toMatchObject({
      started: 1,
      connect_opened: 1,
      went_live: 1,
    });
  });
});

// ------------------------------------------------------------------ (5)
describe("a sign-up that connects ends with an active WhatsApp account and Aiden's mode chosen", () => {
  it("connect (from any status) is recorded, then Go live sets the mode and finishes the setup", async () => {
    const db = world({
      events: ["onboarding.started"],
      session: {
        id: "s1",
        organization_id: "org-1",
        user_id: "user-1",
        phone: "+919800000001",
        wa_id: null,
        code: "AD-ABCD23",
        status: "pending",
        step: null,
        source_id: null,
      },
      sources: [
        {
          id: "src-1",
          type: "website",
          name: "asha.in",
          status: "ready",
          item_count: 9,
          config: {},
        },
      ],
      tests: 1,
    });
    await handleNumberConnected(db.supabase, {
      organizationId: "org-1",
      accountId: "wa-1",
      displayNumber: "+91 98000 00002",
    });
    expect(db.session?.["status"]).toBe("connected");
    expect(db.session?.["connected_account_id"]).toBe("wa-1");
    expect(db.mode).toBe("off"); // a web sign-up chooses on Go live

    const live = await journeyGoLive(auth(db), { mode: "draft" });
    expect(live.status).toBe(200);
    expect(db.mode).toBe("draft");
    expect(db.session?.["status"]).toBe("completed");
    expect(db.inserted).toContain("onboarding.went_live");

    const after = world({
      events: ["onboarding.started", "onboarding.went_live"],
      sources: [
        {
          id: "src-1",
          type: "website",
          name: "asha.in",
          status: "ready",
          item_count: 9,
          config: {},
        },
      ],
      accounts: [
        { display_phone_number: "+91 98000 00002", verified_name: "Asha Studio", status: "active" },
      ],
      mode: "draft",
      tests: 1,
    });
    const state = await loadJourneyState(after.supabase, "org-1");
    expect(state.facts.connected).toBe(true);
    expect(state.mode).toBe("draft");
    expect(state.step).toBe("done");
    expect(state.active).toBe(false);
  });

  it("an expired session is revived when its number connects (it used to stay expired)", async () => {
    const db = world({
      session: {
        id: "s1",
        organization_id: "org-1",
        phone: "+91",
        wa_id: "919800000001",
        status: "expired",
      },
    });
    await handleNumberConnected(db.supabase, {
      organizationId: "org-1",
      accountId: "wa-1",
      displayNumber: null,
    });
    expect(db.session?.["status"]).toBe("connected");
  });

  it("Replying before any test answer is refused with the way forward, never silently", async () => {
    const db = world({ tests: 0 });
    const reply = await journeyGoLive(auth(db), { mode: "replying" });
    expect(reply.status).toBe(409);
    expect(reply.body["needs_test"]).toBe(true);
    expect(db.mode).toBe("off");
  });
});

// ------------------------------------------------------------------ cause 8
describe("a grounded answer offers Connect even without starter credits", () => {
  it("ready → tested, and the connect button with the journey link", async () => {
    const db = world({
      session: {
        id: "s1",
        organization_id: "org-1",
        user_id: "user-1",
        phone: "+919800000001",
        wa_id: "919800000001",
        code: "AD-ABCD23",
        status: "ready",
        step: "answering",
        source_id: "src-1",
      },
      ledger: false,
    });
    await handleMerchantInbound(db.supabase, {
      organizationId: "org-platform",
      accountId: "acc-onb",
      phoneNumberId: "pn",
      accessToken: "t",
      waId: "919800000001",
      conversationId: "conv-1",
      contactId: "c",
      body: "How much is the cotton kurta?",
    });
    expect(db.session?.["status"]).toBe("tested");
    expect(db.session?.["step"]).toBe("await_connect");
    expect(h.sent.some((m) => m.body.includes(CONNECT_LINK))).toBe(true);
  });
});

// ------------------------------------------------------------------ site peek
describe("the first glance at a website", () => {
  it("reads name, logo and colour from what every site declares", () => {
    const html = `<html><head><title>Kurtas & Sarees | Asha Studio</title>
      <meta property="og:site_name" content="Asha Studio">
      <meta name="theme-color" content="#7A1F3D">
      <link rel="icon" href="/favicon-32.png" sizes="32x32">
      <link rel="apple-touch-icon" href="/apple-touch-icon.png">
      <meta name="description" content="Handmade cotton, shipped across India."></head></html>`;
    const brand = parseSiteBrand(html, "https://www.asha.in/");
    expect(brand.name).toBe("Asha Studio");
    expect(brand.logoUrl).toBe("https://www.asha.in/apple-touch-icon.png");
    expect(brand.color).toBe("#7a1f3d");
    expect(brand.description).toMatch(/Handmade/);
  });

  it("without og:site_name, the title's brand part; white is never a brand colour", () => {
    const brand = parseSiteBrand(
      "<title>Home – Blue Pottery Works</title><meta name='theme-color' content='#ffffff'>",
      "https://bluepottery.in/",
    );
    expect(brand.name).toBe("Blue Pottery Works");
    expect(brand.color).toBeNull();
    expect(safeColor("#abc")).toBe("#aabbcc");
    expect(safeColor("rgb(10, 20, 30)")).toBe("#0a141e");
  });

  it("accepts what people type, refuses what isn't a site", () => {
    expect(normaliseSiteInput("asha.in")).toBe("https://asha.in/");
    expect(normaliseSiteInput("http://www.asha.in/shop")).toBe("http://www.asha.in/shop");
    expect(normaliseSiteInput("asha@gmail.com")).toBeNull();
    expect(normaliseSiteInput("not a site")).toBeNull();
    expect(nameFromHost("www.blue-pottery.in")).toBe("Blue Pottery");
  });
});
