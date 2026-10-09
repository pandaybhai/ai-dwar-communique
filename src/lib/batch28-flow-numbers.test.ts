import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";

/**
 * Batch 28 item 4 — "Appointment request" (keyword "book", exact, enabled,
 * flows.whatsapp_account_id NULL) never ran. The only caller that passes
 * onlyAccountId is the webhook's onboarding-number branch (the AiDwar setup
 * number), where only flows pinned to that number run; on every customer
 * number it is null and an unpinned flow starts. These tests pin that down,
 * and the editor now says so when such a flow is saved in the platform
 * workspace.
 */

const startRun = vi.fn(async (_db: unknown, _a: { flowId: string }) => ({ runId: "run-new", reason: null as string | null }));
vi.mock("@/lib/flow-engine.server", () => ({
  startRun: (db: unknown, a: { flowId: string }) => startRun(db, a),
  flowsV2Enabled: async () => true,
  readPublishedVersion: async () => null,
}));

import { dispatchInboundTriggers } from "./flow-triggers.server";
import { unpinnedFlowNote } from "./flow-trigger-config";

beforeEach(() => startRun.mockClear());

const SETUP = "acc-setup";
const triggers = [
  { id: "t-book", flow_id: "flow-book", kind: "keyword", config: { keywords: ["book"], match: "exact" }, flows: { whatsapp_account_id: null } },
  { id: "t-menu", flow_id: "flow-menu", kind: "keyword", config: { keywords: ["menu"], match: "exact" }, flows: { whatsapp_account_id: SETUP } },
];
const world = () =>
  fakeDb((op: FakeOp) => {
    if (op.table === "flow_triggers") return { data: triggers, error: null };
    if (op.table === "conversations") return { data: [], error: null };
    return undefined;
  });
const base = { organizationId: "org", contactId: "c1", conversationId: "cv1", isFirstMessageEver: false, isCtwa: false, campaignButton: null };

describe("item 4 — which number a flow starts on", () => {
  it("an unpinned flow starts on every customer number of its workspace (onlyAccountId null)", async () => {
    for (const accountId of ["acc-a", "acc-b"]) {
      startRun.mockClear();
      expect(await dispatchInboundTriggers(world().supabase, { ...base, body: "book", accountId, onlyAccountId: null })).toEqual({
        started: true,
        flowId: "flow-book",
      });
    }
  });

  it("on the AiDwar setup number only flows pinned to it start (unpinned 'book' does not; pinned 'menu' does)", async () => {
    const onSetup = { ...base, accountId: SETUP, onlyAccountId: SETUP };
    expect(await dispatchInboundTriggers(world().supabase, { ...onSetup, body: "book" })).toEqual({ started: false });
    expect(await dispatchInboundTriggers(world().supabase, { ...onSetup, body: "menu" })).toEqual({ started: true, flowId: "flow-menu" });
  });

  it("a flow pinned to one number never starts on another", async () => {
    expect(await dispatchInboundTriggers(world().supabase, { ...base, body: "menu", accountId: "acc-a", onlyAccountId: null })).toEqual({ started: false });
  });

  it("the webhook passes onlyAccountId only on the onboarding number", () => {
    const src = readFileSync(join(__dirname, "whatsapp-webhook.server.ts"), "utf8");
    const passes = [...src.matchAll(/onlyAccountId: ([^,\n]+),/g)].map((m) => m[1]!.trim());
    expect(passes.sort()).toEqual(["args.onlyAccountId", "isCustomerNumber ? null : onboardingAccountId", "null", "onboardingAccountId"].sort());
  });

  it("the editor says so when an unpinned flow is saved in the workspace that owns the setup number", () => {
    const setup = { label: "+91 90000 00001", onboarding: true };
    const shop = { label: "+91 90000 00002", onboarding: false };
    expect(unpinnedFlowNote([shop], null)).toBeNull();
    expect(unpinnedFlowNote([setup, shop], SETUP)).toBeNull();
    expect(unpinnedFlowNote([setup, shop], null)).toMatch(/not on the AiDwar setup number \(\+91 90000 00001\)/);
    expect(unpinnedFlowNote([setup], null)).toMatch(/won't start anywhere/);
    const editor = readFileSync(join(__dirname, "../components/flows/v2/flow-editor.tsx"), "utf8");
    expect(editor.match(/unpinnedFlowNote\(/g)?.length).toBe(3); // save, publish, number change
  });
});
