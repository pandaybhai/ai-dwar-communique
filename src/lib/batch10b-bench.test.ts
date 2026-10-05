import { afterEach, describe, it, vi } from "vitest";
import { inboundPayload, latencyWorld } from "./test-support/latency-world";
import { acceptWebhook } from "./whatsapp-webhook.server";

const RTT = Number(process.env["BENCH_RTT"] ?? 40);
const GRAPH = 3 * RTT;
const TAP = {
  id: "wamid.tap",
  type: "interactive",
  interactive: { type: "button_reply", button_reply: { id: "menu:b1", title: "Shop" } },
  context: { id: "wamid.prompt" },
};
const KEYWORD = { id: "wamid.kw", type: "text", text: { body: "menu" } };

afterEach(() => vi.unstubAllGlobals());

async function arrive(org: string, waitingRun: boolean, msg: Record<string, unknown>) {
  const w = latencyWorld({
    org,
    rttMs: RTT,
    graphMs: GRAPH,
    waitingRun,
    maxConcurrent: 6,
    override: (op) =>
      op.table === "webhook_events" && op.kind === "insert"
        ? { data: { id: `ev-${org}`, received_at: new Date().toISOString() }, error: null }
        : undefined,
  });
  vi.stubGlobal("fetch", w.fetchStub);
  w.t0.at = Date.now();
  await acceptWebhook(w.supabase, {
    rawBody: JSON.stringify(inboundPayload(msg)),
    signatureValid: true,
    waitUntil: null,
  });
  const close = w.ops.find((o) => o.table === "webhook_events" && o.kind === "update")?.payload as
    { timing?: { messages?: Array<{ ms: Record<string, number> }> } } | undefined;
  return { sendAt: w.graphSends[0]?.at ?? NaN, ms: close?.timing?.messages?.[0]?.ms ?? {} };
}

/**
 * Batch 10B benchmark (off by default): arrival of Meta's POST → first
 * WhatsApp send, per stage, in round trips. Run with
 *   BENCH=1 bunx vitest run src/lib/batch10b-bench.test.ts --silent=false
 * (BENCH_RTT=230 mirrors the live ~230 ms round trip to the Mumbai database.)
 */
describe.runIf(process.env["BENCH"])("bench", () => {
  it("prints", { timeout: 60_000 }, async () => {
    await arrive("warm1", true, TAP);
    await arrive("warm2", false, KEYWORD);
    for (const [name, waiting, msg] of [
      ["tap", true, TAP],
      ["keyword", false, KEYWORD],
    ] as const) {
      const runs: Array<{ sendAt: number; ms: Record<string, number> }> = [];
      for (let i = 0; i < 3; i++) runs.push(await arrive(`${name}${i}`, waiting, msg));
      const avg = (f: (r: (typeof runs)[number]) => number) =>
        runs.reduce((s, r) => s + f(r), 0) / runs.length / RTT;
      const stages = Object.keys(runs[0]!.ms);
      console.log(
        `BENCH ${name} arrival->send ${avg((r) => r.sendAt).toFixed(2)} RTT | ` +
          stages.map((k) => `${k}=${avg((r) => r.ms[k] ?? 0).toFixed(2)}`).join(" "),
      );
    }
  });
});
