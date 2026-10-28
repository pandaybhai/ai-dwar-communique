import { beforeEach, describe, expect, it, vi } from "vitest";
import { batch38World, call, ORG, OTHER_ORG } from "./test-support/batch38-world";
import { forgetWorkspacePlans } from "./public-api-plans.server";

/**
 * Batch 38 item 2 — inbox actions from the Public API: the same column
 * writes the inbox makes (assigned_to, status, the customer's tags), the
 * same activity actions marked source "api" with the key id, only members
 * as assignees, only the key's own workspace's conversations.
 */

const h = vi.hoisted(() => ({
  world: null as null | ReturnType<typeof import("./test-support/batch38-world").batch38World>,
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.world!.db.supabase }));

import { Route as ListRoute } from "../routes/api/v1/conversations/index";
import { Route as AssignRoute } from "../routes/api/v1/conversations/$phone.assign";
import { Route as CloseRoute } from "../routes/api/v1/conversations/$phone.close";
import { Route as ReopenRoute } from "../routes/api/v1/conversations/$phone.reopen";
import { Route as TagsRoute } from "../routes/api/v1/conversations/$phone.tags";

const rows = (t: string) => h.world!.db.rows(t);
const keyA = () => h.world!.keys.a;

const post = (route: unknown, action: string, phone: string, body?: unknown, key = keyA()) =>
  call(route, "POST", `/api/v1/conversations/${encodeURIComponent(phone)}/${action}`, {
    key,
    body: body ?? {},
    params: { phone },
  });

const conv = (id: string) => rows("conversations").find((c) => c["id"] === id)!;

beforeEach(() => {
  h.world = batch38World();
  forgetWorkspacePlans();
  rows("conversations").push(
    { id: "conv-1-old", organization_id: ORG, contact_id: "c1", whatsapp_account_id: "acc-a", status: "closed", assigned_to: null, last_message_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" },
    { id: "conv-1", organization_id: ORG, contact_id: "c1", whatsapp_account_id: "acc-a", status: "open", assigned_to: null, last_message_at: "2026-10-10T00:00:00Z", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-10T00:00:00Z" },
    { id: "conv-2", organization_id: ORG, contact_id: "c2", whatsapp_account_id: "acc-a", status: "open", assigned_to: "u-agent", last_message_at: "2026-10-11T00:00:00Z", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-11T00:00:00Z" },
    { id: "conv-b", organization_id: OTHER_ORG, contact_id: "cb1", whatsapp_account_id: "acc-b", status: "open", assigned_to: null, last_message_at: "2026-10-12T00:00:00Z", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-12T00:00:00Z" },
  );
});

describe("assign", () => {
  it("by email (any case) or user id: the customer's latest conversation, logged with source api", async () => {
    const res = await post(AssignRoute, "assign", "+91 98000 00001", { assignee: "AGENT@shop-a.example" });
    expect(res.status).toBe(200);
    expect(res.body["conversation"]).toMatchObject({
      conversation_id: "conv-1",
      phone: "+919800000001",
      assignee: { user_id: "u-agent", email: "Agent@Shop-A.example" },
    });
    expect(conv("conv-1")["assigned_to"]).toBe("u-agent");
    expect(conv("conv-1-old")["assigned_to"]).toBeNull();
    expect(rows("activity_log").at(-1)).toMatchObject({
      organization_id: ORG,
      user_id: null,
      action: "conversation_assigned",
      details: { conversation_id: "conv-1", assigned_to: "u-agent", source: "api", api_key_id: "key-a" },
    });
    expect(rows("analytics_events").at(-1)).toMatchObject({ event_type: "conversation.assigned" });

    const byId = await post(AssignRoute, "assign", "919800000001", { assignee: "u-admin" });
    expect(byId.status).toBe(200);
    expect(conv("conv-1")["assigned_to"]).toBe("u-admin");
    const unassign = await post(AssignRoute, "assign", "919800000001", { assignee: null });
    expect(unassign.status).toBe(200);
    expect(conv("conv-1")["assigned_to"]).toBeNull();
  });

  it("someone who isn't a member of this workspace is refused, by email or id — even a member of another workspace", async () => {
    for (const who of ["owner@shop-b.example", "u-b", "stranger@example.com"]) {
      const res = await post(AssignRoute, "assign", "+919800000001", { assignee: who });
      expect(res.status).toBe(400);
      expect(res.body["code"]).toBe("assignee_not_member");
    }
    expect(conv("conv-1")["assigned_to"]).toBeNull();
    expect(rows("activity_log")).toHaveLength(0);
  });

  it("another workspace's customer is a 404 and nothing changes", async () => {
    // +919800000001 is also workspace B's contact; B's key reaches only B's conversation.
    const res = await post(AssignRoute, "assign", "+919811111111", { assignee: "u-agent" });
    expect(res.status).toBe(404);
    const fromB = await post(AssignRoute, "assign", "+919800000001", { assignee: "u-agent" }, h.world!.keys.b);
    expect(fromB.status).toBe(400); // u-agent isn't B's member
    expect(conv("conv-b")["assigned_to"]).toBeNull();
    const bOwn = await post(AssignRoute, "assign", "+919800000001", { assignee: "u-b" }, h.world!.keys.b);
    expect(bOwn.status).toBe(200);
    expect(conv("conv-b")["assigned_to"]).toBe("u-b");
    expect(conv("conv-1")["assigned_to"]).toBeNull();
  });
});

describe("close and reopen", () => {
  it("close then reopen: the inbox's status writes; a repeat is the same 200 and logs nothing more", async () => {
    const closed = await post(CloseRoute, "close", "+919800000001");
    expect(closed.status).toBe(200);
    expect((closed.body["conversation"] as Record<string, unknown>)["status"]).toBe("closed");
    expect(conv("conv-1")["status"]).toBe("closed");
    await post(CloseRoute, "close", "+919800000001");
    expect(rows("activity_log").map((a) => a["action"])).toEqual(["conversation_closed"]);
    expect(rows("activity_log")[0]!["details"]).toMatchObject({ source: "api", api_key_id: "key-a" });

    const reopened = await post(ReopenRoute, "reopen", "+919800000001");
    expect(reopened.status).toBe(200);
    expect(conv("conv-1")["status"]).toBe("open");
    expect(rows("activity_log").map((a) => a["action"])).toEqual(["conversation_closed", "conversation_reopened"]);
  });

  it("another workspace's conversation can't be closed", async () => {
    const res = await post(CloseRoute, "close", "+919800000001", {}, h.world!.keys.a);
    expect(res.status).toBe(200);
    expect(conv("conv-b")["status"]).toBe("open");
  });
});

describe("tags", () => {
  it("adds (creating a new tag) and removes, matching names without regard to case", async () => {
    const res = await post(TagsRoute, "tags", "+919800000001", { add: ["Gold", "vip"], remove: [] });
    expect(res.status).toBe(200);
    expect((res.body["conversation"] as Record<string, unknown>)["tags"]).toEqual(["Gold", "VIP"]);
    expect(rows("tags").filter((t) => t["organization_id"] === ORG).map((t) => t["name"])).toEqual(["VIP", "Gold"]);
    const removed = await post(TagsRoute, "tags", "+919800000001", { remove: ["VIP", "never-had"] });
    expect((removed.body["conversation"] as Record<string, unknown>)["tags"]).toEqual(["Gold"]);
    // Workspace B's "vip" link is untouched.
    expect(rows("contact_tags").some((l) => l["organization_id"] === OTHER_ORG && l["tag_id"] === "tag-b")).toBe(true);
    expect(rows("activity_log").at(-1)).toMatchObject({ action: "contact_tags_changed", details: { source: "api" } });
  });

  it("refuses an empty change", async () => {
    const res = await post(TagsRoute, "tags", "+919800000001", { add: [] });
    expect(res.body["code"]).toBe("invalid_tags");
  });
});

describe("GET /api/v1/conversations", () => {
  const list = (query: string) => call(ListRoute, "GET", `/api/v1/conversations${query}`, { key: keyA() });

  it("oldest change first, a page at a time, only this workspace, with contact, assignee and tags", async () => {
    const first = await list("?limit=2");
    expect(first.status).toBe(200);
    const page1 = first.body["conversations"] as Array<Record<string, unknown>>;
    expect(page1.map((c) => c["conversation_id"])).toEqual(["conv-1-old", "conv-1"]);
    expect(page1[1]).toMatchObject({ phone: "+919800000001", contact: { name: "Asha" }, tags: ["VIP"] });
    const second = await list(`?limit=2&cursor=${first.body["next_cursor"]}`);
    const page2 = second.body["conversations"] as Array<Record<string, unknown>>;
    expect(page2.map((c) => c["conversation_id"])).toEqual(["conv-2"]);
    expect(page2[0]).toMatchObject({ assignee: { user_id: "u-agent", email: "Agent@Shop-A.example" } });
    expect(second.body["next_cursor"]).toBeNull();
  });

  it("filters by status, assignee (email, or none) and updated_since", async () => {
    const ids = async (q: string) =>
      ((await list(q)).body["conversations"] as Array<Record<string, unknown>>).map((c) => c["conversation_id"]);
    expect(await ids("?status=closed")).toEqual(["conv-1-old"]);
    expect(await ids("?assignee=agent@shop-a.example")).toEqual(["conv-2"]);
    expect(await ids("?assignee=none")).toEqual(["conv-1-old", "conv-1"]);
    expect(await ids("?updated_since=2026-10-10T12:00:00Z")).toEqual(["conv-2"]);
    expect((await list("?assignee=owner@shop-b.example")).body["code"]).toBe("assignee_not_member");
    expect((await list("?status=archived")).body["code"]).toBe("invalid_status");
  });

  it("before 20261160 (no api_list_conversations) it answers 503, never a wrong list", async () => {
    h.world!.sql.applied = false;
    const res = await list("");
    expect(res.status).toBe(503);
    expect(res.body["code"]).toBe("unavailable");
  });
});
