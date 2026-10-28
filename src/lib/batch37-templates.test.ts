import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ORG, OTHER_ORG, publicApiWorld } from "./test-support/public-api-world";
import { forgetApiEventsWanted } from "./public-api-webhooks.server";
import { processWebhookPayload } from "./whatsapp-webhook.server";

/**
 * Batch 37 item 5 — GET /api/v1/templates(/{name}) and the template events:
 * the workspace's templates on the API's number with what a send must fill
 * (by the send's own check), and template.status_changed /
 * template.category_changed from the existing Meta template handling, once
 * per notice. Another workspace's template is a 404. Fakes only.
 */

const h = vi.hoisted(() => ({
  world: null as null | ReturnType<typeof import("./test-support/public-api-world").publicApiWorld>,
}));
vi.mock("@/lib/whatsapp-webhook.server", async (orig) => ({
  ...(await orig<typeof import("./whatsapp-webhook.server")>()),
  getServiceClient: () => h.world!.db.supabase,
}));

import { Route as ListRoute } from "../routes/api/v1/templates/index";
import { Route as OneRoute } from "../routes/api/v1/templates/$name";

type Get = (a: { request: Request; params: Record<string, string> }) => Promise<Response>;
const GET = (route: unknown) =>
  (route as { options: { server: { handlers: { GET: Get } } } }).options.server.handlers.GET;

async function get(
  route: unknown,
  path: string,
  params: Record<string, string> = {},
  key = h.world!.keys.a,
) {
  const res = await GET(route)({
    request: new Request(`https://aidwar.in${path}`, {
      headers: { authorization: `Bearer ${key}` },
    }),
    params,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  h.world = publicApiWorld();
  forgetApiEventsWanted();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const t = h.world.db.rows("message_templates").find((r) => r["name"] === "invoice_pending")!;
  t["status"] = "REJECTED";
  t["rejection_reason"] = "INVALID_FORMAT";
});
afterEach(() => vi.restoreAllMocks());

describe("GET /api/v1/templates", () => {
  it("the workspace's templates with status, category, components, rejection reason and what a send fills", async () => {
    const res = await get(ListRoute, "/api/v1/templates");
    expect(res.status).toBe(200);
    const data = res.body["data"] as Array<Record<string, unknown>>;
    expect(data.map((t) => t["name"])).toEqual(["invoice_pending", "invoice_ready", "plain_hello"]);
    expect(data.find((t) => t["name"] === "invoice_ready")).toMatchObject({
      language: "en",
      category: "UTILITY",
      status: "APPROVED",
      rejection_reason: null,
      components: expect.any(Array),
      send: {
        header: { type: "document", required: true },
        body_params: 3,
        buttons: [],
        sendable: true,
      },
    });
    expect(data.find((t) => t["name"] === "invoice_pending")).toMatchObject({
      status: "REJECTED",
      rejection_reason: "INVALID_FORMAT",
      send: { sendable: false },
    });
    // Never another workspace's.
    expect(JSON.stringify(data)).not.toContain("b_invoice");
  });

  it("?status= filters; a bad status is 400", async () => {
    const approved = await get(ListRoute, "/api/v1/templates?status=approved");
    expect((approved.body["data"] as Array<{ name: string }>).map((t) => t.name)).toEqual([
      "invoice_ready",
      "plain_hello",
    ]);
    expect((await get(ListRoute, "/api/v1/templates?status=nope")).body["code"]).toBe(
      "invalid_filter",
    );
  });

  it("buttons say what they take; a carousel says why it can't be sent", async () => {
    h.world!.db.rows("message_templates").push(
      {
        id: "t-btn",
        organization_id: ORG,
        waba_id: "waba-a",
        name: "promo",
        language: "en",
        category: "MARKETING",
        status: "APPROVED",
        components: [
          { type: "BODY", text: "Sale" },
          {
            type: "BUTTONS",
            buttons: [
              { type: "URL", text: "Shop", url: "https://x.example.com/{{1}}" },
              { type: "QUICK_REPLY", text: "Stop" },
              { type: "PHONE_NUMBER", text: "Call", phone_number: "+91" },
            ],
          },
        ],
      },
      {
        id: "t-car",
        organization_id: ORG,
        waba_id: "waba-a",
        name: "cards",
        language: "en",
        category: "MARKETING",
        status: "APPROVED",
        components: [
          { type: "BODY", text: "Look" },
          {
            type: "CAROUSEL",
            cards: [
              {
                components: [
                  { type: "HEADER", format: "IMAGE" },
                  { type: "BODY", text: "A" },
                ],
              },
            ],
          },
        ],
      },
    );
    const promo = await get(OneRoute, "/api/v1/templates/promo", { name: "promo" });
    expect((promo.body["data"] as Array<Record<string, unknown>>)[0]!["send"]).toMatchObject({
      buttons: [
        { index: 0, type: "url", takes: "url_param", required: true },
        { index: 1, type: "quick_reply", takes: "payload", required: false },
        { index: 2, type: "phone_number", takes: null, required: false },
      ],
      sendable: true,
    });
    const cards = await get(OneRoute, "/api/v1/templates/cards", { name: "cards" });
    expect((cards.body["data"] as Array<Record<string, unknown>>)[0]!["send"]).toMatchObject({
      sendable: false,
      not_sendable_because: expect.stringMatching(/carousel/),
    });
  });
});

describe("GET /api/v1/templates/{name}", () => {
  it("every language of one template; another workspace's template is the same 404 as none", async () => {
    const one = await get(OneRoute, "/api/v1/templates/invoice_ready", { name: "invoice_ready" });
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({
      name: "invoice_ready",
      data: [{ language: "en", status: "APPROVED" }],
    });
    for (const [name, key] of [
      ["b_invoice", h.world!.keys.a],
      ["invoice_ready", h.world!.keys.b],
      ["nope", h.world!.keys.a],
    ] as const) {
      const res = await get(OneRoute, `/api/v1/templates/${name}`, { name }, key);
      expect([res.status, res.body["code"]], name).toEqual([404, "not_found"]);
    }
  });
});

describe("template.status_changed / template.category_changed from Meta's template webhook", () => {
  const notice = (field: string, value: Record<string, unknown>, time = 1793000000) => ({
    entry: [{ id: "waba-a", time, changes: [{ field, value }] }],
  });

  beforeEach(() => {
    const w = h.world!;
    w.db.rows("message_templates").find((t) => t["name"] === "invoice_ready")!["meta_template_id"] =
      "mt-1";
    w.db
      .rows("workspace_connections")
      .push({ id: "wc-1", organization_id: ORG, provider: "api_webhook", status: "active" });
  });
  const events = () => h.world!.db.rows("api_webhook_deliveries");

  it("a status change: the row moves and one event is queued, also when Meta repeats the notice", async () => {
    const payload = notice("message_template_status_update", {
      event: "PAUSED",
      message_template_id: "mt-1",
      message_template_name: "invoice_ready",
      message_template_language: "en",
    });
    await processWebhookPayload(h.world!.db.supabase, "ev-t1", payload);
    await processWebhookPayload(h.world!.db.supabase, "ev-t1", payload);
    expect(
      h.world!.db.rows("message_templates").find((t) => t["name"] === "invoice_ready")!["status"],
    ).toBe("PAUSED");
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      organization_id: ORG,
      event: "template.status_changed",
      message_id: null,
    });
    expect(events()[0]!["payload"]).toEqual({
      event: "template.status_changed",
      template: {
        name: "invoice_ready",
        language: "en",
        status: "PAUSED",
        category: "UTILITY",
        previous_status: "APPROVED",
        rejection_reason: null,
      },
      timestamp: new Date(1793000000 * 1000).toISOString(),
    });
  });

  it("a category change: the stored category follows (and with it the opt-out rule); one event", async () => {
    await processWebhookPayload(
      h.world!.db.supabase,
      "ev-t2",
      notice("template_category_update", {
        message_template_id: "mt-1",
        message_template_name: "invoice_ready",
        message_template_language: "en",
        previous_category: "UTILITY",
        new_category: "MARKETING",
      }),
    );
    expect(
      h.world!.db.rows("message_templates").find((t) => t["name"] === "invoice_ready")!["category"],
    ).toBe("MARKETING");
    expect(events().map((e) => e["event"])).toEqual(["template.category_changed"]);
    expect(events()[0]!["payload"]).toMatchObject({
      template: { name: "invoice_ready", category: "MARKETING", previous_category: "UTILITY" },
    });
    // A notice of a change still to come (no new_category) changes nothing.
    await processWebhookPayload(
      h.world!.db.supabase,
      "ev-t3",
      notice(
        "template_category_update",
        { message_template_id: "mt-1", correct_category: "UTILITY" },
        1793000100,
      ),
    );
    expect(
      h.world!.db.rows("message_templates").find((t) => t["name"] === "invoice_ready")!["category"],
    ).toBe("MARKETING");
    expect(events()).toHaveLength(1);
  });

  it("another workspace's WABA notice never reaches this workspace", async () => {
    await processWebhookPayload(h.world!.db.supabase, "ev-t4", {
      entry: [
        {
          id: "waba-b",
          time: 1793000000,
          changes: [
            {
              field: "message_template_status_update",
              value: { event: "REJECTED", message_template_name: "b_invoice" },
            },
          ],
        },
      ],
    });
    expect(
      h.world!.db.rows("message_templates").find((t) => t["name"] === "invoice_ready")!["status"],
    ).toBe("APPROVED");
    expect(events().filter((e) => e["organization_id"] === ORG)).toEqual([]);
    expect(
      h.world!.db.rows("message_templates").find((t) => t["organization_id"] === OTHER_ORG)![
        "status"
      ],
    ).toBe("REJECTED");
  });
});
