import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type Row } from "./test-support/memory-db";

/**
 * Batch 81 (Vinay's standing rule): on /999 the server copies of ViewContent
 * and InitiateCheckout go to Meta for every visitor — Accept, Decline or no
 * choice yet — like Lead, AddPaymentInfo and Purchase; the browser pixel only
 * with consent, with the same event id so Meta counts one. Fakes only.
 */

const h = vi.hoisted(() => ({ db: null as null | { supabase: unknown } }));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.db!.supabase }));

const PLATFORM = "00000000-0000-4000-8000-00000000aaaa";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

/* ============================================================ browser === */

describe("the browser: server copy always, the pixel only with consent, one id", () => {
  async function visit(
    consent: "accepted" | "declined" | null,
    opts: { acceptLater?: boolean } = {},
  ) {
    const store = new Map<string, string>();
    if (consent) store.set("aidwar.meta_consent", `${consent}:${Date.now()}`);
    const fbq: unknown[][] = [];
    const posts: Row[] = [];
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    vi.stubGlobal("window", {
      localStorage: storage,
      sessionStorage: storage,
      location: { pathname: "/999", search: "", href: "https://aidwar.in/999?fbclid=x" },
      addEventListener: () => undefined,
      fbq: Object.assign((...a: unknown[]) => fbq.push(a), { queue: [] }),
    });
    vi.stubGlobal("document", {
      readyState: "complete",
      head: { appendChild: () => undefined },
      createElement: () => ({}),
      querySelector: () => ({}),
      cookie: "",
    });
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit = {}) => {
      posts.push(JSON.parse(String(init.body ?? "{}")) as Row);
      return new Response("{}");
    });
    vi.resetModules();
    const m = await import("./meta-pixel");
    // What the runtime does on /999: the view first, then (with consent) the pixel.
    m.view999Shown("/999");
    if (consent === "accepted") m.pageChanged("/999");
    m.trackInitiateCheckout999();
    if (opts.acceptLater) {
      m.writeConsent("accepted");
      m.pageChanged("/999");
    }
    const tracked = fbq
      .filter((c) => c[0] === "track")
      .map((c) => [c[1], (c[3] as Row)["eventID"]] as [string, string]);
    return { posts, tracked };
  }

  it("declined: both server copies are sent, the pixel never fires", async () => {
    const { posts, tracked } = await visit("declined");
    expect(posts.map((p) => [p["event"], p["landing"]])).toEqual([
      ["ViewContent", "999"],
      ["InitiateCheckout", "999"],
    ]);
    expect(posts[0]).toMatchObject({
      content_name: "999_page",
      url: "https://aidwar.in/999?fbclid=x",
    });
    expect(posts.every((p) => !("consent" in p))).toBe(true);
    expect(tracked).toEqual([]);
  });

  it("no choice yet: the same — server copies, no pixel", async () => {
    const { posts, tracked } = await visit(null);
    expect(posts.map((p) => p["event"])).toEqual(["ViewContent", "InitiateCheckout"]);
    expect(tracked).toEqual([]);
  });

  it("accepted: the pixel fires with the server copy's own id (Meta counts one)", async () => {
    const { posts, tracked } = await visit("accepted");
    const view = String(posts.find((p) => p["event"] === "ViewContent")!["event_id"]);
    const checkout = String(posts.find((p) => p["event"] === "InitiateCheckout")!["event_id"]);
    expect(view).toMatch(/^ViewContent\./);
    expect(tracked).toEqual([
      ["PageView", expect.stringMatching(/^PageView\./)],
      ["ViewContent", view],
      ["InitiateCheckout", checkout],
    ]);
    // Exactly one server copy each (the pixel run adds none).
    expect(posts).toHaveLength(2);
  });

  it("accepted later on the same view: the pixel's ViewContent reuses the id already sent", async () => {
    const { posts, tracked } = await visit(null, { acceptLater: true });
    const view = String(posts.find((p) => p["event"] === "ViewContent")!["event_id"]);
    expect(tracked).toContainEqual(["ViewContent", view]);
    expect(posts.filter((p) => p["event"] === "ViewContent")).toHaveLength(1);
  });

  it("other pages are unchanged: no server copy without consent", async () => {
    vi.stubGlobal("window", {
      localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
      location: { pathname: "/pricing", search: "", href: "https://aidwar.in/pricing" },
      addEventListener: () => undefined,
    });
    const posts: unknown[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit = {}) => {
      posts.push(init.body);
      return new Response("{}");
    });
    vi.resetModules();
    const m = await import("./meta-pixel");
    m.view999Shown("/pricing");
    m.pageChanged("/pricing");
    expect(posts).toEqual([]);
  });
});

/* ============================================================= server === */

describe("the relay: /999's two events are sent without consent, and logged", () => {
  type Graph = { url: string; body: Row };
  let graph: Graph[] = [];
  beforeEach(() => {
    vi.stubEnv("META_CAPI_TOKEN", "TEST-not-a-real-token");
    vi.stubEnv("PLATFORM_ORG_ID", PLATFORM);
    vi.stubEnv("META_CAPI_TEST_CODE", "");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    graph = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      graph.push({ url: String(url), body: JSON.parse(String(init.body ?? "{}")) as Row });
      return new Response(JSON.stringify({ events_received: 1, fbtrace_id: "T1" }), {
        status: 200,
      });
    });
  });

  async function relay(body: Row) {
    const db = memoryDb({ activity_log: [], meta_capi_log: [], profiles: [] }, {});
    h.db = { supabase: db.supabase };
    const { Route } = await import("@/routes/api/public/meta-event");
    const post = (
      Route.options as unknown as {
        server: { handlers: Record<string, (a: { request: Request }) => Promise<Response>> };
      }
    ).server.handlers["POST"]!;
    await post({
      request: new Request("https://aidwar.in/api/public/meta-event", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "Mozilla/5.0 test",
          "cf-connecting-ip": "203.0.113.9",
        },
        body: JSON.stringify(body),
      }),
    });
    return db;
  }
  const events = () =>
    graph
      .filter((g) => g.url.includes("graph.facebook.com"))
      .map((g) => (g.body["data"] as Row[])[0]!);

  it("declined (no consent in the body): ViewContent and InitiateCheckout reach Meta with their ids, and meta_capi_log has them", async () => {
    const a = await relay({
      event: "ViewContent",
      event_id: "ViewContent.abcdef12-3456",
      content_name: "999_page",
      landing: "999",
      url: "https://aidwar.in/999?fbclid=x",
    });
    const b = await relay({
      event: "InitiateCheckout",
      event_id: "InitiateCheckout.abcdef12-7890",
      landing: "999",
      url: "https://aidwar.in/999",
    });
    expect(events()).toEqual([
      expect.objectContaining({
        event_name: "ViewContent",
        event_id: "ViewContent.abcdef12-3456",
        action_source: "website",
        event_source_url: "https://aidwar.in/999",
        custom_data: { content_name: "999_page" },
      }),
      expect.objectContaining({
        event_name: "InitiateCheckout",
        event_id: "InitiateCheckout.abcdef12-7890",
        custom_data: { content_name: "basic", value: 999, currency: "INR" },
      }),
    ]);
    expect(a.rows("meta_capi_log")).toEqual([
      expect.objectContaining({
        event_name: "ViewContent",
        event_id: "ViewContent.abcdef12-3456",
        outcome: "sent",
        http_status: 200,
      }),
    ]);
    expect(b.rows("meta_capi_log")[0]).toMatchObject({
      event_name: "InitiateCheckout",
      outcome: "sent",
    });
  });

  it("only from /999: the same body naming another page, or another page's ViewContent without consent, sends nothing", async () => {
    await relay({
      event: "ViewContent",
      event_id: "ViewContent.abcdef12-3456",
      landing: "999",
      url: "https://aidwar.in/pricing",
    });
    await relay({
      event: "InitiateCheckout",
      event_id: "InitiateCheckout.abcdef12-7890",
      landing: "999",
      url: "https://aidwar.in/start",
    });
    await relay({
      event: "ViewContent",
      event_id: "ViewContent.abcdef12-1111",
      content_name: "Pricing",
      url: "https://aidwar.in/pricing",
    });
    expect(events()).toEqual([]);
  });
});
