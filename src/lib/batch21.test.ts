import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { outputsOf, validateGraph, type FlowGraph } from "./flow-graph";
import { simStart } from "./flow-simulator";
import { memoryDb } from "./test-support/memory-db";
import { engineTranscript } from "./test-support/live-flows";

/**
 * Batch 21 — product follow-ups.
 *   Item 1: the Assign step's third choice, "Hand to Aiden".
 */

vi.mock("@/lib/feature-flags.server", () => ({ enabledFlags: async () => new Set(["flows_v2"]) }));

beforeAll(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => {
  vi.restoreAllMocks();
});

const node = (id: string, type: string, data: Record<string, unknown> = {}) => ({ id, type, data, position: { x: 0, y: 0 } });
const edge = (source: string, target: string, sourceHandle = "next") => ({ id: `${source}-${target}`, source, target, sourceHandle });

/** start → "Hi" → Assign(Hand to Aiden) → (a stale connection) → "Never sent". */
function aidenGraph(assignData: Record<string, unknown>): FlowGraph {
  return {
    nodes: [node("start", "start"), node("hi", "text", { text: "Hi" }), node("hand", "assign", assignData), node("after", "text", { text: "Never sent" }), node("end", "end")],
    edges: [edge("start", "hi"), edge("hi", "hand"), edge("hand", "after"), edge("after", "end")],
  } as unknown as FlowGraph;
}

describe("item 1 — Assign: Hand to Aiden", () => {
  it("the step offers no way out (the flow ends there); the other choices keep 'next'", () => {
    expect(outputsOf(node("a", "assign", { mode: "aiden" }) as never)).toEqual([]);
    expect(outputsOf(node("a", "assign", { mode: "round_robin" }) as never)).toEqual(["next"]);
    expect(outputsOf(node("a", "assign", { user_id: "" }) as never)).toEqual(["next"]);
    expect(outputsOf(node("a", "assign", {}) as never)).toEqual(["next"]);
  });

  it("publishes without a connection after it; a queue Assign still needs one", () => {
    const g = { nodes: [node("start", "start"), node("hand", "assign", { mode: "aiden" })], edges: [edge("start", "hand")] } as unknown as FlowGraph;
    expect(validateGraph(g)).toEqual([]);
    const q = { nodes: [node("start", "start"), node("hand", "assign", {})], edges: [edge("start", "hand")] } as unknown as FlowGraph;
    expect(validateGraph(q).map((p) => p.nodeId)).toEqual(["hand"]);
  });

  it("the editor's simulator ends the flow at the step and says Aiden takes over", () => {
    const s = simStart(aidenGraph({ mode: "aiden" }), "Asha");
    expect(s.done).toBe(true);
    expect(s.messages.map((m) => m.text)).toEqual(["Hi", expect.stringContaining("Hands the chat to Aiden")]);
    expect(JSON.stringify(s.messages)).not.toContain("Never sent");
  });

  it("the engine ends the run as done (reason hand_to_aiden) and never follows a stale connection", async () => {
    const engine = await import("./flow-engine.server");
    const t = await engineTranscript(engine, aidenGraph({ mode: "aiden" }), [], "org-b21-aiden");
    expect(t.run.status).toBe("done");
    expect(t.run.node).toBe("hand");
    expect(t.turns[0]!.sends.length).toBe(1);
    expect(JSON.stringify(t.turns)).not.toContain("Never sent");
    expect(t.events.some((e) => e.includes("ended") && e.includes("hand_to_aiden"))).toBe(true);
    // No assignment, no Needs you: the step writes only the hand-off clear.
    expect(t.writes.filter((w) => w.startsWith("conversation:") && !w.includes("last_message_at"))).toEqual([
      'conversation:{"needs_human":false,"needs_human_reason":null,"needs_human_question":null,"handover_state":null}',
    ]);
  });

  it("existing Assign choices behave exactly as before (queue / round-robin write the same, then go on)", async () => {
    const engine = await import("./flow-engine.server");
    const t = await engineTranscript(engine, aidenGraph({ user_id: "" }), [], "org-b21-queue");
    expect(t.run.status).toBe("done");
    expect(JSON.stringify(t.turns)).toContain("Never sent");
    expect(t.writes.filter((w) => w.startsWith("conversation:") && !w.includes("last_message_at"))).toEqual([
      'conversation:{"needs_human":true,"needs_human_reason":"flow_assign","needs_human_at":"<time>"}',
    ]);
  });

  describe("handToAiden: clears a flow's hand-off, never a person's", () => {
    const base = { organization_id: "o1", assigned_to: null, needs_human: true, needs_human_question: "q", handover_state: "sent" };
    const world = () =>
      memoryDb({
        conversations: [
          { ...base, id: "flow-assign", needs_human_reason: "flow_assign" },
          { ...base, id: "flow-needs-you", needs_human_reason: "flow" },
          { ...base, id: "asked", needs_human_reason: "asked_for_person" },
          { ...base, id: "rule", needs_human_reason: "merchant_rule" },
          { ...base, id: "taken", needs_human: false, needs_human_reason: null, assigned_to: "user-1" },
          { ...base, id: "flow-but-taken", needs_human_reason: "flow_assign", assigned_to: "user-2" },
          { ...base, id: "other-org", organization_id: "o2", needs_human_reason: "flow_assign" },
        ],
      });

    it("a flow's Needs you / Assign-to-queue is cleared", async () => {
      const { handToAiden } = await import("./flow-engine.server");
      const db = world();
      for (const id of ["flow-assign", "flow-needs-you"]) await handToAiden(db.supabase, { organization_id: "o1", conversation_id: id });
      for (const id of ["flow-assign", "flow-needs-you"]) {
        expect(db.rows("conversations").find((r) => r["id"] === id)).toMatchObject({ needs_human: false, needs_human_reason: null, needs_human_question: null, handover_state: null });
      }
    });

    it("a customer's ask, a merchant rule, a teammate's takeover and another workspace's chat are untouched", async () => {
      const { handToAiden } = await import("./flow-engine.server");
      const db = world();
      const before = structuredClone(db.rows("conversations"));
      for (const id of ["asked", "rule", "taken"]) await handToAiden(db.supabase, { organization_id: "o1", conversation_id: id });
      await handToAiden(db.supabase, { organization_id: "o1", conversation_id: "other-org" });
      await handToAiden(db.supabase, { organization_id: "o1", conversation_id: "flow-but-taken" });
      const after = db.rows("conversations");
      for (const id of ["asked", "rule", "taken", "other-org"]) expect(after.find((r) => r["id"] === id)).toEqual(before.find((r) => r["id"] === id));
      // The flow's queue flag goes, but the teammate keeps the chat (assigned_to is never touched).
      expect(after.find((r) => r["id"] === "flow-but-taken")).toMatchObject({ needs_human: false, assigned_to: "user-2" });
    });

    it("never writes assigned_to", async () => {
      const { handToAiden } = await import("./flow-engine.server");
      const db = world();
      await handToAiden(db.supabase, { organization_id: "o1", conversation_id: "flow-assign" });
      expect(db.log.filter((l) => l.kind === "update").every((l) => !Object.keys(l.payload as object).includes("assigned_to"))).toBe(true);
    });
  });
});
