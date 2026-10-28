import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ReactNode } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Batch 38 item 9 — the developer portal. Every page comes from one
 * description (public-api-spec.ts → developer-portal.ts): every endpoint and
 * event has its page and route; every request sample, in every language, is
 * run against a local server and sends exactly the spec's method, URL, key
 * and body; every signature check accepts our signature and refuses a changed
 * one; OpenAPI and llms.txt cover every endpoint and page; the old
 * /developers/api and its #anchors still land; search finds an endpoint by
 * its name; and no internal word reaches a public page.
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
  DOCS_ROOT,
  LEGACY_ANCHORS,
  VERIFY_SAMPLES,
  allPages,
  eventPath,
  guidePath,
  llmsFullTxt,
  llmsTxt,
  navigation,
  pageByPath,
  pageMarkdown,
  referencePath,
  requestSamples,
  search,
  searchIndex,
  type Sample,
} from "./developer-portal";
import { highlight } from "./code-highlight";
import { ALL_WEBHOOK_EVENTS } from "./public-api";
import {
  API_ENDPOINTS,
  POSTMAN_PATH,
  WEBHOOK_EVENTS,
  exampleUrl,
  postmanCollection,
  type ApiEndpoint,
} from "./public-api-spec";
import { OPENAPI_PATH, openApiDocument } from "./public-api-openapi";
import { signWebhook } from "./public-api-webhooks.server";
import { docHead } from "@/components/developers/doc-head";
import { consoleEndpointFor } from "./public-api-console";
import { htmlText, renderDocPage, renderPortal } from "./test-support/portal-render";

const run = promisify(execFile);
const ROUTES = join(import.meta.dirname, "..", "routes");
const tree = () => readFileSync(join(import.meta.dirname, "..", "routeTree.gen.ts"), "utf8");

/** Every request example: the endpoint's own body and its extra examples. */
function examples(): Array<{ e: ApiEndpoint; body: Record<string, unknown> | undefined }> {
  return API_ENDPOINTS.flatMap((e) => [
    { e, body: e.body },
    ...(e.more ?? []).map((m) => ({ e, body: m.body })),
  ]);
}

async function has(cmd: string, args: string[]): Promise<boolean> {
  try {
    await run(cmd, args, { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

describe("one description, every page", () => {
  it("every endpoint, event and guide has its page, and every page its route", () => {
    const routes = tree();
    for (const e of API_ENDPOINTS) expect(pageByPath(referencePath(e.id)), e.id).not.toBeNull();
    for (const ev of WEBHOOK_EVENTS) expect(pageByPath(eventPath(ev.name)), ev.name).not.toBeNull();
    expect(WEBHOOK_EVENTS.map((ev) => ev.name)).toEqual([...ALL_WEBHOOK_EVENTS]);
    for (const p of allPages()) {
      const dynamic = [
        [`${DOCS_ROOT}/reference/`, "/developers/reference/$endpoint"],
        [`${DOCS_ROOT}/webhooks/`, "/developers/webhooks/$event"],
        [`${DOCS_ROOT}/guides/`, "/developers/guides/$slug"],
      ].find(([prefix]) => p.path.startsWith(prefix!));
      const route = dynamic ? dynamic[1]! : p.path === DOCS_ROOT ? "/developers/" : p.path;
      expect(routes, p.path).toContain(`'${route}': typeof`);
    }
    for (const g of [
      "send-an-invoice-pdf",
      "reply-inside-24-hours",
      "receive-customer-replies",
      "import-contacts-with-consent",
      "verify-webhook-signatures",
      "handle-errors-and-retries",
    ])
      expect(pageByPath(guidePath(g)), g).not.toBeNull();
    for (const p of [
      "quickstart",
      "errors",
      "rate-limits",
      "idempotency",
      "24-hour-window",
      "plans",
      "changelog",
      "reference",
      "webhooks",
    ])
      expect(pageByPath(`${DOCS_ROOT}/${p}`), p).not.toBeNull();
  });

  it("the routes with a name in the address serve their page and a 404 for anything else", async () => {
    for (const [file, param, good] of [
      ["developers.reference.$endpoint", "endpoint", "send-template"],
      ["developers.webhooks.$event", "event", "message.received"],
      ["developers.guides.$slug", "slug", "verify-webhook-signatures"],
    ] as const) {
      const mod = (await import(`../routes/${file}.tsx`)) as {
        Route: {
          options: {
            loader: (a: { params: Record<string, string> }) => unknown;
            head: (a: { params: Record<string, string> }) => { meta?: unknown[] };
          };
        };
      };
      expect(mod.Route.options.loader({ params: { [param]: good } }), file).toBeTruthy();
      expect(
        () => mod.Route.options.loader({ params: { [param]: "no-such-page" } }),
        file,
      ).toThrow();
      expect(
        mod.Route.options.head({ params: { [param]: good } }).meta?.length,
        file,
      ).toBeGreaterThan(3);
    }
  });

  it("an endpoint page shows its purpose, URL, key, parameters, every language, every response and every error", () => {
    for (const e of API_ENDPOINTS) {
      const page = pageByPath(referencePath(e.id))!;
      const html = renderDocPage(page);
      const t = htmlText(html);
      expect(t, e.id).toContain(`${e.method} https://aidwar.in${e.path}`);
      expect(t, e.id).toContain("Bearer API key");
      expect(t, e.id).toContain(page.description);
      for (const f of e.fields ?? []) expect(t, `${e.id} ${f.name}`).toContain(f.name);
      for (const s of requestSamples(e))
        expect(t, `${e.id} ${s.label}`).toContain(htmlText(s.code).trim().slice(0, 80));
      expect(t, e.id).toContain(`${e.response.status}`);
      for (const r of e.responses ?? []) expect(t, `${e.id} ${r.status}`).toContain(`${r.status}`);
      for (const c of e.errors) expect(t, `${e.id} ${c}`).toContain(c);
      // "Try it" opens the Settings console on this endpoint, where the console has it.
      const tryIt = `href="/app/settings?tab=api&amp;try=${e.id}#try-it"`;
      if (consoleEndpointFor(e.id)) expect(html, e.id).toContain(tryIt);
      else expect(html, e.id).not.toContain("try=");
    }
  });

  it("a webhook page shows when it fires, every field of its payload and the signature check in four languages", () => {
    for (const ev of WEBHOOK_EVENTS) {
      const page = pageByPath(eventPath(ev.name))!;
      const t = htmlText(renderDocPage(page));
      expect(t, ev.name).toContain(page.description);
      expect(t, ev.name).toContain(`X-AiDwar-Event: ${ev.name}`);
      for (const key of Object.keys(ev.example)) expect(t, `${ev.name} ${key}`).toContain(key);
      for (const s of VERIFY_SAMPLES)
        expect(t, `${ev.name} ${s.label}`).toContain(htmlText(s.code).trim().slice(0, 60));
    }
  });

  it("every page has a title, a description and a canonical address; the sidebar reaches every page", () => {
    const nav = new Set(
      navigation()
        .flatMap((g) => [...g.items, ...(g.groups ?? []).flatMap((x) => x.items)])
        .map((i) => i.href),
    );
    for (const p of allPages()) {
      const head = docHead(p);
      const title = (head.meta[0] as { title: string }).title;
      expect(title.length, p.path).toBeGreaterThan(5);
      expect(title.length, p.path).toBeLessThanOrEqual(70);
      const description = (head.meta[1] as { content: string }).content;
      expect(description.length, p.path).toBeGreaterThanOrEqual(50);
      expect(description.length, p.path).toBeLessThanOrEqual(160);
      expect(head.links[0]).toEqual({ rel: "canonical", href: `https://aidwar.in${p.path}` });
      expect(nav.has(p.path), p.path).toBe(true);
      expect(pageMarkdown(p), p.path).toContain(`# ${p.title}`);
    }
  });

  it("the overview: three ways in, who it's for, the plan, prices and the key", () => {
    const html = renderDocPage(pageByPath(DOCS_ROOT)!);
    const t = htmlText(html);
    for (const words of [
      "Send invoices & notifications",
      "Two-way WhatsApp chat",
      "Contacts & campaigns",
      "Who it's for",
      "Plan needed",
      "Scale",
      "Enterprise",
      "What a message costs",
    ])
      expect(t).toContain(words);
    expect(html).toContain('href="/app/settings?tab=api"');
    expect(html).toContain(`href="${POSTMAN_PATH}"`);
    expect(html).toContain(`href="${OPENAPI_PATH}"`);
  });

  it("the quickstart: four steps, each saying what success looks like", () => {
    const page = pageByPath(`${DOCS_ROOT}/quickstart`)!;
    const steps = page.sections.filter((s) => /^\d\. /.test(s.title ?? ""));
    expect(steps.map((s) => s.title)).toHaveLength(4);
    const t = htmlText(renderDocPage(page));
    expect(t.match(/Success:/g)?.length).toBeGreaterThanOrEqual(4);
    expect(t).toContain("202");
    expect(t).toContain("Send test event");
  });
});

describe("every code sample is the spec", () => {
  it("highlighting changes no character", () => {
    for (const p of allPages())
      for (const s of p.sections.flatMap((x) => [
        ...(x.code?.samples ?? []),
        ...x.blocks.flatMap((b) => (b.kind === "code" ? b.group.samples : [])),
      ]))
        expect(
          highlight(s.lang, s.code)
            .map((tok) => tok.v)
            .join(""),
          `${p.path} ${s.label}`,
        ).toBe(s.code);
  });

  describe("each request sample, run, sends the spec's method, URL, key and body", () => {
    type Seen = { method: string; url: string; auth: string; body: unknown };
    const seen: Seen[] = [];
    let origin = "";
    let dir = "";
    const server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        seen.push({
          method: req.method ?? "",
          url: req.url ?? "",
          auth: String(req.headers.authorization ?? ""),
          body: raw ? JSON.parse(raw) : undefined,
        });
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      });
    });
    beforeAll(async () => {
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      dir = mkdtempSync(join(tmpdir(), "aidwar-samples-"));
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    /** What the server must see, in order: the spec's method, URL (path values and query filled in), key and body. */
    const expected = () =>
      examples().map(({ e, body }) => {
        const url = new URL(exampleUrl(e));
        return {
          method: e.method,
          url: url.pathname + url.search,
          auth: "Bearer adw_live_sampletest",
          body,
        };
      });
    const samples = (lang: Sample["lang"]) =>
      examples().map(({ e, body }) =>
        requestSamples(e, body)
          .find((s) => s.lang === lang)!
          .code.replaceAll("https://aidwar.in", origin),
      );
    const env = { ...process.env, AIDWAR_API_KEY: "adw_live_sampletest" };
    const check = () => {
      expect(seen).toEqual(expected());
      for (const { e } of examples())
        expect(exampleUrl(e).startsWith(`https://aidwar.in${e.path.split("{")[0]}`), e.id).toBe(
          true,
        );
      seen.length = 0;
    };

    it("cURL", async () => {
      seen.length = 0;
      const file = join(dir, "samples.sh");
      writeFileSync(
        file,
        `set -e\n${samples("curl")
          .map((c) => `${c} > /dev/null`)
          .join("\n")}\n`,
      );
      await run("bash", [file], { env, cwd: dir, timeout: 60_000 });
      check();
    });

    it("Node.js", async () => {
      seen.length = 0;
      const file = join(dir, "samples.mjs");
      writeFileSync(
        file,
        samples("node")
          .map((c) => `{\n${c}\n}`)
          .join("\n"),
      );
      await run(process.execPath, [file], { env, cwd: dir, timeout: 60_000 });
      check();
    });

    it("Python", async (ctx) => {
      if (!(await has("python3", ["-c", "import requests"]))) return ctx.skip();
      seen.length = 0;
      const file = join(dir, "samples.py");
      writeFileSync(
        file,
        samples("python")
          .map(
            (c, i) =>
              `def sample_${i}():\n${c
                .split("\n")
                .map((l) => `    ${l}`)
                .join("\n")}\n\nsample_${i}()\n`,
          )
          .join("\n"),
      );
      await run("python3", ["-I", file], { env, cwd: dir, timeout: 60_000 });
      check();
    });

    it("PHP", async (ctx) => {
      if (!(await has("php", ["-r", "exit(function_exists('curl_init') ? 0 : 1);"])))
        return ctx.skip();
      seen.length = 0;
      const file = join(dir, "samples.php");
      writeFileSync(
        file,
        `<?php\n${samples("php")
          .map((c) => c.replace(/^<\?php\n/, ""))
          .join("\n")}\n`,
      );
      await run("php", [file], { env, cwd: dir, timeout: 60_000 });
      check();
    });
  });

  describe("each signature check accepts our signature and refuses a changed body, a wrong secret and an old delivery", () => {
    const secret = "whsec_sampletest";
    const body = JSON.stringify(WEBHOOK_EVENTS[0]!.example);
    const now = String(Math.floor(Date.now() / 1000));
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    /** [body, timestamp, signature, secret] → expected answer. */
    const cases: Array<[string, string, string, string, boolean]> = [
      [body, now, signWebhook(secret, now, body), secret, true],
      [body.replace("message", "massage"), now, signWebhook(secret, now, body), secret, false],
      [body, now, signWebhook(secret, now, body), "whsec_other", false],
      [body, old, signWebhook(secret, old, body), secret, false],
    ];
    const sample = (lang: string) => VERIFY_SAMPLES.find((s) => s.lang === lang)!.code;
    const dir = mkdtempSync(join(tmpdir(), "aidwar-verify-"));
    const casesFile = join(dir, "cases.json");
    writeFileSync(casesFile, JSON.stringify(cases));
    const answers = (out: string) =>
      out
        .trim()
        .split("\n")
        .map((l) => l.trim() === "true");

    it("Node.js", async () => {
      const file = join(dir, "verify.mjs");
      writeFileSync(
        file,
        `${sample("node")}\nimport { readFileSync } from "node:fs";\nfor (const [b, ts, sig, sec] of JSON.parse(readFileSync(${JSON.stringify(casesFile)}, "utf8"))) console.log(isFromAiDwar(b, { "x-aidwar-timestamp": ts, "x-aidwar-signature": sig }, sec));\n`,
      );
      const { stdout } = await run(process.execPath, [file]);
      expect(answers(stdout)).toEqual(cases.map((c) => c[4]));
    });

    it("Python", async (ctx) => {
      if (!(await has("python3", ["-c", "1"]))) return ctx.skip();
      const file = join(dir, "verify.py");
      writeFileSync(
        file,
        `${sample("python")}\n\nimport json\nfor b, ts, sig, sec, _ in json.load(open(${JSON.stringify(casesFile)})):\n    print("true" if is_from_aidwar(b.encode(), {"X-AiDwar-Timestamp": ts, "X-AiDwar-Signature": sig}, sec) else "false")\n`,
      );
      const { stdout } = await run("python3", ["-I", file]);
      expect(answers(stdout)).toEqual(cases.map((c) => c[4]));
    });

    it("PHP", async (ctx) => {
      if (!(await has("php", ["-v"]))) return ctx.skip();
      const file = join(dir, "verify.php");
      writeFileSync(
        file,
        `${sample("php")}\nforeach (json_decode(file_get_contents(${JSON.stringify(casesFile)}), true) as [$b, $ts, $sig, $sec]) {\n    echo isFromAiDwar($b, ["X-AiDwar-Timestamp" => $ts, "X-AiDwar-Signature" => $sig], $sec) ? "true\\n" : "false\\n";\n}\n`,
      );
      const { stdout } = await run("php", [file]);
      expect(answers(stdout)).toEqual(cases.map((c) => c[4]));
    });

    it("Go", async (ctx) => {
      if (!(await has("go", ["version"]))) return ctx.skip();
      const pkg = mkdtempSync(join(tmpdir(), "aidwar-go-"));
      writeFileSync(join(pkg, "go.mod"), "module webhooks\n\ngo 1.21\n");
      writeFileSync(join(pkg, "verify.go"), sample("go"));
      writeFileSync(
        join(pkg, "verify_test.go"),
        `package webhooks

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"testing"
)

func TestCases(t *testing.T) {
	raw, _ := os.ReadFile(${JSON.stringify(casesFile)})
	var cases [][]any
	json.Unmarshal(raw, &cases)
	for _, c := range cases {
		h := http.Header{}
		h.Set("X-AiDwar-Timestamp", c[1].(string))
		h.Set("X-AiDwar-Signature", c[2].(string))
		fmt.Println(IsFromAiDwar([]byte(c[0].(string)), h, c[3].(string)))
	}
}
`,
      );
      const { stdout } = await run("go", ["test", "-count=1", "-v", "-run", "TestCases", "."], {
        cwd: pkg,
        timeout: 120_000,
        env: { ...process.env, GOFLAGS: "-mod=mod", GOTOOLCHAIN: "local" },
      });
      expect(
        answers(
          stdout
            .split("\n")
            .filter((l) => /^(true|false)$/.test(l.trim()))
            .join("\n"),
        ),
      ).toEqual(cases.map((c) => c[4]));
    }, 180_000);
  });
});

describe("downloads from the same description", () => {
  it("OpenAPI 3.1 has every endpoint with its example body, plan and version, and every webhook event", async () => {
    const doc = openApiDocument() as {
      openapi: string;
      info: { version: string };
      paths: Record<
        string,
        Record<
          string,
          {
            requestBody?: {
              content: { "application/json": { examples: Record<string, { value: unknown }> } };
            };
            "x-plans": string[];
            "x-since": string;
            responses: Record<string, unknown>;
          }
        >
      >;
      webhooks: Record<string, unknown>;
      components: { securitySchemes: Record<string, unknown> };
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.version).toBe("1.2.0");
    expect(doc.components.securitySchemes["bearerAuth"]).toBeDefined();
    for (const e of API_ENDPOINTS) {
      const op = doc.paths[e.path]?.[e.method.toLowerCase()];
      expect(op, e.id).toBeDefined();
      expect(op!.responses[String(e.response.status)], e.id).toBeDefined();
      expect(op!["x-plans"].length, e.id).toBeGreaterThan(0);
      expect(op!["x-since"], e.id).toMatch(/^v1\.\d$/);
      if (e.body) {
        const ex = Object.values(op!.requestBody!.content["application/json"].examples).map(
          (x) => x.value,
        );
        expect(ex, e.id).toEqual([e.body, ...(e.more ?? []).map((m) => m.body)]);
      }
    }
    expect(Object.keys(doc.webhooks).sort()).toEqual([...ALL_WEBHOOK_EVENTS].sort());
    const mod = (await import("../routes/developers.openapi[.]json")) as unknown as {
      Route: { options: { server: { handlers: { GET: () => Promise<Response> } } } };
    };
    const res = await mod.Route.options.server.handlers.GET();
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(doc)));
  });

  it("llms.txt links every page; llms-full.txt is every page in Markdown; both are served at the root and under /developers", async () => {
    const short = llmsTxt();
    const full = llmsFullTxt();
    for (const p of allPages()) {
      expect(short, p.path).toContain(`https://aidwar.in${p.path}`);
      expect(full, p.path).toContain(pageMarkdown(p).split("\n")[0]!);
    }
    for (const [file, body] of [
      ["llms[.]txt", short],
      ["llms-full[.]txt", full],
      ["developers.llms[.]txt", short],
      ["developers.llms-full[.]txt", full],
    ] as const) {
      const mod = (await import(`../routes/${file}.ts`)) as {
        Route: { options: { server: { handlers: { GET: () => Promise<Response> } } } };
      };
      const res = await mod.Route.options.server.handlers.GET();
      expect(res.headers.get("content-type"), file).toContain("text/plain");
      expect(await res.text(), file).toBe(body);
    }
  });
});

describe("the old address", () => {
  it("/developers/api redirects (301) to the overview and keeps its #anchor", async () => {
    const mod = (await import("../routes/developers.api.tsx")) as unknown as {
      Route: { options: { beforeLoad: (a: { location: { hash: string } }) => void } };
    };
    for (const hash of ["send", ""]) {
      let thrown: unknown = null;
      try {
        mod.Route.options.beforeLoad({ location: { hash } });
      } catch (err) {
        thrown = err;
      }
      const options = (thrown as { options: { to: string; hash?: string; statusCode: number } })
        .options;
      expect(options.to).toBe("/developers");
      expect(options.statusCode).toBe(301);
      expect(options.hash).toBe(hash || undefined);
    }
  });

  it("every anchor of the old page lands on the page that now holds it", () => {
    // The old page's anchors: its sections, one per endpoint and one per event.
    const sections = [
      "authentication",
      "send",
      "status",
      "errors",
      "idempotency",
      "webhooks",
      "events",
      "limits",
      "postman",
      "reference",
      "window",
    ];
    const old = [
      ...sections,
      ...API_ENDPOINTS.map((e) => e.id),
      ...WEBHOOK_EVENTS.map((ev) => `event-${ev.name}`),
    ];
    for (const anchor of old) {
      const target = LEGACY_ANCHORS[anchor];
      expect(target, anchor).toBeDefined();
      expect(target === POSTMAN_PATH || pageByPath(target!) !== null, `${anchor} → ${target}`).toBe(
        true,
      );
    }
    const src = readFileSync(join(ROUTES, "developers.index.tsx"), "utf8");
    expect(src).toContain("LEGACY_ANCHORS[anchor]");
  });
});

describe("search", () => {
  it("finds an endpoint by its name, an event by its name and a guide by its subject", () => {
    const index = searchIndex();
    expect(search(index, "send a template")[0]!.href).toBe(referencePath("send-template"));
    expect(search(index, "cancel campaign")[0]!.href).toBe(referencePath("campaign-cancel"));
    expect(search(index, "message.received")[0]!.href).toBe(eventPath("message.received"));
    expect(search(index, "signature").map((r) => r.href)).toContain(
      guidePath("verify-webhook-signatures"),
    );
    expect(search(index, "/api/v1/campaigns/estimate")[0]!.href).toBe(
      referencePath("campaign-estimate"),
    );
    expect(search(index, "zzzz-nothing")).toEqual([]);
    for (const e of API_ENDPOINTS)
      expect(
        search(index, e.title).map((r) => r.href),
        e.id,
      ).toContain(referencePath(e.id));
  });
});

describe("public words only", () => {
  it("no internal word on any page, in llms.txt, OpenAPI or Postman", () => {
    const INTERNAL =
      /\bbatch\s*\d|supabase|lovable|\bvault\b|pg_net|service[ _-]role|phone_number_id|waba_id|\bapp[ _-]?id\b|graph\.facebook|internal_anthropic|claude/i;
    const texts: Array<[string, string]> = [
      ...[...renderPortal()].map(([path, html]): [string, string] => [path, htmlText(html)]),
      ["llms.txt", llmsTxt()],
      ["llms-full.txt", llmsFullTxt()],
      ["openapi.json", JSON.stringify(openApiDocument())],
      ["postman", JSON.stringify(postmanCollection())],
    ];
    for (const [where, t] of texts) expect(t.match(INTERNAL)?.[0], where).toBeUndefined();
  });
});
