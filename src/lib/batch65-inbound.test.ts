import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeOp } from "./test-support/fake-db";
import { inboundPayload, latencyWorld } from "./test-support/latency-world";
import { processWebhookPayload, resetBurstWindowCache } from "./whatsapp-webhook.server";

/**
 * Batch 65 checklist item 1 — the Public API's new phone rule never runs on
 * inbound WhatsApp messages: Meta's wa_id has no "+" and can be 10 digits
 * (Singapore 6591234567), and the webhook still finds the conversation by
 * the same E.164 string, creates the contact with the same phone and wa_id,
 * and stores the message. This file imports nothing from Batch 65 and passes
 * on main before it, unchanged. Fakes only.
 */

beforeEach(() => resetBurstWindowCache());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function inboundFrom(waId: string): Promise<FakeOp[]> {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const w = latencyWorld({
    org: "org-a",
    rttMs: 0,
    graphMs: 0,
    waitingRun: false,
    override: (op) => (op.table === "flow_triggers" ? { data: [], error: null } : undefined),
  });
  vi.stubGlobal("fetch", w.fetchStub);
  const payload = inboundPayload({
    id: `wamid.${waId}`,
    type: "text",
    text: { body: "hi" },
  }) as unknown as {
    entry: Array<{ changes: Array<{ value: Record<string, Array<Record<string, unknown>>> }> }>;
  };
  const value = payload.entry[0]!.changes[0]!.value;
  value["contacts"] = [{ wa_id: waId, profile: { name: "Mei" } }];
  value["messages"]![0]!["from"] = waId;
  await processWebhookPayload(w.supabase, `ev-${waId}`, payload);
  return w.ops;
}

describe("inbound messages keep their own number handling", () => {
  it.each([
    ["6591234567", "+6591234567"],
    ["919876543210", "+919876543210"],
    ["18133043903", "+18133043903"],
  ])(
    "from %s: the conversation is looked up and the contact saved as %s, and the message stored",
    async (waId, e164) => {
      const ops = await inboundFrom(waId);
      const lookup = ops.find((o) => o.table === "conversations" && o.kind === "select")!;
      expect(lookup.filters).toContainEqual(["eq", ["contacts.phone", e164]]);
      const contact = ops.find((o) => o.table === "contacts" && o.kind === "upsert")!;
      expect(contact.payload).toMatchObject({ phone: e164, wa_id: waId, name: "Mei" });
      const message = ops.find((o) => o.table === "messages" && o.kind === "upsert")!;
      expect(message.payload).toMatchObject({
        meta_message_id: `wamid.${waId}`,
        direction: "inbound",
        body: "hi",
      });
    },
  );
});
