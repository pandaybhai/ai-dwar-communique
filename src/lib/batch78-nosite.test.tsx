import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { memoryDb, type Row } from "./test-support/memory-db";

/**
 * Batch 78 addition — the website is optional at workspace setup. Live: all
 * five accounts made 12–13 Nov stopped at "add your website" (0 workspaces).
 * Now "Yes, here's my website" (unchanged) or "I don't have a website — I'll
 * tell Aiden on WhatsApp": the workspace is made from the name alone, and on
 * WhatsApp Aiden asks four questions, one at a time, then for a price list.
 * Fakes only: nothing reaches a live database, WhatsApp or Meta.
 */

const h = vi.hoisted(() => ({
  facts: [] as Array<{ org: string; topic: string; text: string }>,
  sites: [] as string[],
}));
vi.mock("@/lib/knowledge.server", () => ({
  saveFact: async (_s: unknown, org: string, input: { topic: string; text: string }) => {
    h.facts.push({ org, topic: input.topic, text: input.text });
    return { ok: true };
  },
  addWebsiteSource: async (_s: unknown, _org: string, url: string) => {
    h.sites.push(url);
    return { ok: true, sourceId: "src-1", queued: true };
  },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => async () => undefined,
}));

import { beginBusiness } from "./onboarding-begin";
import { landingStep, resumeStep } from "./onboarding-journey";
import {
  INTERVIEW,
  MEDIA_STEP,
  NO_SITE_STEP,
  SKIP_MEDIA_ID,
  nextInterviewStep,
  setupStepPatch,
} from "./no-site-interview";
import { SCRIPTS } from "./scripts";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  h.facts = [];
  h.sites = [];
});
afterEach(() => vi.restoreAllMocks());

/* ------------------------------------------------------ setup (the web) --- */

describe("workspace setup: the website is optional", () => {
  it("the business step offers a clear choice; the website field shows only for 'Yes'", async () => {
    const { StepBusiness } = await import("@/components/onboarding/step-business");
    const html = renderToStaticMarkup(
      <StepBusiness
        existingName={null}
        existingUrl={null}
        onBrand={() => undefined}
        onSubmit={async () => null}
      />,
    );
    const text = html
      .replace(/<[^>]+>/g, " ")
      .replace(/&#x27;/g, "'")
      .replace(/\s+/g, " ");
    expect(text).toContain("Yes, here's my website");
    expect(text).toContain("I don't have a website");
    expect(text).toContain("I'll tell Aiden on WhatsApp");
    expect(html.match(/role="radio"/g)).toHaveLength(2);
    expect(html).toContain('aria-checked="false"');
    // Nothing chosen yet: no website field, no long description box any more.
    expect(html).not.toContain('id="ob-site"');
    expect(html).not.toContain("ob-about");
    // A website already on file: "Yes" is chosen and the field shows (unchanged path).
    const withSite = renderToStaticMarkup(
      <StepBusiness
        existingName="ZOORI"
        existingUrl="https://zoori.in"
        onBrand={() => undefined}
        onSubmit={async () => null}
      />,
    );
    expect(withSite).toContain('id="ob-site"');
    expect(withSite).toMatch(
      /aria-checked="true"[^>]*data-testid="choice-site"|data-testid="choice-site"[^>]*aria-checked="true"/,
    );
    const src = readFileSync("src/components/onboarding/step-business.tsx", "utf8");
    expect(src).toContain(
      'const ready = name.trim().length >= 2 && (noSite || (choice === "site" && Boolean(url)));',
    );
    expect(src).toContain("noWebsite: noSite,");
  });

  it("no website: the workspace is created from the name alone (same create path), then the no-website begin and session", async () => {
    const calls: Array<[string, unknown]> = [];
    const out = await beginBusiness(
      null,
      { name: "Asha Tuitions", url: null, about: null, brand: null, noWebsite: true },
      {
        createOrganization: async (name) => {
          calls.push(["create_organization", name]);
          return { id: "org-new", error: null };
        },
        onCreated: (id) => void calls.push(["created", id]),
        journey: async (p) => {
          calls.push(["begin", p]);
          return {};
        },
        startSession: async (b) => void calls.push(["start", b]),
      },
    );
    expect(out).toEqual({ ok: true, orgId: "org-new", created: true });
    expect(calls).toEqual([
      ["create_organization", "Asha Tuitions"],
      ["created", "org-new"],
      [
        "begin",
        {
          action: "begin",
          organization_id: "org-new",
          name: "Asha Tuitions",
          url: null,
          about: null,
          brand: {},
          no_website: true,
        },
      ],
      ["start", { organization_id: "org-new", no_website: true }],
    ]);
  });

  it("website path unchanged: create, begin with the URL (no no_website), session", async () => {
    const calls: Array<[string, unknown]> = [];
    await beginBusiness(
      null,
      {
        name: "ZOORI Jewels",
        url: "https://zoori.in/",
        about: null,
        brand: { logoUrl: "https://zoori.in/logo.png", color: "#123456" },
      },
      {
        createOrganization: async () => ({ id: "org-z", error: null }),
        journey: async (p) => {
          calls.push(["begin", p]);
          return {};
        },
        startSession: async (b) => void calls.push(["start", b]),
      },
    );
    expect(calls[0]![1]).toEqual({
      action: "begin",
      organization_id: "org-z",
      name: "ZOORI Jewels",
      url: "https://zoori.in/",
      about: null,
      brand: { logoUrl: "https://zoori.in/logo.png", color: "#123456" },
    });
    expect(calls[1]![1]).toEqual({ organization_id: "org-z", no_website: false });
    // The journey uses this one path, and create_organization exactly as before.
    const journey = readFileSync("src/components/onboarding/onboarding-journey.tsx", "utf8");
    expect(journey).toContain("beginBusiness(organizationId, input, {");
    expect(journey).toContain('aidwar.rpc("create_organization", { org_name: name })');
  });

  it("a failed create stops there; an existing workspace is never created again", async () => {
    const begin = vi.fn(async () => ({}));
    expect(
      await beginBusiness(
        null,
        { name: "X Y", url: null, about: null, brand: null, noWebsite: true },
        {
          createOrganization: async () => ({ id: null, error: new Error("x") }),
          journey: begin,
          startSession: async () => undefined,
        },
      ),
    ).toEqual({ ok: false, error: "We couldn't create your workspace. Please try again." });
    expect(begin).not.toHaveBeenCalled();
    const create = vi.fn(async () => ({ id: "x", error: null }));
    expect(
      await beginBusiness(
        "org-1",
        { name: "X Y", url: null, about: null, brand: null, noWebsite: true },
        { createOrganization: create, journey: begin, startSession: async () => undefined },
      ),
    ).toEqual({ ok: true, orgId: "org-1", created: false });
    expect(create).not.toHaveBeenCalled();
  });

  it("the server's begin: no website is accepted (marked), a website still goes to the reader", async () => {
    const { journeyBegin } = await import("./onboarding-journey-api.server");
    const db = memoryDb({
      organizations: [{ id: "org-1", name: "Asha Tuitions", branding: {} }],
      analytics_events: [],
    });
    const auth = {
      supabase: db.supabase as never,
      organizationId: "org-1",
      userId: "u-1",
      role: "owner",
      canConfigure: true,
    };
    const none = await journeyBegin(auth, { name: "Asha Tuitions", url: null, no_website: true });
    expect(none).toEqual({ status: 200, body: { no_website: true } });
    expect(db.rows("analytics_events").map((e: Row) => e["event_type"])).toContain(
      "onboarding.no_website",
    );
    expect(h.sites).toEqual([]);
    // Neither a website nor the choice: refused as before.
    expect((await journeyBegin(auth, { name: "Asha Tuitions" })).status).toBe(400);
    // The website path.
    const site = await journeyBegin(auth, { name: "Asha Tuitions", url: "asha.in" });
    expect(site.status).toBe(200);
    expect(h.sites).toEqual(["https://asha.in/"]);
  });

  it("no website counts as the business step done: on to Connect (with Talk to Aiden on top)", () => {
    const base = {
      hasOrg: true,
      hasMaterial: false,
      connected: false,
      connectSkipped: false,
      tested: false,
      wentLive: false,
    };
    expect(resumeStep(base)).toBe("business");
    expect(resumeStep({ ...base, noWebsite: true })).toBe("connect");
    expect(landingStep({ ...base, noWebsite: true }, "connect")).toBe("connect");
    expect(landingStep(base, "connect")).toBe("business");
    const journey = readFileSync("src/components/onboarding/onboarding-journey.tsx", "utf8");
    expect(journey).toContain("<TalkToAidenBanner organizationId={organizationId} />");
    expect(journey).toContain(
      'navigate({ to: "/app/start", search: { step: "connect" }, replace: true })',
    );
    expect(readFileSync("src/lib/onboarding-journey.server.ts", "utf8")).toContain(
      'noWebsite: recorded.has("no_website")',
    );
  });

  it("the WhatsApp setup session: 'no_site' for no website, cleared by choosing a website, never past the start", () => {
    expect(setupStepPatch(true, null)).toEqual({ step: NO_SITE_STEP });
    expect(setupStepPatch(false, null)).toBeNull();
    expect(setupStepPatch(undefined, null)).toBeNull(); // the card asking for its code
    expect(setupStepPatch(true, { status: "pending", step: null })).toEqual({ step: NO_SITE_STEP });
    expect(setupStepPatch(true, { status: "bound", step: "await_site" })).toEqual({
      step: NO_SITE_STEP,
    });
    expect(setupStepPatch(true, { status: "bound", step: "interview_2" })).toBeNull();
    expect(setupStepPatch(false, { status: "pending", step: NO_SITE_STEP })).toEqual({
      step: null,
    });
    expect(setupStepPatch(true, { status: "ready", step: "answering" })).toBeNull();
    const route = readFileSync("src/routes/api/onboarding/start.ts", "utf8");
    expect(route).toContain('setupStepPatch(\n          payload["no_website"],');
    expect(route.match(/\.\.\.\(stepPatch \?\? \{\}\)/g)).toHaveLength(2);
  });

  it("the stuck accounts (signed up, no workspace) land on the same choice and can finish without a website", async () => {
    const route = readFileSync("src/routes/app/route.tsx", "utf8");
    expect(route).toContain(
      "<OnboardingJourney organizationId={null} requested={null} onWorkspaceCreated={reload} />",
    );
    const { OnboardingJourney } = await import("@/components/onboarding/onboarding-journey");
    const html = renderToStaticMarkup(<OnboardingJourney organizationId={null} requested={null} />);
    const text = html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'");
    expect(text).toContain("Yes, here's my website");
    expect(text).toContain("I don't have a website");
  });
});

/* -------------------------------------------- the interview on WhatsApp --- */

describe("the no-website interview on WhatsApp", () => {
  function io() {
    const out = {
      replies: [] as string[],
      buttons: [] as Array<{ text: string; ids: string[] }>,
      patches: [] as Row[],
    };
    return {
      out,
      io: {
        reply: async (t: string) => void out.replies.push(t),
        replyButtons: async (t: string, b: Array<{ id: string }>) =>
          void out.buttons.push({ text: t, ids: b.map((x) => x.id) }),
        patchSession: async (_id: string, p: Row) => void out.patches.push(p),
      },
    };
  }
  const session = () => ({
    id: "s1",
    organization_id: "org-1",
    user_id: "u-1",
    step: NO_SITE_STEP as string | null,
  });
  const db = () => memoryDb({ ai_prompt_blocks: [] }).supabase as never;

  it("asks one question at a time in order, saves each answer as a fact, skip and greetings don't save", async () => {
    const { startInterview, interviewTurn } = await import("./no-site-interview.server");
    const supabase = db();
    const s = session();
    const { out, io: x } = io();
    await startInterview(supabase, s, x);
    expect(out.patches.at(-1)).toEqual({ status: "bound", step: "interview_1" });
    expect(out.replies.at(-1)).toBe(SCRIPTS.interview_q1.text);
    const turn = (
      body: string,
      interactiveId: string | null = null,
      control: never | null = null,
    ) =>
      interviewTurn(
        supabase,
        {
          session: s,
          step: s.step as never,
          body,
          interactiveId,
          businessName: "Asha Tuitions",
          control,
        },
        x,
      );

    await turn("Maths and science tuition, ₹1,500–₹3,000 a month");
    expect(h.facts.at(-1)).toEqual({
      org: "org-1",
      topic: "Products and prices",
      text: "Products and prices: Maths and science tuition, ₹1,500–₹3,000 a month",
    });
    expect(out.patches.at(-1)).toEqual({ step: "interview_2" });
    expect(out.replies.at(-1)).toBe(SCRIPTS.interview_q2.text);

    // "skip" skips the question; nothing saved.
    await turn("skip", null, "skip" as never);
    expect(h.facts).toHaveLength(1);
    expect(out.patches.at(-1)).toEqual({ step: "interview_3" });
    expect(out.replies.at(-1)).toBe(SCRIPTS.interview_q3.text);

    // A greeting asks the same question again; nothing saved, nothing moves.
    const patches = out.patches.length;
    await turn("hi", null, "greeting" as never);
    expect(out.replies.at(-1)).toBe(SCRIPTS.interview_q3.text);
    expect(out.patches).toHaveLength(patches);
    expect(h.facts).toHaveLength(1);

    await turn("UPI and cash");
    await turn("no", null, "ack" as never);
    expect(h.facts.map((f) => f.text)).toEqual([
      "Products and prices: Maths and science tuition, ₹1,500–₹3,000 a month",
      "Payment options: UPI and cash",
      "Returns and exchanges: no",
    ]);
    // Then the price list, with a Skip button.
    expect(out.patches.at(-1)).toEqual({ step: MEDIA_STEP });
    expect(out.buttons.at(-1)).toEqual({
      text: SCRIPTS.interview_media.text,
      ids: [SKIP_MEDIA_ID],
    });
  });

  it("the price list: Skip → ready to test (the same step a website reaches); words are kept", async () => {
    const { interviewTurn } = await import("./no-site-interview.server");
    const supabase = db();
    const s = { ...session(), step: MEDIA_STEP as string | null };
    const { out, io: x } = io();
    await interviewTurn(
      supabase,
      {
        session: s,
        step: MEDIA_STEP,
        body: "Fees are on the board outside",
        interactiveId: null,
        businessName: "Asha Tuitions",
        control: null,
      },
      x,
    );
    expect(h.facts.at(-1)!.text).toBe("About the business: Fees are on the board outside");
    expect(out.buttons.at(-1)!.ids).toEqual([SKIP_MEDIA_ID]);
    await interviewTurn(
      supabase,
      {
        session: s,
        step: MEDIA_STEP,
        body: "Skip",
        interactiveId: SKIP_MEDIA_ID,
        businessName: "Asha Tuitions",
        control: null,
      },
      x,
    );
    expect(out.patches.at(-1)).toEqual({ status: "ready", step: "answering" });
    expect(out.replies.at(-1)).toBe(
      "Thanks — I've saved all that for Asha Tuitions. Now test me: ask me anything a customer would ask, like your prices or your timings.",
    );
  });

  it("the order: q1 → q2 → q3 → q4 → price list → done", () => {
    expect(INTERVIEW.map((q) => q.topic)).toEqual([
      "Products and prices",
      "Timings and delivery area",
      "Payment options",
      "Returns and exchanges",
    ]);
    expect(nextInterviewStep("interview_1")).toBe("interview_2");
    expect(nextInterviewStep("interview_4")).toBe(MEDIA_STEP);
    expect(nextInterviewStep(MEDIA_STEP)).toBeNull();
  });

  it("the interview questions are editable Scripts in /admin/aiden, with these defaults", async () => {
    const { SCRIPT_KEYS } = await import("./scripts");
    for (const key of [
      "interview_q1",
      "interview_q2",
      "interview_q3",
      "interview_q4",
      "interview_media",
      "interview_done",
    ]) {
      expect(SCRIPT_KEYS).toContain(key);
    }
    expect(SCRIPTS.interview_q1.text).toContain("What do you sell, and what's your price range?");
    expect(SCRIPTS.interview_q2.text).toContain("timings");
    expect(SCRIPTS.interview_q3.text).toContain("cash on delivery");
    expect(SCRIPTS.interview_q4.text).toContain("return or exchange policy");
    expect(SCRIPTS.interview_media.text).toContain("photo or PDF of your price list or catalogue");
    // The admin page lists every Script key, so these appear there.
    expect(readFileSync("src/routes/admin/aiden.tsx", "utf8")).toContain(
      "<PromptBlocksEditor keys={SCRIPT_KEYS} heading={false} />",
    );
  });

  it("wired into the platform-number pipeline: after the intro, before control words; media and links as always", () => {
    const src = readFileSync("src/lib/merchant-channel.server.ts", "utf8");
    // After the Day-one intro, a no-website session starts the interview.
    const intro = src.indexOf('[{ id: "start", title: "Your own AI employee" }],');
    const start = src.indexOf("await startInterview(supabase, session, interviewIo);");
    expect(start).toBeGreaterThan(intro);
    // The interview takes typed answers before the control words, never a file or a link.
    const turn = src.indexOf("await interviewTurn(");
    expect(turn).toBeGreaterThan(0);
    expect(turn).toBeLessThan(
      src.indexOf("// ------------------------------------------------------ 2. CONTROL WORDS"),
    );
    expect(src).toContain("!args.mediaUrl &&");
    expect(src).toContain("!(body && !interactiveId && extractSiteLink(body))");
    // A file that can't be read mid-interview goes back to the same question.
    expect(src).toContain('step: isInterviewStep(session.step) ? session.step : "await_site",');
    // The same first-answer credits, worded for what the owner told Aiden.
    expect(src).toContain(
      'const from = (websites ?? 0) > 0 ? "your website" : "what you told me";',
    );
    expect(src).toContain("That answer came from ${from}, not a script.");
  });
});
