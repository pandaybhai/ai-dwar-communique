import { describe, expect, it } from "vitest";
import { cleanConfig, importStartsFlows } from "./flow-trigger-config";
import { isQuestionText } from "./teach-guard";
import { maskHttpSecrets, secretScope, validateGraph, type FlowGraph } from "./flow-graph";
import { marketingAllowed } from "./flow-engine.server";

describe("keyword triggers default to exact for NEW triggers (item 9)", () => {
  it("a new trigger with no mode is exact", () => {
    expect(cleanConfig("keyword", { keywords: ["menu"] }, "exact")["match"]).toBe("exact");
  });
  it("unchanged: edits keep contains when no mode is given, and an explicit mode always wins", () => {
    expect(cleanConfig("keyword", { keywords: ["menu"] })["match"]).toBe("contains");
    expect(cleanConfig("keyword", { keywords: ["menu"], match: "contains" }, "exact")["match"]).toBe("contains");
    expect(cleanConfig("keyword", { keywords: ["menu"], match: "starts_with" }, "exact")["match"]).toBe("starts_with");
  });
  it("unchanged: other kinds are cleaned as before", () => {
    expect(cleanConfig("no_reply", { days: 500 })).toEqual({ days: 90 });
    expect(cleanConfig("tag_added", { tag: " vip " })).toEqual({ tag: "vip" });
  });
});

describe("CSV import starts flows only when it opts in (item 8)", () => {
  it("off unless start_flows is exactly true", () => {
    expect(importStartsFlows({})).toBe(false);
    expect(importStartsFlows({ start_flows: "true" })).toBe(false);
    expect(importStartsFlows({ start_flows: true })).toBe(true);
  });
});

describe("teach-guard question words (item 9)", () => {
  it("'kitne …' is a question again", () => {
    expect(isQuestionText("kitne din lagenge delivery me")).toBe(true);
  });
  it("unchanged: other words and answers", () => {
    expect(isQuestionText("kitna time lagega")).toBe(true);
    expect(isQuestionText("We deliver in 3 days")).toBe(false);
  });
});

const g = (nodes: FlowGraph["nodes"]): FlowGraph => ({
  nodes: [{ id: "s", type: "start", data: {} }, ...nodes, { id: "e", type: "end", data: {} }],
  edges: [
    { id: "e1", source: "s", target: nodes[0]!.id, sourceHandle: "next" },
    { id: "e2", source: nodes[0]!.id, target: "e", sourceHandle: "next" },
  ],
});
const msgs = (graph: FlowGraph, now = new Date("2026-09-28T06:00:00Z")) => validateGraph(graph, { now, timezone: "Asia/Kolkata" }).map((p) => p.message);

describe("wait until beyond the run age limit (item 6)", () => {
  it("a fixed date more than 14 days away can't be published", () => {
    const out = msgs(g([{ id: "w", type: "wait_until", data: { date: "2026-10-20" } }]));
    expect(out.some((m) => m.includes("more than 14 days away"))).toBe(true);
  });
  it("unchanged: dates within 14 days, field dates and {{variable}} dates are fine", () => {
    expect(msgs(g([{ id: "w", type: "wait_until", data: { date: "2026-10-05" } }]))).toEqual([]);
    expect(msgs(g([{ id: "w", type: "wait_until", data: { mode: "field", field: "contact.birthday" } }]))).toEqual([]);
    expect(msgs(g([{ id: "w", type: "wait_until", data: { date: "{{when}}" } }])).filter((m) => m.includes("14 days"))).toEqual([]);
  });
});

describe("email step recipients (item 5)", () => {
  it("more than 5 recipients can't be published", () => {
    const data = { subject: "Hi", user_ids: ["u1", "u2", "u3"], addresses: "a@x.in, b@x.in, c@x.in" };
    expect(msgs(g([{ id: "m", type: "email_team", data }]))).toContain("Email at most 5 people from one step.");
  });
  it("unchanged: up to 5 is fine", () => {
    expect(msgs(g([{ id: "m", type: "email_team", data: { subject: "Hi", user_ids: ["u1"], addresses: "a@x.in" } }]))).toEqual([]);
  });
});

describe("marketing templates need opt-in (item 8)", () => {
  it("MARKETING only to opted-in contacts; other categories unchanged", () => {
    expect(marketingAllowed("MARKETING", false)).toBe(false);
    expect(marketingAllowed("marketing", true)).toBe(true);
    expect(marketingAllowed("UTILITY", false)).toBe(true);
    expect(marketingAllowed(null, false)).toBe(true);
  });
});

describe("HTTP header secrets in exports/imports (item 4)", () => {
  it("masks header values and secret references; other steps untouched", () => {
    const graph = g([{ id: "h", type: "http", data: { url: "https://api.x.in/a", headers: [{ key: "Authorization", value: "Bearer abc", secret_id: "sec-1" }] } }]);
    const masked = maskHttpSecrets(graph);
    expect(masked.nodes.find((n) => n.id === "h")!.data["headers"]).toEqual([{ key: "Authorization", value: "" }]);
    expect(JSON.stringify(masked)).not.toContain("abc");
    expect(JSON.stringify(masked)).not.toContain("sec-1");
    expect(masked.nodes.find((n) => n.id === "s")).toEqual(graph.nodes[0]);
  });
  it("binds a secret to scheme + host + path, ignoring the query", () => {
    expect(secretScope("HTTPS://API.X.in/Leads?x={{name}}")).toBe("https://api.x.in/Leads");
    expect(secretScope("https://legit.in@evil.com/p")).not.toBe(secretScope("https://legit.in/p"));
    expect(secretScope("not a url")).toBe("");
  });
});
