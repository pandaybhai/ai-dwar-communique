import { describe, expect, it, vi } from "vitest";
import { CASES, zooriWorld } from "./test-support/zoori-replay";

/**
 * Batch 15A speed bench (opt-in): one Zoori product reply ("show me
 * products": search → send_products ×3 → closing words, branded cards on,
 * WhatsApp shop on) through runAgentOnInbound with the real tool broker,
 * every database read and WhatsApp call slowed to the live figures of
 * 6 Oct 11:57–11:59 UTC (Zoori, webhook_events.timing + message times):
 *
 *   database round trip  120 ms   (contact upsert 239 ms = 2 trips)
 *   WhatsApp send API    500 ms   (pictures landed 0.75–1.0 s apart incl. 2 writes)
 *   branded card render 4500 ms   (6.5 s from the run's end to the first card)
 *   model call          1900 ms   (8.2 s of model time over 3 calls, tools apart)
 *
 * Times are scaled down by SCALE to keep the run short and scaled back up in
 * the report. Run on main and on this branch to compare:
 *   BENCH=1 bunx vitest run src/lib/batch15a-bench.test.ts --silent=false
 */

const SCALE = Number(process.env["BENCH_SCALE"] ?? 5);
const RTT = 120 / SCALE;
const GRAPH = 500 / SCALE;
const RENDER = 4500 / SCALE;
const MODEL = 1900 / SCALE;

vi.mock("@/lib/feature-flags.server", () => ({
  enabledFlags: async () => new Set(["ai_features", "catalogs", "cards", "whatsapp_catalog"]),
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every query waits one round trip before it answers. */
function slow<T extends object>(builder: T): T {
  const proxy: T = new Proxy(builder, {
    get(target, prop, receiver) {
      if (prop === "then") {
        return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          sleep(RTT).then(() => (target as unknown as PromiseLike<unknown>).then(res, rej));
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        return out === target ? proxy : out;
      };
    },
  });
  return proxy;
}

async function oneReply() {
  vi.resetModules();
  process.env["LOVABLE_API_KEY"] = "test-key";
  process.env["AIDWAR_SUPABASE_URL"] = "https://bench.supabase.co";
  process.env["AIDWAR_SUPABASE_SERVICE_ROLE_KEY"] = "bench";
  const c = CASES.find((x) => x.id === "show-me-products")!;
  const world = zooriWorld(c);
  const supabase = {
    from: (t: string) => slow(world.supabase.from(t)),
    rpc: (n: string, a: Record<string, unknown>) => sleep(RTT).then(() => world.supabase.rpc(n, a)),
  } as unknown as typeof world.supabase;
  const t0 = Date.now();
  const at: { firstSend?: number; firstPhoto?: number; lastSend?: number } = {};
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (process.env["BENCH_TRACE"])
      process.stdout.write(`TRACE ${Date.now() - t0} ${init?.method ?? "GET"} ${u.slice(0, 90)}\n`);
    if (u.includes("/chat/completions")) {
      const body = String(init?.body ?? "");
      if (!body.includes("You check whether sentences")) await sleep(MODEL);
    } else if (u.endsWith("/embeddings")) await sleep(2 * RTT);
    else if (u.includes("/storage/v1/object/public/")) {
      await sleep(RTT);
      return new Response(null, { status: 404 });
    } else if (u.includes("/rest/v1/")) {
      // The card's usage metering (service client): a real write's round trip.
      await sleep(RTT);
      return new Response("[]", {
        status: init?.method === "POST" ? 201 : 200,
        headers: { "content-type": "application/json" },
      });
    } else if (u.includes("/functions/v1/render-card")) {
      await sleep(RENDER);
      return new Response(JSON.stringify({ url: "https://bench.supabase.co/card.png" }));
    } else if (u.includes("graph.facebook.com")) {
      await sleep(GRAPH);
      const now = Date.now() - t0;
      const type = String((JSON.parse(String(init?.body ?? "{}")) as { type?: string }).type);
      at.firstSend ??= now;
      if (type === "image") at.firstPhoto ??= now;
      at.lastSend = now;
    }
    return world.fetchStub(u, init);
  });
  const { runAgentOnInbound } = await import("./ai-agent.server");
  await runAgentOnInbound(supabase, world.args as Parameters<typeof runAgentOnInbound>[1]);
  const done = Date.now() - t0;
  vi.unstubAllGlobals();
  const sent = world.result().sent;
  const up = (ms?: number) => (ms === undefined ? null : Math.round((ms * SCALE) / 100) / 10);
  return {
    first_send_s: up(at.firstSend),
    first_photo_s: up(at.firstPhoto),
    last_send_s: up(at.lastSend),
    done_s: up(done),
    sent: sent.map((s) => s.type),
  };
}

describe.runIf(process.env["BENCH"])("bench: one Zoori product reply", () => {
  it("time to first photo and to the last message (seconds, live-calibrated)", async () => {
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await oneReply());
    process.stdout.write(`BENCH ${JSON.stringify(runs)}\n`);
    expect(runs.every((r) => r.first_photo_s !== null)).toBe(true);
  }, 120_000);
});
