import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeFetch, publicApiWorld, type FetchCall } from "./test-support/public-api-world";
import { profileProblems, squareCropRect } from "./whatsapp-profile";

/**
 * Batch 35 item 3 — Settings → WhatsApp profile. The profile is read from and
 * written to Meta's /{phone-number-id}/whatsapp_business_profile with exactly
 * the changed fields; the photo goes through the Resumable Upload API and is
 * set by its handle; a display-name change is a POST new_display_name that
 * Meta reviews. Meta's errors come back in plain words; every change is on the
 * activity log; only owners and admins (settings.manage). Fakes only.
 */

const h = vi.hoisted(() => ({
  world: null as null | ReturnType<typeof import("./test-support/public-api-world").publicApiWorld>,
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.world!.db.supabase }));

import { Route as ProfileRoute } from "../routes/api/whatsapp/profile";
import { Route as PhotoRoute } from "../routes/api/whatsapp/profile-photo";

type Post = (a: { request: Request }) => Promise<Response>;
const post = (r: unknown) =>
  (r as { options: { server: { handlers: { POST: Post } } } }).options.server.handlers.POST;

const ACTIVITY_TABLE = ["activity", "log"].join("_");
const GRAPH = "https://graph.facebook.com/v25.0";

const profileCall = (token: string, body: Record<string, unknown>) =>
  post(ProfileRoute)({
    request: new Request("https://aidwar.in/api/whatsapp/profile", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ organization_id: "org-a", whatsapp_account_id: "acc-a", ...body }),
    }),
  });

const photoCall = (token: string, file: File) => {
  const form = new FormData();
  form.set("organization_id", "org-a");
  form.set("whatsapp_account_id", "acc-a");
  form.set("file", file);
  return post(PhotoRoute)({
    request: new Request("https://aidwar.in/api/whatsapp/profile-photo", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    }),
  });
};

let net: ReturnType<typeof fakeFetch>;
let metaAnswer: (call: FetchCall) => Response | undefined;

const CURRENT = {
  about: "Fresh coffee daily",
  address: "1 MG Road",
  description: "Roasters",
  email: "hi@shop.in",
  messaging_product: "whatsapp",
  profile_picture_url: "https://pps.whatsapp.net/p.jpg",
  websites: ["https://shop.in/"],
  vertical: "RESTAURANT",
};

beforeEach(() => {
  h.world = publicApiWorld();
  h.world.db.rows("permissions").push({ key: "settings.manage" });
  h.world.db.rows("role_permissions").push({ role: "admin", permission_key: "settings.manage" });
  metaAnswer = () => undefined;
  net = fakeFetch([
    (c) => metaAnswer(c),
    (c) => {
      if (!c.url.startsWith(GRAPH)) return undefined;
      if (c.url.includes("/whatsapp_business_profile") && c.method === "GET")
        return Response.json({ data: [CURRENT] });
      if (c.url.includes("/whatsapp_business_profile") && c.method === "POST")
        return Response.json({ success: true });
      if (c.url.includes("/app-123/uploads")) return Response.json({ id: "upload:sess-1" });
      if (c.url.endsWith("/upload:sess-1")) return Response.json({ h: "4::handle-1" });
      if (c.url.startsWith(`${GRAPH}/pn-a?`) && c.method === "GET") {
        return Response.json({ verified_name: "Shop A", name_status: "APPROVED", id: "pn-a" });
      }
      if (c.url.startsWith(`${GRAPH}/pn-a?`) && c.method === "POST")
        return Response.json({ success: true });
      return undefined;
    },
  ]);
  vi.stubGlobal("fetch", net.impl);
  vi.stubEnv("META_APP_ID", "app-123");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const metaCalls = () => net.calls.filter((c) => c.url.startsWith("https://graph.facebook.com/"));

describe("reading the profile", () => {
  it("shows the current values and the display name with its review status, read from Meta", async () => {
    const res = await profileCall("u-admin", { action: "get" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      profile: Record<string, unknown>;
      name: Record<string, unknown>;
    };
    expect(body.profile).toMatchObject({
      about: "Fresh coffee daily",
      websites: ["https://shop.in/"],
      vertical: "RESTAURANT",
    });
    expect(body.name).toMatchObject({ verified_name: "Shop A", name_status: "APPROVED" });
    const get = metaCalls().find((c) => c.url.includes("whatsapp_business_profile"))!;
    expect(new URL(get.url).searchParams.get("fields")).toBe(
      "about,address,description,email,profile_picture_url,websites,vertical",
    );
    expect(get.headers["authorization"]).toBe("Bearer meta-token-a");
    const name = metaCalls().find((c) => c.url.startsWith(`${GRAPH}/pn-a?`))!;
    expect(new URL(name.url).searchParams.get("fields")).toBe(
      "verified_name,name_status,new_display_name,new_name_status",
    );
  });
});

describe("changing the profile", () => {
  it("sends the right Meta request: messaging_product plus exactly the changed fields; logged", async () => {
    const res = await profileCall("u-admin", {
      action: "update",
      profile: {
        about: "  Fresh coffee, every day ",
        websites: ["https://shop.in/", "https://instagram.com/shop"],
        vertical: "GROCERY",
      },
    });
    expect(res.status).toBe(200);
    const sent = metaCalls().filter((c) => c.method === "POST");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${GRAPH}/pn-a/whatsapp_business_profile`);
    expect(JSON.parse(String(sent[0]!.body))).toEqual({
      messaging_product: "whatsapp",
      about: "Fresh coffee, every day",
      vertical: "GROCERY",
      websites: ["https://shop.in/", "https://instagram.com/shop"],
    });
    const log = h
      .world!.db.rows(ACTIVITY_TABLE)
      .find((r) => r["action"] === "whatsapp_profile_updated");
    expect(log?.["details"]).toEqual({
      whatsapp_account_id: "acc-a",
      fields: ["about", "vertical", "websites"],
    });
  });

  it("Meta's error comes back in plain words", async () => {
    metaAnswer = (c) =>
      c.method === "POST"
        ? Response.json(
            {
              error: {
                code: 100,
                message: "(#100) Invalid parameter",
                error_user_msg: "The email address isn't valid.",
              },
            },
            { status: 400 },
          )
        : undefined;
    const res = await profileCall("u-admin", { action: "update", profile: { email: "x@y.in" } });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Meta didn't accept this: The email address isn't valid.",
    );

    metaAnswer = (c) =>
      c.method === "POST"
        ? Response.json({ error: { code: 190, message: "expired" } }, { status: 401 })
        : undefined;
    const expired = await profileCall("u-admin", {
      action: "update",
      profile: { email: "x@y.in" },
    });
    expect(((await expired.json()) as { error: string }).error).toMatch(
      /connection has expired\. Reconnect/,
    );
    expect(
      h.world!.db.rows(ACTIVITY_TABLE).some((r) => r["action"] === "whatsapp_profile_updated"),
    ).toBe(false);
  });

  it("Meta's limits are checked first: nothing reaches Meta", async () => {
    for (const profile of [
      { about: "   " },
      { about: "x".repeat(140) },
      { websites: ["shop.in"] },
      { websites: ["https://a.in", "https://b.in", "https://c.in"] },
      { email: "not-an-email" },
      { vertical: "JEWELLERY" },
      {},
    ]) {
      const res = await profileCall("u-admin", { action: "update", profile });
      expect(res.status).toBe(400);
    }
    expect(metaCalls()).toHaveLength(0);
    expect(profileProblems({ description: "x".repeat(513) })[0]).toMatch(/512/);
  });

  it("only owners and admins", async () => {
    expect((await profileCall("u-agent", { action: "get" })).status).toBe(403);
    expect(
      (await profileCall("u-agent", { action: "update", profile: { about: "Hi" } })).status,
    ).toBe(403);
    expect(metaCalls()).toHaveLength(0);
  });
});

describe("the profile photo", () => {
  it("uploads through the Resumable Upload API and sets profile_picture_handle", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
    const res = await photoCall(
      "u-admin",
      new File([bytes], "profile.jpg", { type: "image/jpeg" }),
    );
    expect(res.status).toBe(200);
    const [session, upload, set] = metaCalls();
    expect(session!.method).toBe("POST");
    const s = new URL(session!.url);
    expect(s.pathname).toBe("/v25.0/app-123/uploads");
    expect(s.searchParams.get("file_type")).toBe("image/jpeg");
    expect(s.searchParams.get("file_length")).toBe("6");
    expect(upload!.url).toBe(`${GRAPH}/upload:sess-1`);
    expect(upload!.headers["file_offset"]).toBe("0");
    expect(
      Array.from(new Uint8Array(upload!.body as ArrayBuffer | Uint8Array as Uint8Array)),
    ).toEqual(Array.from(bytes));
    expect(set!.url).toBe(`${GRAPH}/pn-a/whatsapp_business_profile`);
    expect(JSON.parse(String(set!.body))).toEqual({
      messaging_product: "whatsapp",
      profile_picture_handle: "4::handle-1",
    });
    expect(
      h
        .world!.db.rows(ACTIVITY_TABLE)
        .some((r) => r["action"] === "whatsapp_profile_photo_updated"),
    ).toBe(true);
  });

  it("refuses other types and pictures over 5 MB before Meta", async () => {
    expect(
      (await photoCall("u-admin", new File([new Uint8Array(4)], "a.gif", { type: "image/gif" })))
        .status,
    ).toBe(400);
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.png", { type: "image/png" });
    const res = await photoCall("u-admin", big);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/over 5 MB/);
    expect(metaCalls()).toHaveLength(0);
  });

  it("the crop is the largest square, zoomed and slid across the picture", () => {
    expect(squareCropRect(1200, 800)).toEqual({ sx: 200, sy: 0, size: 800 });
    expect(squareCropRect(1200, 800, 2, 0, 1)).toEqual({ sx: 0, sy: 400, size: 400 });
    expect(squareCropRect(640, 640, 1, 0.3, 0.9)).toEqual({ sx: 0, sy: 0, size: 640 });
  });
});

describe("display name", () => {
  it("asks Meta to review a new name (POST new_display_name) and logs it", async () => {
    const res = await profileCall("u-admin", {
      action: "display_name",
      name: "  Shop   A Coffee ",
    });
    expect(res.status).toBe(200);
    const req = metaCalls().find((c) => c.method === "POST")!;
    const url = new URL(req.url);
    expect(url.pathname).toBe("/v25.0/pn-a");
    expect(url.searchParams.get("new_display_name")).toBe("Shop A Coffee");
    const log = h
      .world!.db.rows(ACTIVITY_TABLE)
      .find((r) => r["action"] === "whatsapp_display_name_requested");
    expect(log?.["details"]).toMatchObject({ new_display_name: "Shop A Coffee" });
    expect((await profileCall("u-admin", { action: "display_name", name: "A" })).status).toBe(400);
  });
});
