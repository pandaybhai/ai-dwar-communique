import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FakeOp } from "./test-support/fake-db";
import { fakeStorage, withStorage } from "./test-support/fake-storage";
import { inboundPayload, latencyWorld } from "./test-support/latency-world";
import { processWebhookPayload, resetBurstWindowCache } from "./whatsapp-webhook.server";

/**
 * Batch 32 — keep customer media.
 *  (1) save on arrival: an inbound file is copied into the private chat-media
 *      bucket and the row points at it; a failed download keeps "meta:<id>".
 *  (2) serve it: members and platform super admins only, never a public link.
 *  (3) rescue + expired: the sweep saves what the webhook couldn't, and marks
 *      what Meta no longer has.
 *  (4) retention: old files are removed, their messages stay.
 *  (5) deletion: a deleted workspace's / contact's files are removed.
 * Fakes only: no live database, storage or WhatsApp.
 */

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

/**
 * Meta's two media calls: the lookup (graph.facebook.com/<version>/<id>) and
 * the file itself (lookaside). `media` says what Meta has for each id.
 */
function metaMedia(media: Record<string, { bytes?: Uint8Array; mime?: string; size?: number } | "gone">) {
  const downloads: string[] = [];
  const handle = async (url: string): Promise<Response | null> => {
    const lookup = url.match(/graph\.facebook\.com\/v[\d.]+\/([^/?]+)$/);
    if (lookup && media[lookup[1]!] !== undefined) {
      const m = media[lookup[1]!]!;
      if (m === "gone") return new Response(JSON.stringify({ error: { message: "expired" } }), { status: 404 });
      return new Response(
        JSON.stringify({
          url: `https://lookaside.test/${lookup[1]}`,
          mime_type: m.mime ?? "image/jpeg",
          ...(m.size ? { file_size: m.size } : {}),
        }),
      );
    }
    const file = url.match(/^https:\/\/lookaside\.test\/(.+)$/);
    if (file) {
      downloads.push(file[1]!);
      const m = media[file[1]!];
      if (!m || m === "gone") return new Response("", { status: 404 });
      return new Response((m.bytes ?? JPEG) as BodyInit, { headers: { "content-type": m.mime ?? "image/jpeg" } });
    }
    return null;
  };
  return { handle, downloads };
}

/** A customer number (or the onboarding number) where nothing answers the photo but the fallback. */
function webhookWorld(opts: { onboarding?: boolean } = {}) {
  const org = `o32-${Math.random()}`;
  const w = latencyWorld({
    org,
    rttMs: 0,
    graphMs: 0,
    waitingRun: false,
    override: (op: FakeOp) => {
      if (op.table === "platform_settings")
        return { data: { onboarding_whatsapp_account_id: opts.onboarding ? `acc-${org}` : null, ai_burst_quiet_ms: 0, ai_burst_cap_ms: 0 }, error: null };
      if (op.table === "messages" && op.kind === "select") return { data: { metadata: null }, error: null };
      return undefined;
    },
  });
  const storage = fakeStorage();
  withStorage(w.supabase, storage);
  return { ...w, org, storage };
}

const imageMessage = (mediaId: string, extra: Record<string, unknown> = {}) =>
  inboundPayload({ id: `wamid.${mediaId}`, type: "image", image: { id: mediaId, mime_type: "image/jpeg" }, ...extra });

const messageUpdates = (ops: FakeOp[]) =>
  ops.filter((o) => o.table === "messages" && o.kind === "update").map((o) => ({ payload: o.payload as Record<string, unknown>, filters: o.filters }));

describe("(1) save on arrival", () => {
  it("webhook with an image: the bytes go to chat-media/{org}/{conversation}/{message}.jpg and media_url is rewritten, the Meta id kept", async () => {
    resetBurstWindowCache();
    const w = webhookWorld();
    const meta = metaMedia({ "media-1": { bytes: JPEG, mime: "image/jpeg" } });
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => (await meta.handle(String(url))) ?? w.fetchStub(url, init));

    await processWebhookPayload(w.supabase, "ev-1", imageMessage("media-1"));

    const path = `${w.org}/cv1/m-in.jpg`;
    const saved = w.storage.objects("chat-media").get(path);
    expect(saved?.bytes).toEqual(JPEG);
    expect(saved?.contentType).toBe("image/jpeg");
    // Stored with the Meta ref first, exactly as before…
    const insert = w.ops.find((o) => o.table === "messages" && o.kind === "upsert")!;
    expect(insert.payload).toMatchObject({ media_url: "meta:media-1", media_mime: "image/jpeg" });
    // …then moved, only while it still holds that ref.
    const move = messageUpdates(w.ops).find((u) => typeof u.payload["media_url"] === "string")!;
    expect(move.payload).toMatchObject({ media_url: `storage:chat-media/${path}`, metadata: { meta_media_id: "media-1" } });
    expect(move.payload).not.toHaveProperty("media_mime");
    expect(move.filters).toContainEqual(["eq", ["id", "m-in"]]);
    expect(move.filters).toContainEqual(["eq", ["media_url", "meta:media-1"]]);
    // Nothing went to a public bucket.
    expect(w.storage.calls.every((c) => c.bucket === "chat-media")).toBe(true);
  });

  it("download failure keeps the meta ref (nothing uploaded, no row moved) for the sweep to retry", async () => {
    resetBurstWindowCache();
    const w = webhookWorld();
    const meta = metaMedia({ "media-2": "gone" });
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => (await meta.handle(String(url))) ?? w.fetchStub(url, init));

    await processWebhookPayload(w.supabase, "ev-2", imageMessage("media-2"));

    expect(w.storage.calls.filter((c) => c.op === "upload")).toEqual([]);
    expect(messageUpdates(w.ops).some((u) => "media_url" in u.payload)).toBe(false);
    // The event still closes normally: a lost file never makes Meta's event fail.
    const close = w.ops.filter((o) => o.table === "webhook_events" && o.kind === "update").at(-1)!;
    expect((close.payload as Record<string, unknown>)["processed_at"]).toBeTruthy();
  });

  it("over 25 MB: the meta ref stays and metadata.media_too_large is set (Meta's file_size says so before any byte is fetched)", async () => {
    resetBurstWindowCache();
    const w = webhookWorld();
    const meta = metaMedia({ "doc-1": { mime: "application/pdf", size: 40 * 1024 * 1024 } });
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => (await meta.handle(String(url))) ?? w.fetchStub(url, init));

    await processWebhookPayload(
      w.supabase,
      "ev-3",
      inboundPayload({ id: "wamid.doc-1", type: "document", document: { id: "doc-1", mime_type: "application/pdf", filename: "catalogue.pdf" } }),
    );

    expect(meta.downloads).toEqual([]);
    expect(w.storage.calls.filter((c) => c.op === "upload")).toEqual([]);
    const mark = messageUpdates(w.ops).find((u) => (u.payload["metadata"] as Record<string, unknown> | undefined)?.["media_too_large"])!;
    expect(mark.payload).toEqual({ metadata: { meta_media_id: "doc-1", media_too_large: true } });
  });

  it("the platform onboarding number's media is saved too", async () => {
    resetBurstWindowCache();
    const w = webhookWorld({ onboarding: true });
    const meta = metaMedia({ "media-4": { bytes: JPEG, mime: "image/jpeg" } });
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => (await meta.handle(String(url))) ?? w.fetchStub(url, init));

    await processWebhookPayload(w.supabase, "ev-4", imageMessage("media-4"));

    expect(w.storage.objects("chat-media").has(`${w.org}/cv1/m-in.jpg`)).toBe(true);
  });

  it("a redelivered (duplicate) message is not downloaded again", async () => {
    resetBurstWindowCache();
    const org = `o32-dup-${Math.random()}`;
    const w = latencyWorld({ org, rttMs: 0, graphMs: 0, waitingRun: false, duplicate: true });
    const storage = fakeStorage();
    withStorage(w.supabase, storage);
    const meta = metaMedia({ "media-5": { bytes: JPEG } });
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => (await meta.handle(String(url))) ?? w.fetchStub(url, init));

    await processWebhookPayload(w.supabase, "ev-5", imageMessage("media-5"));

    expect(storage.calls).toEqual([]);
  });
});
