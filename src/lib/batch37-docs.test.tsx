import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ComponentType, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * Batch 37 item 7 — the docs and the Postman collection come from one
 * description (src/lib/public-api-spec.ts) and can't drift from each other or
 * from the server: every example passes the server's own request checks,
 * every webhook example has exactly the fields the server's builders write,
 * every endpoint has its route, every error code the server answers with is
 * in the table, and Settings lists the events a webhook receives.
 */

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      children,
      className,
    }: {
      to: string;
      children: ReactNode;
      className?: string;
    }) => (
      <a href={to} className={className}>
        {children}
      </a>
    ),
    createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
  };
});
vi.mock("@/hooks/use-session", () => ({ useSession: () => ({ session: null, loading: false }) }));

import { ALL_WEBHOOK_EVENTS, API_ERRORS, MEDIA_LIMITS } from "./public-api";
import {
  API_ENDPOINTS,
  POSTMAN_PATH,
  WEBHOOK_EVENTS,
  curlFor,
  errorRow,
  nodeFor,
  postmanCollection,
} from "./public-api-spec";
import { parseSendRequest } from "./public-api-send.server";
import { parseSessionRequest } from "./public-api-session.server";
import { parseContactInput, parseTagList } from "./public-api-contacts.server";
import {
  contactEventPayload,
  inboundMessagePayload,
  queueTemplateApiEvents,
  webhookBody,
  forgetApiEventsWanted,
} from "./public-api-webhooks.server";
import { ORG, publicApiWorld } from "./test-support/public-api-world";

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");

async function page(): Promise<string> {
  const mod = (await import("@/routes/developers.api.tsx")) as {
    Route: { options: { component: ComponentType & { preload?: () => Promise<void> } } };
  };
  await mod.Route.options.component.preload?.();
  const Page = mod.Route.options.component;
  return renderToStaticMarkup(<Page />);
}

/** Every key path of a JSON value ("a", "a.b", …), arrays by their first item. */
function shape(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return value.length ? shape(value[0], prefix) : [];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
    `${prefix}${k}`,
    ...shape(v, `${prefix}${k}.`),
  ]);
}

const LIB = import.meta.dirname;
const ROUTES = join(LIB, "..", "routes");

describe("one description: docs page and Postman", () => {
  it("the page shows every endpoint (curl + Node), every webhook event and the Postman link", async () => {
    const html = await page();
    const t = text(html);
    for (const e of API_ENDPOINTS) {
      expect(t, e.id).toContain(`${e.method} https://aidwar.in${e.path}`);
      expect(t, e.id).toContain(text(curlFor(e)).trim().slice(0, 60));
      expect(t, e.id).toContain(text(nodeFor(e)).trim().slice(0, 60));
    }
    for (const ev of WEBHOOK_EVENTS) expect(t).toContain(ev.name);
    expect(html).toContain(`href="${POSTMAN_PATH}"`);
  });

  it("the Postman collection is every endpoint and example of the page, with the key as an empty variable", () => {
    const c = postmanCollection() as {
      auth: { bearer: Array<{ value: string }> };
      variable: Array<{ key: string; value: string }>;
      item: Array<{
        item: Array<{
          id: string;
          request: { method: string; url: { raw: string }; body?: { raw: string } };
        }>;
      }>;
    };
    const items = c.item.flatMap((g) => g.item);
    const expected = API_ENDPOINTS.flatMap((e) => [
      e.id,
      ...(e.more ?? []).map((_, i) => `${e.id}-${i + 1}`),
    ]);
    expect(items.map((i) => i.id)).toEqual(expected);
    for (const i of items) expect(i.request.url.raw.startsWith("{{baseUrl}}/api/v1/")).toBe(true);
    expect(c.auth.bearer[0]!.value).toBe("{{apiKey}}");
    expect(c.variable).toEqual([
      { key: "baseUrl", value: "https://aidwar.in" },
      { key: "apiKey", value: "" },
    ]);
    expect(JSON.stringify(c)).not.toMatch(/adw_live_[A-Za-z0-9_-]{10}/);
    // The same request bodies as the page's examples.
    const send = items.find((i) => i.id === "send-template")!;
    expect(JSON.parse(send.request.body!.raw)).toEqual(API_ENDPOINTS[0]!.body);
  });

  it("/developers/api.postman.json serves that collection as a download", async () => {
    const mod = (await import("../routes/developers.api[.]postman[.]json")) as unknown as {
      Route: { options: { server: { handlers: { GET: () => Promise<Response> } } } };
    };
    const res = await mod.Route.options.server.handlers.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename=".+\.postman_collection\.json"/,
    );
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(postmanCollection())));
  });
});

describe("the description is the server's", () => {
  it("every endpoint has its route file with that method", async () => {
    const tree = readFileSync(join(LIB, "..", "routeTree.gen.ts"), "utf8");
    for (const e of API_ENDPOINTS) {
      const route = e.path.replace(
        /\{(\w+)\}/g,
        (_, p: string) => `$${p === "message_id" ? "messageId" : p}`,
      );
      expect(tree, e.id).toContain(`'${route}': typeof`);
      const file = readdirSync(join(ROUTES, "api", "v1"), { recursive: true })
        .map(String)
        .filter((f) => f.endsWith(".ts"))
        .map((f) => readFileSync(join(ROUTES, "api", "v1", f), "utf8"))
        .find(
          (src) =>
            src.includes(`createFileRoute("${route}")`) ||
            src.includes(`createFileRoute("${route}/")`),
        );
      expect(file, e.id).toBeDefined();
      expect(file!, e.id).toContain(`${e.method}: async`);
    }
  });

  it("every request example passes the server's own check", async () => {
    for (const e of API_ENDPOINTS) {
      for (const body of [e.body, ...(e.more ?? []).map((m) => m.body)].filter(Boolean)) {
        const label = `${e.id}: ${JSON.stringify(body).slice(0, 50)}`;
        if (e.id === "send-template")
          expect("status" in parseSendRequest(body, null), label).toBe(false);
        else if (e.id === "send-session")
          expect("status" in parseSessionRequest(body, null), label).toBe(false);
        else if (e.id === "contact-upsert")
          expect(typeof (await parseContactInput(body)), label).toBe("object");
        else if (e.id === "contacts-bulk")
          for (const c of (body as { contacts: unknown[] }).contacts)
            expect(typeof (await parseContactInput(c)), label).toBe("object");
        else if (e.id === "contact-tags-add")
          expect(Array.isArray(parseTagList((body as { tags: unknown }).tags)), label).toBe(true);
        else throw new Error(`no check for ${e.id}`);
      }
    }
  });

  it("every webhook example has exactly the fields the server writes", async () => {
    const byName = new Map(WEBHOOK_EVENTS.map((ev) => [ev.name, ev.example]));
    expect([...byName.keys()]).toEqual([...ALL_WEBHOOK_EVENTS]);
    for (const name of ["message.sent", "message.delivered", "message.read", "message.failed"]) {
      const real = webhookBody({
        event: name as "message.sent",
        messageId: "m",
        idempotencyKey: "k",
        to: "+91",
        error: name === "message.failed" ? { code: "1", message: "x" } : null,
        occurredAt: "t",
      });
      expect(shape(byName.get(name)).sort(), name).toEqual(shape(real).sort());
    }
    const received = inboundMessagePayload({
      messageId: "m",
      msg: { id: "w", type: "image", image: { id: "x", mime_type: "image/jpeg", caption: "c" } },
      phone: "+91",
      name: "A",
      occurredAt: "t",
    });
    expect(shape(byName.get("message.received")).sort()).toEqual(shape(received).sort());
    for (const name of ["contact.created", "contact.opted_out", "contact.opted_in"] as const) {
      const real = contactEventPayload({
        event: name,
        phone: "+91",
        name: null,
        optInStatus: null,
        source: null,
        occurredAt: "t",
      });
      expect(shape(byName.get(name)).sort(), name).toEqual(shape(real).sort());
    }
    // Template events: what queueTemplateApiEvents actually queues.
    const w = publicApiWorld();
    w.db
      .rows("workspace_connections")
      .push({ id: "wc", organization_id: ORG, provider: "api_webhook", status: "active" });
    forgetApiEventsWanted();
    const row = { id: "t1", name: "n", language: "en", status: "PENDING", category: "UTILITY" };
    await queueTemplateApiEvents(w.db.supabase, {
      organizationId: ORG,
      event: "template.status_changed",
      rows: [row],
      next: { status: "APPROVED", rejectionReason: null },
      previousCategory: null,
      occurredAt: "2026-10-28T10:00:00.000Z",
    });
    await queueTemplateApiEvents(w.db.supabase, {
      organizationId: ORG,
      event: "template.category_changed",
      rows: [row],
      next: { category: "MARKETING" },
      previousCategory: "UTILITY",
      occurredAt: "2026-10-28T10:00:00.000Z",
    });
    for (const queued of w.db.rows("api_webhook_deliveries")) {
      const name = String(queued["event"]);
      expect(shape(byName.get(name)).sort(), name).toEqual(shape(queued["payload"]).sort());
    }
    expect(w.db.rows("api_webhook_deliveries")).toHaveLength(2);
  });

  it("every error code the server answers with is in the table, and every endpoint's codes are", () => {
    const codes = new Set(API_ERRORS.flatMap((e) => e.codes));
    const sources = readdirSync(LIB)
      .filter((f) => /^public-api.*\.server\.ts$/.test(f))
      .map((f) => readFileSync(join(LIB, f), "utf8"));
    for (const f of readdirSync(join(ROUTES, "api", "v1"), { recursive: true }).map(String))
      if (f.endsWith(".ts")) sources.push(readFileSync(join(ROUTES, "api", "v1", f), "utf8"));
    const used = new Set<string>();
    for (const src of sources) {
      for (const m of src.matchAll(/\b(?:fail|apiError)\(\s*\d{3},\s*"([a-z_]+)"/g))
        used.add(m[1]!);
      for (const m of src.matchAll(/\bno\(\s*"([a-z_]+)"/g)) used.add(m[1]!);
      for (const m of src.matchAll(/(?<!\w)code: "([a-z_]+)"/g)) used.add(m[1]!);
    }
    for (const c of [
      "window_closed",
      "invalid_media_link",
      "media_link_expired",
      "too_many_contacts",
      "invalid_cursor",
    ])
      expect(used, c).toContain(c);
    for (const code of used) expect(codes, code).toContain(code);
    for (const e of API_ENDPOINTS)
      for (const code of e.errors) expect(errorRow(code), `${e.id}: ${code}`).not.toBeNull();
  });

  it("Settings → API & webhooks lists every event (from the same description) and links the Postman collection", () => {
    const src = readFileSync(join(LIB, "..", "components", "settings", "api-settings.tsx"), "utf8");
    expect(src).toContain("WEBHOOK_EVENTS.map(");
    expect(src).toContain("Events this webhook receives");
    expect(src).toContain("href={POSTMAN_PATH}");
    expect(WEBHOOK_EVENTS.map((e) => e.name)).toEqual([...ALL_WEBHOOK_EVENTS]);
    expect(Object.keys(MEDIA_LIMITS)).toEqual(["image", "video", "audio", "document"]);
  });
});
