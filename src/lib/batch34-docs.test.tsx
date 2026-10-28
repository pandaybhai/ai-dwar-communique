import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComponentType, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * Batch 34 item 6 — the public docs, on the shared footer. Since Batch 38
 * item 9 they are the developer portal under /developers (/developers/api
 * redirects there, its #anchors still land): the same facts, checked across
 * the portal's pages.
 * The examples are the real thing: the curl body passes the server's own
 * request check, the signature-check code accepts our signature and refuses
 * a changed or old one, and the limits are the ones the server enforces.
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

import {
  API_ERRORS,
  RATE_PER_KEY_PER_MIN,
  RATE_PER_WORKSPACE_PER_MIN,
  VERIFY_SIGNATURE_EXAMPLE,
  apiReadyTemplates,
  curlExample,
  javascriptExample,
} from "./public-api";
import * as server from "./public-api.server";
import { signWebhook } from "./public-api-webhooks.server";
import { parseSendRequest } from "./public-api-send.server";
import { INVOICE_TEMPLATE_COMPONENTS } from "./test-support/public-api-world";
import { htmlText, renderPortal } from "./test-support/portal-render";

const text = htmlText;

/** The whole portal, as served. */
async function page(): Promise<string> {
  return [...renderPortal().values()].join("\n");
}

describe("/developers/api", () => {
  it("is a real public route with the shared header and footer", async () => {
    const tree = readFileSync(join(import.meta.dirname, "..", "routeTree.gen.ts"), "utf8");
    expect(tree).toContain("'/developers/api': typeof");
    expect(tree).toContain("'/developers/': typeof");
    // The old address redirects to the portal; the portal's frame has the shared footer.
    const old = readFileSync(
      join(import.meta.dirname, "..", "routes", "developers.api.tsx"),
      "utf8",
    );
    expect(old).toMatch(/redirect\(\{\s*to: "\/developers",/);
    const shell = readFileSync(
      join(import.meta.dirname, "..", "components", "developers", "docs-shell.tsx"),
      "utf8",
    );
    expect(shell).toContain("<SiteFooter />");
    expect(shell).not.toMatch(/<footer\b/);
    const footer = readFileSync(
      join(import.meta.dirname, "..", "components", "site-footer.tsx"),
      "utf8",
    );
    expect(footer).toContain('to: "/pricing"'); // the footer's links
    expect(footer).toContain('to: "/privacy"');
    const sitemap = (await import("../routes/sitemap[.]xml")) as unknown as {
      Route: { options: { server: { handlers: { GET: () => Promise<Response> } } } };
    };
    const xml = await (await sitemap.Route.options.server.handlers.GET()).text();
    expect(xml).toContain("<loc>https://aidwar.in/developers</loc>");
    expect(xml).toContain("<loc>https://aidwar.in/developers/quickstart</loc>");
  });

  it("covers authentication, the send call (curl + JavaScript), status, errors, idempotency, webhooks, limits and the 24-hour rule", async () => {
    const t = text(await page());
    for (const heading of [
      "Authentication",
      "Send a template",
      "A message's status",
      "Errors",
      "Idempotency",
      "Webhooks",
      "Rate limits",
      "The 24-hour window",
    ])
      expect(t).toContain(heading);
    expect(t).toContain("Authorization: Bearer adw_live_");
    expect(t).toContain('curl -X POST "https://aidwar.in/api/v1/messages/template"');
    expect(t).toContain('readFileSync("INV-1001.pdf").toString("base64")');
    expect(t).toContain("GET https://aidwar.in/api/v1/messages/{message_id}");
    for (const status of ["400", "401", "402", "403", "404", "409", "413", "429", "5xx"])
      expect(API_ERRORS.map((e) => e.status)).toContain(status);
    for (const e of API_ERRORS) expect(t).toContain(e.meaning);
    expect(t).toContain('X-AiDwar-Signature: sha256=HMAC-SHA256(secret, timestamp + "." + body)');
    expect(t).toContain(
      `${RATE_PER_KEY_PER_MIN} requests a minute per key and ${RATE_PER_WORKSPACE_PER_MIN} a minute per workspace`,
    );
    expect(t).toContain("Templates can be sent at any time");
    expect(t).toContain("message credit rates on the pricing page");
  });

  it("the limits in the docs are the server's", () => {
    expect(server.RATE_PER_KEY_PER_MIN).toBe(RATE_PER_KEY_PER_MIN);
    expect(server.RATE_PER_WORKSPACE_PER_MIN).toBe(RATE_PER_WORKSPACE_PER_MIN);
  });

  it("every error code the server answers with is in the table", () => {
    const codes = new Set(API_ERRORS.flatMap((e) => e.codes));
    const sources = [
      "public-api.server.ts",
      "public-api-send.server.ts",
      "public-api-messages.server.ts",
    ].map((f) => readFileSync(join(import.meta.dirname, f), "utf8"));
    sources.push(
      readFileSync(
        join(import.meta.dirname, "..", "routes", "api", "v1", "messages", "template.ts"),
        "utf8",
      ),
    );
    const used = new Set<string>();
    for (const src of sources) {
      for (const m of src.matchAll(/(?:fail|apiError)\(\s*\d{3},\s*"([a-z_]+)"/g)) used.add(m[1]!);
      for (const m of src.matchAll(/code: "([a-z_]+)"/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(15);
    for (const code of used) expect(codes, code).toContain(code);
  });

  it("the curl example's body passes the server's own request check", () => {
    const curl = curlExample({
      origin: "https://aidwar.in",
      templateName: "invoice_document",
      language: "en_US",
      paramCount: 3,
    });
    const json = curl.slice(curl.indexOf("-d '") + 4, curl.lastIndexOf("'"));
    const parsed = parseSendRequest(JSON.parse(json), null);
    expect("status" in parsed).toBe(false);
    expect(parsed).toMatchObject({
      templateName: "invoice_document",
      bodyParams: ["Asha", "INV-1001", "2,500.00"],
      idempotencyKey: "inv-1001",
    });
    expect(
      javascriptExample({ origin: "https://aidwar.in", templateName: "x", paramCount: 1 }),
    ).toContain("process.env.AIDWAR_API_KEY");
  });

  it("the signature-check code in the docs accepts our signature and refuses a changed body, a wrong secret or an old timestamp", () => {
    const code =
      VERIFY_SIGNATURE_EXAMPLE.replace(/^import .*$/m, "").replace("export function", "function") +
      "\nreturn isFromAiDwar;";
    const isFromAiDwar = new Function("createHmac", "timingSafeEqual", code)(
      createHmac,
      timingSafeEqual,
    ) as (body: string, headers: Record<string, string>, secret: string) => boolean;
    const secret = "whsec_example";
    const body = JSON.stringify({ event: "message.read", message_id: "m1" });
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = {
      "x-aidwar-timestamp": ts,
      "x-aidwar-signature": signWebhook(secret, ts, body),
    };
    expect(isFromAiDwar(body, headers, secret)).toBe(true);
    expect(isFromAiDwar(body.replace("read", "sent"), headers, secret)).toBe(false);
    expect(isFromAiDwar(body, headers, "whsec_other")).toBe(false);
    const old = String(Number(ts) - 3600);
    expect(
      isFromAiDwar(
        body,
        { "x-aidwar-timestamp": old, "x-aidwar-signature": signWebhook(secret, old, body) },
        secret,
      ),
    ).toBe(false);
  });
});

describe("Settings → API & webhooks", () => {
  it("links to the docs and builds its curl from the workspace's own approved document templates", () => {
    const src = readFileSync(
      join(import.meta.dirname, "..", "components", "settings", "api-settings.tsx"),
      "utf8",
    );
    expect(src).toContain("href={DOCS_PATH}");
    expect(src).toContain("curlExample({");
    expect(src).toContain("apiReadyTemplates(");
    expect(existsSync(join(import.meta.dirname, "..", "routes", "developers.index.tsx"))).toBe(
      true,
    );
  });

  it("apiReadyTemplates: approved, document header, nothing else to fill", () => {
    expect(
      apiReadyTemplates([
        {
          name: "invoice_ready",
          language: "en",
          status: "APPROVED",
          components: INVOICE_TEMPLATE_COMPONENTS,
        },
        {
          name: "invoice_pending",
          language: "en",
          status: "PENDING",
          components: INVOICE_TEMPLATE_COMPONENTS,
        },
        {
          name: "plain",
          language: "en",
          status: "APPROVED",
          components: [{ type: "BODY", text: "Hi {{1}}" }],
        },
        {
          name: "with_link",
          language: "en",
          status: "APPROVED",
          components: [
            ...INVOICE_TEMPLATE_COMPONENTS,
            { type: "BUTTONS", buttons: [{ type: "URL", text: "Pay", url: "https://x/{{1}}" }] },
          ],
        },
      ]),
    ).toEqual([{ name: "invoice_ready", language: "en", paramCount: 3 }]);
  });
});
