import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type MemoryDb } from "./test-support/memory-db";

/**
 * Batch 63 (D): a trigger keyword restarts its flow. Zoori: a customer
 * waiting at a buttons step scans the Fam Card QR ("ZOORI FAM CARD"); the
 * waiting step swallowed the keyword, the run ended after its retries and no
 * new run started. Now the waiting run ends with end_reason
 * superseded_by_trigger and the keyword's flow starts.
 */

vi.mock("@/lib/ai-tools.server", () => ({ enabledFlags: async () => new Set(["flows_v2"]) }));
vi.mock("@/lib/feature-flags.server", () => ({ enabledFlags: async () => new Set(["flows_v2"]) }));
vi.mock("@/lib/flows.server", () => ({
  loadSendSettings: async () => ({ timezone: "Asia/Kolkata", quietHoursEnabled: false }),
}));
vi.mock("@/lib/whatsapp-numbers.server", () => ({
  getWhatsAppConnection: async () => ({ connection: null }),
}));

const ORG = "81c234b2-569f-40be-ad71-96c046de5d12";
const CONTACT = "c0000000-0000-4000-8000-000000000001";
const CONV = "c0000000-0000-4000-8000-0000000000c1";

const menuGraph = {
  nodes: [
    { id: "start", type: "start", data: {} },
    {
      id: "btns",
      type: "buttons",
      data: {
        text: "What would you like?",
        buttons: [
          { id: "yes", title: "Yes" },
          { id: "no", title: "No thanks" },
        ],
        retries: 2,
      },
    },
    { id: "end", type: "end", data: {} },
  ],
  edges: [
    { id: "e1", source: "start", sourceHandle: "next", target: "btns" },
    { id: "e2", source: "btns", sourceHandle: "yes", target: "end" },
    { id: "e3", source: "btns", sourceHandle: "no", target: "end" },
  ],
};
const famGraph = {
  nodes: [
    { id: "start", type: "start", data: {} },
    { id: "end", type: "end", data: {} },
  ],
  edges: [{ id: "f1", source: "start", sourceHandle: "next", target: "end" }],
};

function trigger(id: string, flowId: string, keywords: string[], match = "exact", priority = 0) {
  return {
    id,
    organization_id: ORG,
    flow_id: flowId,
    kind: "keyword",
    config: { keywords, match, priority },
    is_enabled: true,
    flows: { whatsapp_account_id: null, config: {} },
  };
}

function world(
  opts: { triggers?: ReturnType<typeof trigger>[]; nodeId?: string; assigned?: string | null } = {},
) {
  return memoryDb({
    flow_versions: [
      {
        id: "ver-menu",
        flow_id: "flow-menu",
        organization_id: ORG,
        status: "published",
        graph: menuGraph,
        flows: { config: {} },
      },
      {
        id: "ver-fam",
        flow_id: "flow-fam",
        organization_id: ORG,
        status: "published",
        graph: famGraph,
        flows: { config: {} },
      },
    ],
    flow_runs: [
      {
        id: "run-1",
        organization_id: ORG,
        flow_id: "flow-menu",
        version_id: "ver-menu",
        contact_id: CONTACT,
        conversation_id: CONV,
        current_node_id: opts.nodeId ?? "btns",
        variables: { _attempts: { btns: 1 } },
        status: "waiting",
        waiting_for: "reply",
        wake_at: new Date(Date.now() + 3600_000).toISOString(),
        steps: 2,
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ],
    flow_triggers: opts.triggers ?? [trigger("t-fam", "flow-fam", ["ZOORI FAM CARD"])],
    conversations: [
      {
        id: CONV,
        organization_id: ORG,
        contact_id: CONTACT,
        status: "open",
        assigned_to: opts.assigned ?? null,
      },
    ],
    contacts: [
      {
        id: CONTACT,
        organization_id: ORG,
        name: "Asha",
        phone: "+919812345678",
        wa_id: "919812345678",
        opt_in_status: "opted_in",
        attributes: {},
        contact_tags: [],
      },
    ],
    flows: [
      { id: "flow-menu", organization_id: ORG, whatsapp_account_id: null, config: {} },
      { id: "flow-fam", organization_id: ORG, whatsapp_account_id: null, config: {} },
    ],
  });
}

const msg = (body: string, replyId: string | null = null) => ({
  organizationId: ORG,
  contactId: CONTACT,
  conversationId: CONV,
  body,
  replyId,
});

/** What the webhook does: the flow's turn, then (when released) the trigger dispatch. */
async function inbound(db: MemoryDb, body: string, replyId: string | null = null) {
  const { handleInboundForRuns } = await import("./flow-engine.server");
  const { dispatchInboundTriggers } = await import("./flow-triggers.server");
  const taken = await handleInboundForRuns(db.supabase, msg(body, replyId));
  if (taken.consumed) return { taken, started: null };
  const started = await dispatchInboundTriggers(db.supabase, {
    ...msg(body),
    isFirstMessageEver: false,
    isCtwa: false,
    campaignButton: null,
    skipKeywords: Boolean(taken.runActive),
  });
  return { taken, started };
}

const runs = (db: MemoryDb) => db.rows("flow_runs");
const old = (db: MemoryDb) => runs(db).find((r) => r["id"] === "run-1")!;

beforeEach(() => vi.resetModules());

describe("an exact trigger keyword restarts its flow", () => {
  it('Zoori: waiting at buttons, then "ZOORI FAM CARD" → the waiting run ends (superseded_by_trigger) and the Fam Card flow starts', async () => {
    const db = world();
    const { taken, started } = await inbound(db, "ZOORI FAM CARD");
    expect(taken).toEqual({
      consumed: false,
      runActive: false,
      superseded: { flowId: "flow-fam", triggerId: "t-fam" },
    });
    expect(old(db)).toMatchObject({
      status: "ended",
      end_reason: "superseded_by_trigger",
      waiting_for: null,
      wake_at: null,
    });
    expect(started).toEqual({ started: true, flowId: "flow-fam" });
    const fresh = runs(db).filter((r) => r["flow_id"] === "flow-fam");
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ contact_id: CONTACT, version_id: "ver-fam" });
    const ended = db
      .rows("flow_run_events")
      .find((e) => e["run_id"] === "run-1" && e["event"] === "ended");
    expect(ended?.["detail"]).toMatchObject({
      reason: "superseded_by_trigger",
      trigger_id: "t-fam",
      flow_id: "flow-fam",
      same_flow: false,
    });
  });

  it("case and spacing don't matter (the QR's text as typed: \"  zoori   fam card \")", async () => {
    const db = world();
    const { started } = await inbound(db, "  zoori   fam card ");
    expect(old(db)["status"]).toBe("ended");
    expect(started?.flowId).toBe("flow-fam");
  });

  it("the same flow's keyword restarts it from its start", async () => {
    const db = world({ triggers: [trigger("t-menu", "flow-menu", ["MENU"])] });
    const { taken, started } = await inbound(db, "menu");
    expect(taken.superseded).toEqual({ flowId: "flow-menu", triggerId: "t-menu" });
    expect(old(db)["end_reason"]).toBe("superseded_by_trigger");
    expect(started).toEqual({ started: true, flowId: "flow-menu" });
    const fresh = runs(db).filter((r) => r["flow_id"] === "flow-menu" && r["id"] !== "run-1");
    expect(fresh).toHaveLength(1);
    const events = db
      .rows("flow_run_events")
      .filter((e) => e["run_id"] === fresh[0]!["id"])
      .map((e) => [e["event"], e["node_id"]]);
    expect(events[0]).toEqual(["started", "start"]);
    expect(events).toContainEqual(["entered", "btns"]);
  });

  it("an ask step's free-text wait is superseded too (only a buttons/list answer counts as an answer)", async () => {
    const db = world({ nodeId: "ask" });
    const graph = db.rows("flow_versions").find((v) => v["id"] === "ver-menu")![
      "graph"
    ] as typeof menuGraph;
    graph.nodes.push({ id: "ask", type: "ask", data: { text: "Your city?" } } as never);
    const { taken } = await inbound(db, "ZOORI FAM CARD");
    expect(taken.superseded?.flowId).toBe("flow-fam");
  });
});

describe("a reply to the waiting step is never a keyword", () => {
  it("a button tap (reply id) is the step's answer, even when its title is a keyword", async () => {
    const db = world({ triggers: [trigger("t-yes", "flow-fam", ["Yes"])] });
    const { taken } = await inbound(db, "Yes", "btns:yes");
    expect(taken.consumed).toBe(true);
    expect(old(db)["status"]).not.toBe("ended");
    expect(runs(db).some((r) => r["flow_id"] === "flow-fam")).toBe(false);
  });

  it("typed text that matches a button's title is that answer, not the keyword", async () => {
    const db = world({ triggers: [trigger("t-yes", "flow-fam", ["yes"])] });
    const { taken } = await inbound(db, "YES");
    expect(taken.consumed).toBe(true);
    expect(taken.superseded).toBeUndefined();
    expect(runs(db).some((r) => r["flow_id"] === "flow-fam")).toBe(false);
  });

  it("a keyword inside a longer message doesn't end the run (exact only, whatever the trigger's match mode)", async () => {
    const db = world({ triggers: [trigger("t-fam", "flow-fam", ["ZOORI FAM CARD"], "contains")] });
    const { taken } = await inbound(db, "I have the ZOORI FAM CARD");
    expect(taken.consumed).toBe(true);
    expect(old(db)["status"]).not.toBe("ended");
  });

  it("nothing ends when the keyword's flow couldn't start: not published, or a teammate owns the chat", async () => {
    const unpublished = world({ triggers: [trigger("t-x", "flow-missing", ["ZOORI FAM CARD"])] });
    expect((await inbound(unpublished, "ZOORI FAM CARD")).taken.consumed).toBe(true);
    expect(old(unpublished)["status"]).not.toBe("ended");

    const owned = world({ assigned: "u-staff" });
    expect((await inbound(owned, "ZOORI FAM CARD")).taken.consumed).toBe(true);
    expect(old(owned)["status"]).not.toBe("ended");
  });

  it("a disabled trigger's keyword is just a reply", async () => {
    const off = { ...trigger("t-fam", "flow-fam", ["ZOORI FAM CARD"]), is_enabled: false };
    const db = world({ triggers: [off] });
    expect((await inbound(db, "ZOORI FAM CARD")).taken.consumed).toBe(true);
    expect(old(db)["status"]).not.toBe("ended");
  });
});

describe("exactKeywordTrigger", () => {
  it("matches only whole keywords, highest priority first, on this number", async () => {
    const { exactKeywordTrigger } = await import("./flow-triggers.server");
    const rows = [
      trigger("low", "f1", ["card"], "contains", 0),
      trigger("high", "f2", ["Card"], "exact", 5),
      { ...trigger("pinned", "f3", ["card"]), flows: { whatsapp_account_id: "acc-2", config: {} } },
    ];
    expect(exactKeywordTrigger(rows, "CARD", "acc-1", null)?.id).toBe("high");
    expect(exactKeywordTrigger(rows, "my card", "acc-1", null)).toBeNull();
    expect(exactKeywordTrigger(rows, "card", "acc-1", "acc-2")?.id).toBe("pinned");
  });
});
