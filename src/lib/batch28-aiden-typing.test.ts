import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { zooriWorld, type Case } from "./test-support/zoori-replay";

/**
 * Batch 28 item 5 — the read receipt + typing dots go only when a reply goes.
 * They used to start once the gates passed, before the model ran: a run with
 * nothing to send (a stale button tap, a refusal) left the customer watching
 * "typing…" and then nothing. Same Zoori world as Batch 14/27.
 */

vi.mock("@/lib/feature-flags.server", () => ({
  enabledFlags: async () => new Set(["ai_features", "catalog"]),
}));
vi.mock("@/lib/handoff-alerts.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("./handoff-alerts.server")>();
  return { ...real, sendHandoffAlert: async () => ({ whatsapp: [], email: null, refused: [] }) };
});

beforeAll(() => {
  process.env["LOVABLE_API_KEY"] = "test-key";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllGlobals());

async function replay(c: Case) {
  const world = zooriWorld(c);
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => world.fetchStub(url, init));
  let dots = 0;
  const { runAgentOnInbound } = await import("./ai-agent.server");
  const outcome = await runAgentOnInbound(world.supabase, {
    ...(world.args as Parameters<typeof runAgentOnInbound>[1]),
    onWillReply: () => (dots += 1),
  });
  return { outcome, dots, sent: world.result().sent };
}

describe("item 5 — Aiden's dots", () => {
  it("a run with nothing to send (a stale button's text): no dots, nothing sent, the message stays in the inbox", async () => {
    const r = await replay({ id: "b28-stale", ask: "Book now", model: () => ({ text: "" }) });
    expect(r.sent).toEqual([]);
    expect(r.dots).toBe(0);
  });

  it("an answer: the dots once, then the answer", async () => {
    const r = await replay({
      id: "b28-answer",
      ask: "who are you?",
      model: () => ({ text: "I'm Aiden, Zoori's assistant." }),
    });
    expect(r.sent.length).toBeGreaterThan(0);
    expect(r.dots).toBe(1);
  });
});
