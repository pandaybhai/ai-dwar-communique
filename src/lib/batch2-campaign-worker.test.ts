import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";

const h = vi.hoisted(() => ({
  db: null as null | { supabase: unknown },
  sendCampaignTemplate: vi.fn(async () => ({ error: null, messageId: "msg-1" })),
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.db!.supabase }));
vi.mock("@/lib/campaigns.server", () => ({
  sendCampaignTemplate: h.sendCampaignTemplate,
  loadSenderContext: async () => ({
    accountId: "acc",
    wabaId: "waba",
    phoneNumberId: "pn",
    accessToken: "t",
  }),
}));
vi.mock("@/lib/campaign-billing.server", () => ({
  holdCampaign: async () => ({ ok: true }),
  settleCampaignSpend: async () => ({ ok: true }),
}));
vi.mock("@/lib/events.server", () => {
  const noop = async () => {};
  return { emitEvent: noop };
});

import { Route } from "../routes/api/internal/campaign-worker";

type Post = (a: { request: Request }) => Promise<Response>;
const post = (Route.options as unknown as { server: { handlers: { POST: Post } } }).server.handlers
  .POST;

const recipients = [
  { id: "r-out", contact_id: "c-out", phone: "+919800000001", resolved_variables: {} },
  { id: "r-in", contact_id: "c-in", phone: "+919800000002", resolved_variables: {} },
];
const idOf = (op: FakeOp) => op.filters.find(([n, a]) => n === "eq" && a[0] === "id")?.[1][1];

async function run(contacts: (op: FakeOp) => { data: unknown; error: { message: string } | null }) {
  const db = fakeDb(
    (op) => {
      if (op.table === "campaigns" && op.kind === "select")
        return {
          data: [
            {
              id: "camp",
              organization_id: "org",
              whatsapp_account_id: "acc",
              status: "sending",
              template_name: "promo",
              template_language: "en",
              send_settings: {},
            },
          ],
          error: null,
        };
      if (op.table === "contacts") return contacts(op);
      // Recipients still queued, so the campaign isn't completed in these tests.
      if (op.table === "campaign_recipients" && op.kind === "select")
        return { data: null, error: null, count: 1 } as never;
      return undefined;
    },
    (call) =>
      call.name === "claim_campaign_recipients" ? { data: recipients, error: null } : undefined,
  );
  h.db = db;
  process.env["CRON_SECRET"] = "s";
  const res = await post({
    request: new Request("http://x", { method: "POST", headers: { "x-cron-secret": "s" } }),
  });
  expect(res.status).toBe(200);
  return db;
}
const recipientWrites = (db: ReturnType<typeof fakeDb>) =>
  db.ops
    .filter((o) => o.table === "campaign_recipients" && o.kind === "update")
    .map((o) => [idOf(o), o.payload]);

beforeEach(() => h.sendCampaignTemplate.mockClear());

describe("(C) campaign worker re-checks opt-out right before each send", () => {
  it("an opted-out recipient is skipped and never sent; the rest still go", async () => {
    const db = await run((op) => ({
      data: { opt_in_status: idOf(op) === "c-out" ? "opted_out" : "opted_in" },
      error: null,
    }));
    expect(h.sendCampaignTemplate).toHaveBeenCalledTimes(1);
    expect((h.sendCampaignTemplate.mock.calls[0] as unknown[])[3]).toMatchObject({
      contactId: "c-in",
    });
    expect(recipientWrites(db)).toEqual([
      ["r-out", { status: "skipped", error: "opted_out" }],
      ["r-in", { status: "sent", message_id: "msg-1", error: null }],
    ]);
    expect(db.rpcs.find((r) => r.name === "bump_campaign_counters")!.args).toMatchObject({
      p_sent: 1,
      p_failed: 0,
    });
  });

  it("a failed opt-out check sends nothing to that recipient", async () => {
    const db = await run(() => ({ data: null, error: { message: "down" } }));
    expect(h.sendCampaignTemplate).not.toHaveBeenCalled();
    expect(recipientWrites(db).map(([, p]) => p)).toEqual([
      { status: "failed", error: "opt_out_check_failed" },
      { status: "failed", error: "opt_out_check_failed" },
    ]);
  });

  it("unchanged: recipients who haven't opted out are all sent", async () => {
    const db = await run(() => ({ data: { opt_in_status: "unknown" }, error: null }));
    expect(h.sendCampaignTemplate).toHaveBeenCalledTimes(2);
    expect(recipientWrites(db).map(([, p]) => (p as { status: string }).status)).toEqual([
      "sent",
      "sent",
    ]);
  });
});
