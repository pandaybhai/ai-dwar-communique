import { beforeEach, describe, expect, it, vi } from "vitest";
import { ORG, OTHER_ORG, publicApiWorld } from "./test-support/public-api-world";
import { publicError, publicStatus } from "./public-api-messages.server";

/**
 * Batch 34 item 3 — GET /api/v1/messages/{message_id}: the status and times
 * of a message the API sent, only in the key's own workspace. Another
 * workspace's id, an inbox message and a made-up id all read the same 404.
 * Fakes only.
 */

const h = vi.hoisted(() => ({
  world: null as null | ReturnType<typeof import("./test-support/public-api-world").publicApiWorld>,
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.world!.db.supabase }));

import { Route } from "../routes/api/v1/messages/$messageId";

type Get = (a: { request: Request; params: Record<string, string> }) => Promise<Response>;
const GET = (Route as unknown as { options: { server: { handlers: { GET: Get } } } }).options.server
  .handlers.GET;

async function status(id: string, key = h.world!.keys.a) {
  const res = await GET({
    request: new Request(`https://aidwar.in/api/v1/messages/${id}`, {
      headers: { authorization: `Bearer ${key}` },
    }),
    params: { messageId: id },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  h.world = publicApiWorld();
  h.world.db.rows("messages").push(
    {
      id: "m-api",
      organization_id: ORG,
      direction: "outbound",
      type: "template",
      template_name: "invoice_ready",
      meta_message_id: "wamid.1",
      status: "delivered",
      status_updated_at: "2026-10-27T10:00:05Z",
      created_at: "2026-10-27T10:00:00Z",
      metadata: {
        source: "api",
        api_key_id: "key-a",
        idempotency_key: "inv-1",
        to: "+919876543210",
      },
    },
    {
      id: "m-failed",
      organization_id: ORG,
      direction: "outbound",
      type: "template",
      template_name: "invoice_ready",
      status: "failed",
      error_detail: JSON.stringify([
        {
          code: 131026,
          title: "Message undeliverable",
          error_data: { details: "Receiver is incapable of receiving this message" },
        },
      ]),
      created_at: "2026-10-27T10:00:00Z",
      metadata: { source: "api", to: "+919800000001" },
    },
    {
      id: "m-inbox",
      organization_id: ORG,
      direction: "outbound",
      type: "text",
      status: "read",
      created_at: "2026-10-27T10:00:00Z",
      metadata: null,
    },
    {
      id: "m-other",
      organization_id: OTHER_ORG,
      direction: "outbound",
      type: "template",
      status: "sent",
      created_at: "2026-10-27T10:00:00Z",
      metadata: { source: "api" },
    },
  );
});

describe("GET /api/v1/messages/{id}", () => {
  it("an API message of this workspace: its status, number, template, key and times", async () => {
    const res = await status("m-api");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      message_id: "m-api",
      status: "delivered",
      to: "+919876543210",
      template_name: "invoice_ready",
      idempotency_key: "inv-1",
      wamid: "wamid.1",
      error: null,
      created_at: "2026-10-27T10:00:00Z",
      updated_at: "2026-10-27T10:00:05Z",
    });
  });

  it("a failed one says why", async () => {
    const res = await status("m-failed");
    expect(res.body).toMatchObject({
      status: "failed",
      error: { code: "131026", message: "Receiver is incapable of receiving this message" },
    });
  });

  it("another workspace's message id is 404 — the same answer as an id that doesn't exist or an inbox message", async () => {
    const other = await status("m-other");
    expect(other.status).toBe(404);
    expect(await status("nope")).toEqual(other);
    expect(await status("m-inbox")).toEqual(other);
    expect(await status("../etc")).toEqual(other);
    // B's key sees B's message, and not A's.
    expect((await status("m-other", h.world!.keys.b)).status).toBe(200);
    expect((await status("m-api", h.world!.keys.b)).status).toBe(404);
  });

  it("needs a live key", async () => {
    expect((await status("m-api", h.world!.keys.revoked)).status).toBe(401);
  });

  it("status words", () => {
    expect(["pending", null, "sent", "delivered", "read", "failed"].map(publicStatus)).toEqual([
      "queued",
      "queued",
      "sent",
      "delivered",
      "read",
      "failed",
    ]);
    expect(publicError("read", "x")).toBeNull();
    expect(
      publicError(
        "failed",
        JSON.stringify({ message: "(#100) bad", code: 100, error_user_msg: null }),
      ),
    ).toEqual({ code: "100", message: "(#100) bad" });
  });
});
