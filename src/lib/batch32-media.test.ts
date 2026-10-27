import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FakeOp } from "./test-support/fake-db";
import { fakeStorage, withStorage } from "./test-support/fake-storage";
import { memoryDb, type Row } from "./test-support/memory-db";
import { MAX_SAVE_ATTEMPTS, RESCUE_BATCH, runChatMediaSweep } from "./chat-media.server";
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

// ---------------------------------------------------------------- the sweep

const DAY = 24 * 3600_000;
const NOW = Date.parse("2026-10-28T06:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

/** A workspace with one connected number and inbound rows as the database holds them. */
function sweepWorld(messages: Row[], extra: Record<string, Row[]> = {}) {
  const db = memoryDb({
    whatsapp_accounts: [
      { id: "acc-z", organization_id: "org-z", waba_id: "waba-z", phone_number_id: "pn-z", display_phone_number: "91", status: "active", is_default: true },
    ],
    whatsapp_credentials: [{ organization_id: "org-z", waba_id: "waba-z", access_token: "tok-z" }],
    conversations: [{ id: "cv-z", organization_id: "org-z", whatsapp_account_id: "acc-z" }],
    messages,
    ...extra,
  });
  const storage = fakeStorage();
  withStorage(db.supabase, storage);
  const row = (id: string) => db.rows("messages").find((m) => m["id"] === id)!;
  return { db, storage, row };
}

const inbound = (id: string, createdAt: string, extra: Row = {}): Row => ({
  id,
  organization_id: "org-z",
  conversation_id: "cv-z",
  direction: "inbound",
  type: "image",
  body: null,
  media_url: `meta:${id}-media`,
  media_mime: "image/jpeg",
  metadata: null,
  created_at: createdAt,
  ...extra,
});

describe("(3) rescue + expired", () => {
  it("a row still on meta: younger than 7 days is saved by the sweep (Zoori's 26 Oct photo)", async () => {
    const w = sweepWorld([inbound("zoori-26oct", "2026-10-26T06:00:00Z")]);
    const meta = metaMedia({ "zoori-26oct-media": { bytes: JPEG } });
    vi.stubGlobal("fetch", async (url: string | URL) => (await meta.handle(String(url))) ?? new Response("", { status: 500 }));

    const counts = await runChatMediaSweep(w.db.supabase, { now: NOW });

    expect(counts).toMatchObject({ media_saved: 1, media_save_failed: 0, media_expired: 0 });
    expect(w.row("zoori-26oct")).toMatchObject({
      media_url: "storage:chat-media/org-z/cv-z/zoori-26oct.jpg",
      metadata: { meta_media_id: "zoori-26oct-media" },
    });
    expect(w.storage.objects("chat-media").get("org-z/cv-z/zoori-26oct.jpg")?.bytes).toEqual(JPEG);
  });

  it("expired marking: rows older than 7 days get metadata.media_expired, are never downloaded, and keep their meta ref", async () => {
    const w = sweepWorld([
      inbound("old-1", ago(9 * DAY), { metadata: { note: "kept" } }),
      inbound("old-2", ago(7 * DAY + 60_000), { type: "audio", media_mime: "audio/ogg" }),
      inbound("fresh", ago(2 * DAY)),
    ]);
    const meta = metaMedia({ "fresh-media": { bytes: JPEG } });
    vi.stubGlobal("fetch", async (url: string | URL) => (await meta.handle(String(url))) ?? new Response("", { status: 500 }));

    const counts = await runChatMediaSweep(w.db.supabase, { now: NOW });

    expect(counts.media_expired).toBe(2);
    expect(w.row("old-1")).toMatchObject({ media_url: "meta:old-1-media", metadata: { note: "kept", media_expired: true } });
    expect(w.row("old-2")["metadata"]).toEqual({ media_expired: true });
    expect(meta.downloads).toEqual(["fresh-media"]);
    // Marked once: the next run finds nothing more to mark.
    expect((await runChatMediaSweep(w.db.supabase, { now: NOW })).media_expired).toBe(0);
  });

  it("a row the webhook may still be saving (under 5 minutes) is left to it; outbound and saved rows are never touched", async () => {
    const w = sweepWorld([
      inbound("just-now", ago(60_000)),
      inbound("ours", ago(DAY), { direction: "outbound", media_url: "https://x.supabase.co/storage/v1/object/public/product-images/a.jpg" }),
      inbound("saved", ago(DAY), { media_url: "storage:chat-media/org-z/cv-z/saved.jpg" }),
    ]);
    vi.stubGlobal("fetch", async () => new Response("", { status: 500 }));
    const counts = await runChatMediaSweep(w.db.supabase, { now: NOW });
    expect(counts).toEqual({ media_saved: 0, media_save_failed: 0, media_too_large: 0, media_expired: 0 });
    expect(w.storage.calls).toEqual([]);
  });

  it("Meta refusing counts an attempt and gives up after MAX_SAVE_ATTEMPTS; a storage failure (no bucket yet) never counts", async () => {
    const w = sweepWorld([inbound("refused", ago(DAY)), inbound("nobucket", ago(2 * DAY))]);
    const meta = metaMedia({ "refused-media": "gone", "nobucket-media": { bytes: JPEG } });
    vi.stubGlobal("fetch", async (url: string | URL) => (await meta.handle(String(url))) ?? new Response("", { status: 500 }));
    w.storage.fail.upload = "Bucket not found";

    for (let i = 0; i < MAX_SAVE_ATTEMPTS + 2; i++) await runChatMediaSweep(w.db.supabase, { now: NOW });

    expect(w.row("refused")["media_url"]).toBe("meta:refused-media");
    expect(w.row("refused")["metadata"]).toEqual({ media_save_attempts: MAX_SAVE_ATTEMPTS, media_save_gave_up: true });
    expect(w.row("nobucket")["media_url"]).toBe("meta:nobucket-media");
    expect(w.row("nobucket")["metadata"]).toBeNull();

    // The migration is applied: the next run saves it.
    w.storage.fail.upload = null;
    expect((await runChatMediaSweep(w.db.supabase, { now: NOW })).media_saved).toBe(1);
    expect(w.row("nobucket")["media_url"]).toBe("storage:chat-media/org-z/cv-z/nobucket.jpg");
  });

  it("bounded: at most RESCUE_BATCH rows a run, newest first, and no new download once the time budget is spent", async () => {
    const rows = Array.from({ length: RESCUE_BATCH + 5 }, (_, i) => inbound(`r${i}`, ago((i + 1) * 3600_000)));
    const w = sweepWorld(rows);
    const media = Object.fromEntries(rows.map((r) => [`${r["id"]}-media`, { bytes: JPEG }]));
    const meta = metaMedia(media);
    vi.stubGlobal("fetch", async (url: string | URL) => (await meta.handle(String(url))) ?? new Response("", { status: 500 }));

    expect((await runChatMediaSweep(w.db.supabase, { now: NOW })).media_saved).toBe(RESCUE_BATCH);
    expect(meta.downloads[0]).toBe("r0-media");
    expect(w.row(`r${RESCUE_BATCH}`)["media_url"]).toMatch(/^meta:/);

    const none = await runChatMediaSweep(w.db.supabase, { now: NOW, budgetMs: -1 });
    expect(none.media_saved).toBe(0);
  });

  it("runs inside the billing sweep and its counts come back with the rest", async () => {
    const w = sweepWorld([inbound("in-sweep", new Date(Date.now() - DAY).toISOString())]);
    const meta = metaMedia({ "in-sweep-media": { bytes: JPEG } });
    vi.stubGlobal("fetch", async (url: string | URL) => (await meta.handle(String(url))) ?? new Response("", { status: 500 }));
    const { runBillingSweep } = await import("./billing-sweep.server");
    const counts = await runBillingSweep(w.db.supabase);
    expect(counts.media_saved).toBe(1);
  });
});
