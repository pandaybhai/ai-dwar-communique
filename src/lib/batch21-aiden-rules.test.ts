import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activeFlowRules,
  briefTextWithFlowRules,
  buildFlowRules,
  flowRulesBlock,
  followingLabel,
  rulesHours,
} from "./aiden-flow-rules";
import { memoryDb } from "./test-support/memory-db";
import { fakeDb } from "./test-support/fake-db";
import { simStart } from "./flow-simulator";

/**
 * Batch 21 item 2 — a Hand-to-Aiden step's Behaviour / Rules: stored on the
 * chat with an expiry, added to Aiden's prompt right after the workspace's
 * instructions, shown in the inbox header. Without them, Aiden's prompt is
 * byte-identical to before.
 */

const runs: Array<Record<string, unknown>> = [];
vi.mock("@/lib/ai-run.server", async (orig) => ({
  ...(await orig<typeof import("./ai-run.server")>()),
  executeRun: vi.fn(async (_db: unknown, opts: Record<string, unknown>) => {
    runs.push(opts);
    return { runId: "r1", status: "ok", output: "", toolCalls: [] };
  }),
}));

afterEach(() => {
  runs.length = 0;
});

const NOW = new Date("2026-10-07T06:00:00Z");

describe("item 2 — the rules themselves", () => {
  it("expiry defaults to 24 h, merchant picks 1 h – 7 days", () => {
    expect(rulesHours(undefined)).toBe(24);
    expect(rulesHours("")).toBe(24);
    expect(rulesHours("abc")).toBe(24);
    expect(rulesHours(6)).toBe(6);
    expect(rulesHours(0)).toBe(1);
    expect(rulesHours(10_000)).toBe(168);
  });

  it("a step with no Behaviour or Rules stores nothing", () => {
    expect(buildFlowRules({ mode: "aiden" }, { flowId: "f", flowName: "Welcome", runId: "r", now: NOW })).toBeNull();
    expect(buildFlowRules({ mode: "aiden", behaviour: "  ", rules: "" }, { flowId: "f", flowName: "Welcome", runId: "r", now: NOW })).toBeNull();
  });

  it("stores the merchant's words as written (trimmed, capped) with the picked expiry", () => {
    const r = buildFlowRules({ behaviour: " Be brief. ", rules: "x".repeat(3000), rules_hours: 6 }, { flowId: "f1", flowName: "Bridal enquiry", runId: "run1", now: NOW });
    expect(r).toMatchObject({ flow_id: "f1", flow_name: "Bridal enquiry", run_id: "run1", behaviour: "Be brief.", set_at: NOW.toISOString(), expires_at: "2026-10-07T12:00:00.000Z" });
    expect(r!.rules.length).toBe(2000);
  });

  it("applies only until it expires", () => {
    const r = buildFlowRules({ rules: "Only under ₹25,000." }, { flowId: "f", flowName: "W", runId: "r", now: NOW })!;
    expect(activeFlowRules(r, new Date(NOW.getTime() + 23 * 3_600_000))).not.toBeNull();
    expect(activeFlowRules(r, new Date(NOW.getTime() + 24 * 3_600_000))).toBeNull();
    expect(activeFlowRules(null)).toBeNull();
    expect(activeFlowRules("junk")).toBeNull();
    expect(activeFlowRules({ rules: "x" })).toBeNull();
  });

  it("the prompt block carries the business's words; code adds no reply text", () => {
    const r = buildFlowRules({ behaviour: "Warm.", rules: "Offer a video call." }, { flowId: "f", flowName: "Bridal", runId: "r", now: NOW });
    const block = flowRulesBlock(r);
    expect(block).toContain('flow "Bridal"');
    expect(block).toContain("Behaviour: Warm.");
    expect(block).toContain("Rules: Offer a video call.");
    expect(flowRulesBlock(null)).toBe("");
    expect(followingLabel(r!)).toBe("Aiden is following: Bridal rules");
  });

  it("sits right after the workspace's instructions; with none the brief is unchanged", () => {
    const brief = {
      sections: [
        { key: "rules", text: "PLATFORM" },
        { key: "who", text: "WHO" },
        { key: "instructions", text: "WORKSPACE" },
        { key: "escalation", text: "ESCALATE" },
        { key: "knowledge", text: "" },
      ],
      text: "PLATFORM\n\nWHO\n\nWORKSPACE\n\nESCALATE",
    };
    expect(briefTextWithFlowRules(brief, "")).toBe(brief.text);
    expect(briefTextWithFlowRules(brief, "CHAT")).toBe("PLATFORM\n\nWHO\n\nWORKSPACE\n\nCHAT\n\nESCALATE");
    // No workspace instructions written yet: still in that place.
    const empty = { ...brief, sections: brief.sections.map((s) => (s.key === "instructions" ? { ...s, text: "" } : s)) };
    expect(briefTextWithFlowRules(empty, "CHAT")).toBe("PLATFORM\n\nWHO\n\nCHAT\n\nESCALATE");
  });
});

describe("item 2 — the engine stores them on the chat", () => {
  const world = () =>
    memoryDb({
      flows: [{ id: "f1", organization_id: "o1", name: "Bridal enquiry" }],
      conversations: [
        { id: "cv1", organization_id: "o1", aiden_flow_rules: { rules: "old", expires_at: "2099-01-01T00:00:00Z" } },
        { id: "cv2", organization_id: "o2", aiden_flow_rules: null },
      ],
    });

  it("writes the rules with the flow's name and the picked expiry", async () => {
    const { setAidenFlowRules } = await import("./flow-engine.server");
    const db = world();
    await setAidenFlowRules(db.supabase, { id: "run1", flow_id: "f1", organization_id: "o1", conversation_id: "cv1" }, { mode: "aiden", behaviour: "Warm.", rules: "Offer a call.", rules_hours: 72 });
    const saved = db.rows("conversations").find((r) => r["id"] === "cv1")!["aiden_flow_rules"] as Record<string, string>;
    expect(saved).toMatchObject({ flow_id: "f1", flow_name: "Bridal enquiry", run_id: "run1", behaviour: "Warm.", rules: "Offer a call." });
    expect(Date.parse(saved["expires_at"]!) - Date.parse(saved["set_at"]!)).toBe(72 * 3_600_000);
  });

  it("no Behaviour / Rules → an older flow's are cleared, and the flow's name is never read", async () => {
    const { setAidenFlowRules } = await import("./flow-engine.server");
    const db = world();
    await setAidenFlowRules(db.supabase, { id: "run1", flow_id: "f1", organization_id: "o1", conversation_id: "cv1" }, { mode: "aiden" });
    expect(db.rows("conversations").find((r) => r["id"] === "cv1")!["aiden_flow_rules"]).toBeNull();
  });

  it("only this workspace's chat; a failed write never throws", async () => {
    const { setAidenFlowRules } = await import("./flow-engine.server");
    const db = world();
    await setAidenFlowRules(db.supabase, { id: "run1", flow_id: "f1", organization_id: "o1", conversation_id: "cv2" }, { rules: "x" });
    expect(db.rows("conversations").find((r) => r["id"] === "cv2")!["aiden_flow_rules"]).toBeNull();
    const broken = fakeDb((op) => (op.table === "conversations" ? { data: null, error: { message: "timeout" } } : undefined));
    await expect(setAidenFlowRules(broken.supabase, { id: "r", flow_id: "f1", organization_id: "o1", conversation_id: "cv1" }, { rules: "x" })).resolves.toBeUndefined();
  });

  it("the simulator says Aiden will follow them, and for how long", () => {
    const g = {
      nodes: [{ id: "start", type: "start", data: {}, position: { x: 0, y: 0 } }, { id: "h", type: "assign", data: { mode: "aiden", rules: "x", rules_hours: 6 }, position: { x: 0, y: 0 } }],
      edges: [{ id: "e", source: "start", target: "h", sourceHandle: "next" }],
    };
    const s = simStart(g as never, "Asha");
    expect(JSON.stringify(s.messages)).toContain("for 6 hour(s)");
  });
});

describe("item 2 — Aiden's answer", () => {
  const brief = {
    sections: [
      { key: "rules", label: "", text: "PLATFORM" },
      { key: "instructions", label: "", text: "WORKSPACE" },
      { key: "escalation", label: "", text: "ESCALATE" },
    ],
    text: "PLATFORM\n\nWORKSPACE\n\nESCALATE",
    rulesVersion: 3,
    instructions: { escalationRules: "" },
  };
  const ahead = (b = brief) => ({ pastRuns: Promise.resolve({ data: [] }), brief: Promise.resolve(b as never), setLanguage: () => {} });
  const chatDb = (convo: Record<string, unknown>) =>
    fakeDb((op) => {
      if (op.table === "conversations") return { data: { id: "cv1", contact_id: "c1", contacts: { name: "Asha" }, ...convo }, error: null };
      if (op.table === "messages") return { data: [{ direction: "inbound", body: "hi" }], error: null };
      return undefined;
    });

  it("reads the chat's contact and aiden_flow_rules by name", async () => {
    const { conversationTurns } = await import("./ai-tasks.server");
    const db = chatDb({});
    await conversationTurns(db.supabase, "o1", "cv1");
    expect(db.ops.find((o) => o.table === "conversations")!.select).toEqual(["contact_id, aiden_flow_rules, contacts(name)"]);
  });

  it("with rules in force they follow the workspace's instructions in the system prompt", async () => {
    const { agentAnswer } = await import("./ai-tasks.server");
    const rules = buildFlowRules({ behaviour: "Warm.", rules: "Offer a call." }, { flowId: "f", flowName: "Bridal", runId: "r", now: new Date() });
    const db = chatDb({ aiden_flow_rules: rules });
    await agentAnswer(db.supabase, { organizationId: "o1", actorUserId: null }, "cv1", "hi", { agentId: "a1", prelude: {} as never, ahead: ahead() });
    const system = String(runs[0]!["system"]);
    expect(system.startsWith("PLATFORM\n\nWORKSPACE\n\nThis business's own instructions for this chat")).toBe(true);
    expect(system).toContain("Rules: Offer a call.\n\nESCALATE");
  });

  it("without rules (or once expired) the system prompt is exactly the brief, as before", async () => {
    const { agentAnswer } = await import("./ai-tasks.server");
    for (const convo of [{}, { aiden_flow_rules: null }, { aiden_flow_rules: { rules: "x", expires_at: "2020-01-01T00:00:00Z" } }]) {
      runs.length = 0;
      await agentAnswer(chatDb(convo).supabase, { organizationId: "o1", actorUserId: null }, "cv1", "hi", { agentId: "a1", prelude: {} as never, ahead: ahead() });
      expect(runs[0]!["system"]).toBe(brief.text);
    }
  });
});
