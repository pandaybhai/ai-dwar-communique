import { describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";

const h = vi.hoisted(() => ({ db: null as null | { supabase: unknown } }));
vi.mock("@/lib/segments.server", () => ({
  applySegment: (q: unknown) => q,
  segmentExpressions: async () => ({ match: "all", expressions: ["vip"] }),
}));
vi.mock("@/lib/whatsapp-api.server", () => ({
  requireOrgMember: async () => ({ supabase: h.db!.supabase, organizationId: "org", userId: "u1" }),
  requirePermission: async () => null,
  isResponse: (v: unknown) => v instanceof Response,
  jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
  graphFetch: async () => ({ ok: true, status: 200, body: {} }),
  graphErrorMessage: () => "error",
  logServerActivity: async () => {},
}));

vi.mock("@/lib/whatsapp-numbers.server", () => ({
  getWhatsAppConnection: async () => ({
    connection: { accountId: "acc", wabaId: "waba", phoneNumberId: "pn", accessToken: "t" },
    error: null,
  }),
}));

import {
  audienceSummary,
  isSegmentNotFound,
  resolveAudienceContacts,
  SegmentNotFoundError,
} from "./campaigns.server";
import { Route as AudienceRoute } from "../routes/api/campaigns/audience";
import { Route as LaunchRoute } from "../routes/api/campaigns/launch";

const CONTACTS = [{ id: "c1", name: "Asha", phone: "+919800000001", attributes: null }];

const world = (segment: "found" | "missing" | "error") =>
  fakeDb((op: FakeOp) => {
    if (op.table === "segments") {
      if (segment === "error") return { data: null, error: { message: "db down" } };
      return { data: segment === "found" ? { id: "seg-1", filters: { match: "all" } } : null, error: null };
    }
    if (op.table === "contacts") return { data: CONTACTS, error: null, count: 1 } as never;
    if (op.table === "organizations") return { data: { plan_status: "active" }, error: null };
    if (op.table === "message_templates")
      return { data: { name: "promo", language: "en", components: [], status: "APPROVED" }, error: null };
    return undefined;
  });

const contactReads = (db: ReturnType<typeof world>) => db.ops.filter((op) => op.table === "contacts");

describe("(2) a segment id that names no segment never widens to everyone", () => {
  it("launch audience: rejected with a clear message, no contact is read", async () => {
    const db = world("missing");
    const err = await resolveAudienceContacts(db.supabase, "org", "seg-gone").catch((e) => e);
    expect(isSegmentNotFound(err)).toBe(true);
    expect((err as Error).message).toMatch(/segment no longer exists/);
    expect(contactReads(db)).toHaveLength(0);
  });

  it("estimate/summary: rejected the same way", async () => {
    const db = world("missing");
    await expect(audienceSummary(db.supabase, "org", "seg-gone")).rejects.toBeInstanceOf(SegmentNotFoundError);
    expect(contactReads(db)).toHaveLength(0);
  });

  it("a failed segment read is an error too, never 'everyone'", async () => {
    const db = world("error");
    const err = await resolveAudienceContacts(db.supabase, "org", "seg-1").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isSegmentNotFound(err)).toBe(false);
    expect(contactReads(db)).toHaveLength(0);
  });

  it("the audience route answers 404 with the message", async () => {
    h.db = world("missing");
    type Post = (a: { request: Request }) => Promise<Response>;
    const post = (AudienceRoute.options as unknown as { server: { handlers: { POST: Post } } }).server
      .handlers.POST;
    const res = await post({
      request: new Request("http://x/api/campaigns/audience", {
        method: "POST",
        body: JSON.stringify({ organization_id: "org", segment_id: "seg-gone" }),
      }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/choose all contacts/);
  });

  it("the launch route answers 404 and creates no campaign", async () => {
    const db = world("missing");
    h.db = db;
    type Post = (a: { request: Request }) => Promise<Response>;
    const post = (LaunchRoute.options as unknown as { server: { handlers: { POST: Post } } }).server
      .handlers.POST;
    const res = await post({
      request: new Request("http://x/api/campaigns/launch", {
        method: "POST",
        body: JSON.stringify({ organization_id: "org", name: "Diwali", template_name: "promo", segment_id: "seg-gone" }),
      }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/segment no longer exists/);
    expect(db.ops.some((op) => op.table === "campaigns")).toBe(false);
    expect(contactReads(db)).toHaveLength(0);
  });

  it("unchanged: no segment id is the explicit 'all contacts' choice", async () => {
    const db = world("missing");
    const out = await resolveAudienceContacts(db.supabase, "org", null);
    expect(out).toEqual(CONTACTS);
    expect(db.ops.some((op) => op.table === "segments")).toBe(false);
  });

  it("unchanged: a segment that exists resolves its contacts", async () => {
    const db = world("found");
    const out = await resolveAudienceContacts(db.supabase, "org", "seg-1");
    expect(out).toEqual(CONTACTS);
    expect(db.has(db.ops.find((op) => op.table === "segments")!, "eq", "organization_id", "org")).toBe(true);
  });
});
