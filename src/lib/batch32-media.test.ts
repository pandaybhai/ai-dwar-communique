import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pgAvailable, startScratchPg, type ScratchPg } from "./test-support/scratch-pg";
import type { FakeOp } from "./test-support/fake-db";
import { fakeStorage, withStorage } from "./test-support/fake-storage";
import { memoryDb, type Row } from "./test-support/memory-db";
import {
  MAX_SAVE_ATTEMPTS,
  PURGE_FOLDER_OBJECTS,
  RESCUE_BATCH,
  RETENTION_BATCH,
  purgeQueuedMedia,
  runChatMediaSweep,
} from "./chat-media.server";
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
    expect(counts).toEqual({ media_saved: 0, media_save_failed: 0, media_too_large: 0, media_expired: 0, media_removed: 0, media_purged: 0 });
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

describe("(4) retention", () => {
  const kept = (id: string, createdAt: string, extra: Row = {}): Row =>
    inbound(id, createdAt, { media_url: `storage:chat-media/org-z/cv-z/${id}.jpg`, body: `caption ${id}`, metadata: { meta_media_id: `${id}-media` }, ...extra });
  const settings = (days: number | null) => ({ platform_settings: [{ id: true, media_retention_days: days }] });
  const stored = (w: ReturnType<typeof sweepWorld>, ...ids: string[]) =>
    ids.forEach((id) => w.storage.objects("chat-media").set(`org-z/cv-z/${id}.jpg`, { bytes: JPEG, contentType: "image/jpeg" }));

  it("retention deletion leaves text intact: the old file goes, its message stays with its words; a text message is never touched", async () => {
    const text: Row = { id: "t-old", organization_id: "org-z", conversation_id: "cv-z", direction: "inbound", type: "text", body: "hello from last year", media_url: null, metadata: null, created_at: ago(400 * DAY) };
    const w = sweepWorld([kept("p-old", ago(400 * DAY)), kept("p-new", ago(30 * DAY)), text], settings(365));
    stored(w, "p-old", "p-new");

    const counts = await runChatMediaSweep(w.db.supabase, { now: NOW });

    expect(counts.media_removed).toBe(1);
    expect(w.storage.objects("chat-media").has("org-z/cv-z/p-old.jpg")).toBe(false);
    expect(w.storage.objects("chat-media").has("org-z/cv-z/p-new.jpg")).toBe(true);
    expect(w.row("p-old")).toMatchObject({
      media_url: null,
      body: "caption p-old",
      type: "image",
      metadata: { meta_media_id: "p-old-media", media_removed_at: new Date(NOW).toISOString() },
    });
    expect(w.row("p-new")["media_url"]).toBe("storage:chat-media/org-z/cv-z/p-new.jpg");
    expect(w.row("t-old")).toEqual(text);
    expect(w.db.rows("messages")).toHaveLength(3);
    expect(w.db.log.some((l) => l.table === "messages" && l.kind === "delete")).toBe(false);
  });

  it("null keeps forever; a missing setting (column not applied) removes nothing", async () => {
    for (const extra of [settings(null), {}]) {
      const w = sweepWorld([kept("p-ancient", ago(3000 * DAY))], extra);
      stored(w, "p-ancient");
      expect((await runChatMediaSweep(w.db.supabase, { now: NOW })).media_removed).toBe(0);
      expect(w.storage.calls.filter((c) => c.op === "remove")).toEqual([]);
      expect(w.row("p-ancient")["media_url"]).toBe("storage:chat-media/org-z/cv-z/p-ancient.jpg");
    }
  });

  it("storage refusing the delete leaves every row as it was (no file is said removed while it is still there)", async () => {
    const w = sweepWorld([kept("p-old", ago(400 * DAY))], settings(365));
    stored(w, "p-old");
    w.storage.fail.remove = "storage down";
    expect((await runChatMediaSweep(w.db.supabase, { now: NOW })).media_removed).toBe(0);
    expect(w.row("p-old")["media_url"]).toBe("storage:chat-media/org-z/cv-z/p-old.jpg");
  });

  it("bounded: at most RETENTION_BATCH files a run, oldest first", async () => {
    const rows = Array.from({ length: RETENTION_BATCH + 3 }, (_, i) => kept(`b${i}`, ago((500 + i) * DAY)));
    const w = sweepWorld(rows, settings(365));
    expect((await runChatMediaSweep(w.db.supabase, { now: NOW })).media_removed).toBe(RETENTION_BATCH);
    const left = w.db.rows("messages").filter((m) => m["media_url"]).map((m) => m["id"]);
    expect(left).toEqual(["b0", "b1", "b2"]);
  });
});

describe("(5) deletion — the sweep empties the queue the delete triggers fill", () => {
  const put = (w: ReturnType<typeof sweepWorld>, ...paths: string[]) =>
    paths.forEach((p) => w.storage.objects("chat-media").set(p, { bytes: JPEG, contentType: "image/jpeg" }));

  it("workspace delete removes objects: its whole folder goes, another workspace's files stay", async () => {
    const w = sweepWorld([], { chat_media_purge: [{ path: "org-gone/", reason: "workspace_deleted", queued_at: ago(60_000) }] });
    put(w, "org-gone/cv1/m1.jpg", "org-gone/cv1/m2.ogg", "org-gone/cv2/m3.pdf", "org-z/cv-z/keep.jpg");

    const counts = await runChatMediaSweep(w.db.supabase, { now: NOW });

    expect(counts.media_purged).toBe(3);
    expect([...w.storage.objects("chat-media").keys()]).toEqual(["org-z/cv-z/keep.jpg"]);
    // Still queued until the folder lists empty; the next run closes it.
    expect(w.db.rows("chat_media_purge")).toHaveLength(1);
    expect((await runChatMediaSweep(w.db.supabase, { now: NOW })).media_purged).toBe(0);
    expect(w.db.rows("chat_media_purge")).toEqual([]);
  });

  it("a deleted contact's (or conversation's) files: each queued path is removed and taken off the queue", async () => {
    const w = sweepWorld([], {
      chat_media_purge: [
        { path: "org-z/cv-old/m1.jpg", reason: "message_deleted", queued_at: ago(120_000) },
        { path: "org-z/cv-old/m2.ogg", reason: "message_deleted", queued_at: ago(60_000) },
        { path: "org-z/cv-old/already-gone.jpg", reason: "message_deleted", queued_at: ago(30_000) },
      ],
    });
    put(w, "org-z/cv-old/m1.jpg", "org-z/cv-old/m2.ogg", "org-z/cv-z/keep.jpg");

    expect(await purgeQueuedMedia(w.db.supabase)).toBe(2);
    expect([...w.storage.objects("chat-media").keys()]).toEqual(["org-z/cv-z/keep.jpg"]);
    expect(w.db.rows("chat_media_purge")).toEqual([]);
  });

  it("storage refusing keeps the queue (nothing is forgotten), and a big folder is emptied over several runs", async () => {
    const w = sweepWorld([], { chat_media_purge: [{ path: "org-big/", reason: "workspace_deleted", queued_at: ago(1) }] });
    put(w, ...Array.from({ length: PURGE_FOLDER_OBJECTS + 7 }, (_, i) => `org-big/cv${i % 3}/m${i}.jpg`));
    w.storage.fail.remove = "storage down";
    await expect(purgeQueuedMedia(w.db.supabase)).rejects.toThrow(/storage down/);
    expect(w.db.rows("chat_media_purge")).toHaveLength(1);

    w.storage.fail.remove = null;
    expect(await purgeQueuedMedia(w.db.supabase)).toBe(PURGE_FOLDER_OBJECTS);
    expect(await purgeQueuedMedia(w.db.supabase)).toBe(7);
    expect(await purgeQueuedMedia(w.db.supabase)).toBe(0);
    expect(w.db.rows("chat_media_purge")).toEqual([]);
    expect(w.storage.objects("chat-media").size).toBe(0);
  });
});

const MIGRATION = join(import.meta.dirname, "../../supabase/aidwar-migrations/20261110_batch32_media.sql");
describe.runIf(pgAvailable() || Boolean(process.env["CI"]))("(5) the delete triggers and the bucket (real Postgres)", () => {
  let pg: ScratchPg;
  beforeAll(() => {
    pg = startScratchPg({
      schemaFile: join(import.meta.dirname, "test-support/loadtest/schema.sql"),
      // Twice: the file is idempotent.
      migrations: [join(import.meta.dirname, "test-support/storage-stubs.sql"), MIGRATION, MIGRATION],
    });
  }, 120_000);
  afterAll(() => pg?.stop());

  const seed = () =>
    pg.sql(`
      truncate public.chat_media_purge;
      delete from public.organizations;
      truncate public.chat_media_purge;
      insert into public.organizations (id, name) values
        ('00000000-0000-0000-0000-0000000000a1', 'A'), ('00000000-0000-0000-0000-0000000000b2', 'B');
      insert into public.contacts (id, organization_id, phone) values
        ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-0000000000a1', '+911'),
        ('00000000-0000-0000-0000-00000000c002', '00000000-0000-0000-0000-0000000000a1', '+912'),
        ('00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-0000000000b2', '+913');
      insert into public.conversations (id, organization_id, contact_id) values
        ('00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000c001'),
        ('00000000-0000-0000-0000-0000000c0002', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000c002'),
        ('00000000-0000-0000-0000-0000000c0003', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-00000000c003');
      insert into public.messages (organization_id, conversation_id, direction, type, body, media_url) values
        ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000c0001', 'inbound', 'image', null, 'storage:chat-media/a1/cv1/p1.jpg'),
        ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000c0001', 'inbound', 'text', 'hi', null),
        ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000c0001', 'inbound', 'image', null, 'meta:123'),
        ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000c0001', 'outbound', 'image', null, 'https://x/product-images/p.jpg'),
        ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000c0002', 'inbound', 'audio', null, 'storage:chat-media/a1/cv2/v1.ogg'),
        ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000c0003', 'inbound', 'image', null, 'storage:chat-media/b2/cv3/p3.jpg');
      truncate public.chat_media_purge;
    `);
  const queue = () => pg.sql("select path || '|' || reason from public.chat_media_purge order by path").split("\n").filter(Boolean);

  it("deleting a contact queues exactly its kept files (not its text, not a Meta ref, not our outbound picture, not another contact's)", () => {
    seed();
    pg.sql("delete from public.contacts where id = '00000000-0000-0000-0000-00000000c001'");
    expect(queue()).toEqual(["a1/cv1/p1.jpg|message_deleted"]);
    expect(pg.sql("select count(*) from public.messages")).toBe("2");
  });

  it("deleting a workspace queues its whole folder (and its kept files); the other workspace is untouched", () => {
    seed();
    pg.sql("delete from public.organizations where id = '00000000-0000-0000-0000-0000000000a1'");
    expect(queue()).toEqual([
      "00000000-0000-0000-0000-0000000000a1/|workspace_deleted",
      "a1/cv1/p1.jpg|message_deleted",
      "a1/cv2/v1.ogg|message_deleted",
    ]);
    expect(pg.sql("select media_url from public.messages")).toBe("storage:chat-media/b2/cv3/p3.jpg");
  });

  it("retention (an update to media_url null) queues nothing; the queue is service-role only; the bucket is private with no storage policy", () => {
    seed();
    pg.sql("update public.messages set media_url = null where media_url like 'storage:chat-media/%'");
    expect(queue()).toEqual([]);
    expect(pg.sql("select has_table_privilege('authenticated', 'public.chat_media_purge', 'select')")).toBe("f");
    expect(pg.sql("select has_table_privilege('anon', 'public.chat_media_purge', 'select')")).toBe("f");
    expect(pg.sql("select has_table_privilege('service_role', 'public.chat_media_purge', 'delete')")).toBe("t");
    expect(pg.sql("select public::text || '|' || file_size_limit from storage.buckets where id = 'chat-media'")).toBe("false|26214400");
    expect(pg.sql("select count(*) from pg_policies where schemaname = 'storage'")).toBe("0");
    expect(pg.sql("select count(*) from information_schema.columns where table_name = 'platform_settings' and column_name = 'media_retention_days'")).toBe("1");
  });
});
