import { afterEach, describe, expect, it, vi } from "vitest";
import { blockedHost, interpolateUrl, loadHttpSecrets, runHttpRequest, sealHttpSecrets } from "./flow-http.server";
import type { FlowGraph, RunContext } from "./flow-graph";
import { fakeDb } from "./test-support/fake-db";

const ctx = (vars: Record<string, unknown> = {}): RunContext => ({
  vars,
  contact: { name: "Asha", phone: "919999999999", attributes: {} },
  tags: [],
  now: new Date("2026-09-28T06:00:00Z"),
  timezone: "Asia/Kolkata",
});

/** fetch stub: DNS-over-HTTPS answers from `dns`, everything else from `reply`. */
function stubFetch(dns: Record<string, string[]> | "fail", reply: () => Response = () => new Response('{"ok":1}', { status: 200 })) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    if (String(url).startsWith("https://cloudflare-dns.com/")) {
      if (dns === "fail") return new Response("", { status: 502 });
      const u = new URL(String(url));
      const type = u.searchParams.get("type") === "AAAA" ? 28 : 1;
      const addrs = (dns[u.searchParams.get("name") ?? ""] ?? []).filter((a) => (type === 28) === a.includes(":"));
      return Response.json({ Status: 0, Answer: addrs.map((data) => ({ type, data })) });
    }
    return reply();
  });
  return calls;
}
afterEach(() => vi.unstubAllGlobals());
const requests = (calls: Array<{ url: string; init?: RequestInit }>) => calls.filter((c) => !c.url.startsWith("https://cloudflare-dns.com/"));

describe("HTTP step: addresses (item 4)", () => {
  it("blocks a name that resolves to a private, loopback, link-local, CGNAT or metadata address", async () => {
    for (const ip of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "100.64.1.1", "192.168.1.1", "::1", "fe80::1", "fd12::1", "::ffff:10.0.0.1", "::ffff:a00:1", "2002:a00:1::1", "64:ff9b::a00:1", "2001:0:4136::1"]) {
      const calls = stubFetch({ "sneaky.example.com": [ip] });
      const res = await runHttpRequest({ url: "https://sneaky.example.com/x" }, ctx());
      expect(res.error, ip).toBe("private_address_blocked");
      expect(requests(calls), ip).toEqual([]);
      vi.unstubAllGlobals();
    }
  });

  it("fails closed when the DNS lookup fails or finds nothing", async () => {
    stubFetch("fail");
    expect((await runHttpRequest({ url: "https://api.example.com/" }, ctx())).error).toBe("dns_lookup_failed");
    vi.unstubAllGlobals();
    stubFetch({});
    expect((await runHttpRequest({ url: "https://nothing.example.com/" }, ctx())).error).toBe("dns_no_address");
  });

  it("unchanged: a public address works; redirects are not followed", async () => {
    let calls = stubFetch({ "api.example.com": ["93.184.216.34"] });
    const ok = await runHttpRequest({ url: "https://api.example.com/x", save: [{ path: "ok", variable: "v" }] }, ctx());
    expect(ok).toMatchObject({ ok: true, status: 200, saved: { v: "1" } });
    expect(requests(calls)[0]!.init?.redirect).toBe("manual");
    vi.unstubAllGlobals();
    calls = stubFetch({ "api.example.com": ["93.184.216.34"] }, () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } }));
    expect((await runHttpRequest({ url: "https://api.example.com/x" }, ctx())).error).toBe("redirect_not_followed");
    expect(requests(calls)).toHaveLength(1);
  });

  it("unchanged: literal private hosts are refused before any lookup", async () => {
    const calls = stubFetch({});
    expect((await runHttpRequest({ url: "http://127.0.0.1:8080/" }, ctx())).error).toBe("private_address_blocked");
    expect(calls).toEqual([]);
    expect(blockedHost("100.100.1.1")).toBe(true);
    expect(blockedHost("8.8.8.8")).toBe(false);
    expect(blockedHost("[2606:4700::1111]")).toBe(false);
  });
});

describe("HTTP step: URL variables are encoded (item 4)", () => {
  it("a variable can't change the host, path or query", () => {
    expect(interpolateUrl("https://api.x.in/o?q={{a}}", ctx({ a: "1&admin=true#x" }))).toBe("https://api.x.in/o?q=1%26admin%3Dtrue%23x");
    expect(interpolateUrl("https://api.x.in/u/{{a}}", ctx({ a: "../../admin" }))).toBe("https://api.x.in/u/..%2F..%2Fadmin");
    expect(interpolateUrl("https://api.x.in/{{name}}", ctx())).toBe("https://api.x.in/Asha");
  });
  it("the encoded URL is what gets requested", async () => {
    const calls = stubFetch({ "api.x.in": ["93.184.216.34"] });
    await runHttpRequest({ url: "https://api.x.in/o?q={{a}}" }, ctx({ a: "a b&c" }));
    expect(requests(calls)[0]!.url).toBe("https://api.x.in/o?q=a%20b%26c");
  });
});

describe("HTTP step: header values are write-only secrets (item 4)", () => {
  const graph = (headers: unknown[], url = "https://api.x.in/leads"): FlowGraph => ({
    nodes: [{ id: "h", type: "http", data: { url, headers } }],
    edges: [],
  });
  const headersOut = (gr: FlowGraph) => gr.nodes[0]!.data["headers"];

  it("a typed value goes to secure storage; the graph keeps only a reference", async () => {
    const db = fakeDb(() => ({ data: [], error: null }), (c) => (c.name === "flow_http_secret_set" ? { data: "sec-new", error: null } : undefined));
    const out = await sealHttpSecrets(db.supabase, "org", "flow-1", graph([{ key: "Authorization", value: "Bearer abc" }]));
    expect(out.error).toBeNull();
    expect(headersOut(out.graph)).toEqual([{ key: "Authorization", value: "", secret_id: "sec-new" }]);
    expect(db.rpcs[0]).toEqual({ name: "flow_http_secret_set", args: { p_org: "org", p_flow: "flow-1", p_id: null, p_scope: "https://api.x.in/leads", p_secret: "Bearer abc" } });
    expect(JSON.stringify(out.graph)).not.toContain("abc");
  });

  it("fails closed: if the value can't be stored, nothing is saved", async () => {
    const db = fakeDb(() => ({ data: [], error: null }), () => ({ data: null, error: { code: "PGRST202", message: "missing" } }));
    const out = await sealHttpSecrets(db.supabase, "org", "flow-1", graph([{ key: "X-Key", value: "k" }]));
    expect(out.error).toMatch(/securely/);
  });

  it("a saved secret survives a save, but not a change of address or a foreign reference", async () => {
    const rows = [{ id: "sec-mine", flow_id: "flow-1", scope: "https://api.x.in/leads" }];
    const db = () => fakeDb((op) => (op.table === "flow_http_secrets" ? { data: rows, error: null } : undefined));
    const kept = await sealHttpSecrets(db().supabase, "org", "flow-1", graph([{ key: "A", value: "", secret_id: "sec-mine" }]));
    expect(headersOut(kept.graph)).toEqual([{ key: "A", value: "", secret_id: "sec-mine" }]);
    const moved = await sealHttpSecrets(db().supabase, "org", "flow-1", graph([{ key: "A", value: "", secret_id: "sec-mine" }], "https://evil.example/leads"));
    expect(headersOut(moved.graph)).toEqual([{ key: "A", value: "" }]);
    const foreign = await sealHttpSecrets(db().supabase, "org", "flow-1", graph([{ key: "A", value: "", secret_id: "sec-other-workspace" }]));
    expect(headersOut(foreign.graph)).toEqual([{ key: "A", value: "" }]);
  });

  it("unchanged: flows without an HTTP step are stored exactly as sent", async () => {
    const db = fakeDb(() => undefined);
    const gr: FlowGraph = { nodes: [{ id: "t", type: "text", data: { text: "hi" } }], edges: [] };
    expect((await sealHttpSecrets(db.supabase, "org", "flow-1", gr)).graph).toBe(gr);
    expect(db.ops).toEqual([]);
  });

  it("values are loaded server-side only for the address they were saved for", async () => {
    const db = fakeDb(() => undefined, (c) => (c.name === "flow_http_secrets_get" ? { data: [{ id: "sec-1", secret: "Bearer abc" }], error: null } : undefined));
    const spec = await loadHttpSecrets(db.supabase, "org", { url: "https://api.x.in/leads?x=1", headers: [{ key: "A", value: "", secret_id: "sec-1" }] });
    expect(spec.headers).toEqual([{ key: "A", value: "Bearer abc", secret_id: "sec-1" }]);
    expect(db.rpcs[0]!.args).toEqual({ p_org: "org", p_ids: ["sec-1"], p_scope: "https://api.x.in/leads" });
  });

  it("a secret that can't be loaded fails the step instead of sending without it", async () => {
    const calls = stubFetch({ "api.x.in": ["93.184.216.34"] });
    const res = await runHttpRequest({ url: "https://api.x.in/leads", headers: [{ key: "A", value: "", secret_id: "sec-1" }] }, ctx());
    expect(res.error).toBe("header_secret_unavailable");
    expect(calls).toEqual([]);
  });

  it("unchanged: plain (legacy) header values in an old published graph are still sent", async () => {
    const calls = stubFetch({ "api.x.in": ["93.184.216.34"] });
    await runHttpRequest({ url: "https://api.x.in/leads", headers: [{ key: "X-Key", value: "legacy" }] }, ctx());
    expect(new Headers(requests(calls)[0]!.init?.headers).get("x-key")).toBe("legacy");
  });
});
