import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type MemoryDb } from "./test-support/memory-db";
import { fakeStorage, withStorage } from "./test-support/fake-storage";
import { mediaGoneNote, mediaSource } from "../components/inbox/inbox-utils";

/**
 * Batch 32 (2) — serve it. A kept customer file ("storage:chat-media/…") is
 * streamed only to a member of its workspace or a platform super admin; a
 * non-member gets the same 404 as a missing file; there is never a public or
 * signed link. Fakes only.
 */

const h = vi.hoisted(() => ({ db: null as null | MemoryDb, storage: null as null | ReturnType<typeof import("./test-support/fake-storage").fakeStorage> }));

vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.db!.supabase }));

import { Route as ChatMediaRoute } from "../routes/api/whatsapp/chat-media.$messageId";
import { Route as MetaMediaRoute } from "../routes/api/whatsapp/media/$id";

type Get = (a: { request: Request; params: Record<string, string> }) => Promise<Response>;
const getOf = (r: unknown) => (r as { options: { server: { handlers: { GET: Get } } } }).options.server.handlers.GET;

const ORG = "org-zoori";
const PATH = `${ORG}/cv1/m1.jpg`;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);

beforeEach(() => {
  h.db = memoryDb({
    organization_members: [{ organization_id: ORG, user_id: "u-member", role: "agent", created_at: "2026-01-01T00:00:00Z" }],
    profiles: [
      { id: "u-member", is_super_admin: false },
      { id: "u-admin", is_super_admin: true },
      { id: "u-other", is_super_admin: false },
    ],
    messages: [
      { id: "m1", organization_id: ORG, direction: "inbound", media_url: `storage:chat-media/${PATH}`, media_mime: "image/jpeg" },
      { id: "m2", organization_id: ORG, direction: "inbound", media_url: "meta:media-2", media_mime: "image/jpeg" },
      { id: "m3", organization_id: ORG, direction: "inbound", media_url: "storage:chat-media/x/y/m3.html", media_mime: "text/html" },
    ],
  });
  // Tokens are user ids here.
  (h.db.supabase as unknown as { auth: unknown }).auth = {
    getUser: async (token: string) =>
      token.startsWith("u-") ? { data: { user: { id: token } }, error: null } : { data: { user: null }, error: { message: "bad jwt" } },
  };
  h.storage = fakeStorage();
  h.storage.objects("chat-media").set(PATH, { bytes: JPEG, contentType: "image/jpeg" });
  h.storage.objects("chat-media").set("x/y/m3.html", { bytes: new TextEncoder().encode("<script>x</script>"), contentType: "text/html" });
  withStorage(h.db.supabase, h.storage);
});

const get = (messageId: string, token?: string) =>
  getOf(ChatMediaRoute)({
    request: new Request(`https://aidwar.in/api/whatsapp/chat-media/${messageId}`, token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    params: { messageId },
  });

describe("(2) serve it", () => {
  it("a member of the workspace gets the bytes, private and never sniffed", async () => {
    const res = await get("m1", "u-member");
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("super admin can read a workspace's file without being a member", async () => {
    const res = await get("m1", "u-admin");
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG);
  });

  it("non-member cannot: the same 404 as a file that doesn't exist, and storage is never read", async () => {
    const res = await get("m1", "u-other");
    expect(res.status).toBe(404);
    const missing = await get("nope", "u-other");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual(await (await get("m1", "u-other")).json());
    expect(h.storage!.calls.filter((c) => c.op === "download")).toEqual([]);
  });

  it("no token or a bad token: 401 before anything is read", async () => {
    expect((await get("m1")).status).toBe(401);
    expect((await get("m1", "forged")).status).toBe(401);
    expect(h.db!.log.filter((l) => l.table === "messages")).toEqual([]);
  });

  it("a row still on meta: is not served by this route (the Meta route handles it)", async () => {
    expect((await get("m2", "u-member")).status).toBe(404);
  });

  it("a stored HTML file downloads sandboxed, never inline", async () => {
    const res = await get("m3", "u-member");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe("attachment");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
  });

  it("the Meta fallback route also lets a super admin in (and still refuses a non-member)", async () => {
    const call = (token: string) =>
      getOf(MetaMediaRoute)({
        request: new Request(`https://aidwar.in/api/whatsapp/media/media-2?organization_id=${ORG}`, {
          headers: { authorization: `Bearer ${token}` },
        }),
        params: { id: "media-2" },
      });
    // Past the access check, the super admin reaches the number lookup (none connected here).
    expect((await call("u-admin")).status).not.toBe(403);
    expect((await call("u-other")).status).toBe(403);
  });

  it("no public link: the chat-media code never asks storage for a public or signed URL", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["./chat-media.server.ts", "../routes/api/whatsapp/chat-media.$messageId.ts"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      expect(src).not.toMatch(/getPublicUrl|createSignedUrl/);
    }
  });
});

describe("(2) the inbox bubble picks the right source", () => {
  it("storage: -> our chat-media route by message id; meta: -> the Meta route, unchanged; http -> the URL itself", () => {
    expect(mediaSource({ id: "m1", media_url: `storage:chat-media/${PATH}` }, ORG)).toEqual({ kind: "fetch", path: "/api/whatsapp/chat-media/m1" });
    expect(mediaSource({ id: "m2", media_url: "meta:media-2" }, ORG)).toEqual({
      kind: "fetch",
      path: `/api/whatsapp/media/media-2?organization_id=${ORG}`,
    });
    const url = "https://x.supabase.co/storage/v1/object/public/product-images/a.jpg";
    expect(mediaSource({ id: "m4", media_url: url }, ORG)).toEqual({ kind: "url", url });
    expect(mediaSource({ id: "m5", media_url: null }, ORG)).toBeNull();
  });

  it("an expired Meta file and a removed old file say so instead of a grey box", () => {
    expect(mediaGoneNote({ media_url: "meta:x", metadata: { media_expired: true } })).toBe(
      "This file expired on WhatsApp before it could be saved.",
    );
    expect(mediaGoneNote({ media_url: null, metadata: { media_removed_at: "2027-10-27T00:00:00Z" } })).toBe("Older file removed");
    expect(mediaGoneNote({ media_url: "storage:chat-media/a/b/c.jpg", metadata: { meta_media_id: "x" } })).toBeNull();
  });
});
