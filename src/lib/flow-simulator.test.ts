import { describe, expect, it } from "vitest";
import { simReply, simStart } from "./flow-simulator";
import { validateGraph, type FlowGraph } from "./flow-graph";

const demo: FlowGraph = {
  nodes: [
    { id: "s", type: "start", data: {} },
    { id: "m", type: "buttons", data: { text: "Hi", variable: "choice", buttons: [{ id: "a", title: "Buy" }, { id: "b", title: "Help" }, { id: "c", title: "Other" }] } },
    { id: "br", type: "branch", data: { branches: [{ id: "x", match: "all", conditions: [{ subject: "var:choice", op: "eq", value: "Buy" }] }] } },
    { id: "p", type: "ask", data: { text: "Pincode?", variable: "pin", validation: "pincode", retries: 2 } },
    { id: "t", type: "tag", data: { tag: "Buyer" } },
    { id: "as", type: "assign", data: {} },
    { id: "e", type: "end", data: {} },
  ],
  edges: [
    { id: "1", source: "s", target: "m" }, { id: "2", source: "m", target: "br", sourceHandle: "a" },
    { id: "3", source: "m", target: "e", sourceHandle: "b" }, { id: "4", source: "m", target: "e", sourceHandle: "c" },
    { id: "5", source: "br", target: "p", sourceHandle: "x" }, { id: "6", source: "br", target: "e", sourceHandle: "else" },
    { id: "7", source: "p", target: "t" }, { id: "8", source: "t", target: "as" }, { id: "9", source: "as", target: "e" },
  ].map((e) => ({ sourceHandle: "next", ...e })),
};

describe("flow simulator", () => {
  it("validates the demo graph", () => expect(validateGraph(demo)).toEqual([]));
  it("runs menu → branch → validated pincode → tag → assign", () => {
    let s = simStart(demo);
    expect(s.waiting).toBe(true);
    s = simReply(demo, s, "Buy");
    expect(s.nodeId).toBe("p");
    s = simReply(demo, s, "12");
    expect(s.waiting).toBe(true);
    s = simReply(demo, s, "110001");
    expect(s.done).toBe(true);
    expect(s.ctx.vars["pin"]).toBe("110001");
    expect(s.ctx.tags).toContain("Buyer");
    expect(s.path).toEqual(["s", "m", "br", "p", "t", "as", "e"]);
  });
  it("flags unconnected outputs", () => {
    const g = { ...demo, edges: demo.edges.filter((e) => e.id !== "3") };
    expect(validateGraph(g).length).toBeGreaterThan(0);
  });
});
