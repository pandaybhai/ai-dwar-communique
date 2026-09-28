import { describe, expect, it } from "vitest";
import { computeVariable, evalArith, evalCondition, isBusinessOpen, type RunContext } from "./flow-graph";

const ctx = (vars: Record<string, unknown> = {}): RunContext => ({ vars, contact: { name: "Asha", phone: "91", attributes: {} }, tags: [], now: new Date("2026-09-28T06:00:00Z"), timezone: "Asia/Kolkata" });

describe("flow graph helpers", () => {
  it("calculates without eval", () => {
    expect(evalArith("2+3*(4-1)")).toBe(11);
    expect(evalArith("2+")).toBeNull();
    expect(computeVariable({ mode: "math", expression: "{{qty}} * 499" }, ctx({ qty: "3" }))).toBe("1497");
    expect(computeVariable({ mode: "math", expression: "alert(1)" }, ctx())).toBeNull();
  });
  it("joins text and dates", () => {
    expect(computeVariable({ mode: "value", expression: "Hi {{name}}" }, ctx())).toBe("Hi Asha");
    expect(computeVariable({ mode: "date", expression: "today+7" }, ctx())).toBe("05-10-2026");
  });
  it("regex conditions", () => {
    expect(evalCondition({ subject: "var:o", op: "matches", value: "^ORD-\\d{4}$" }, ctx({ o: "ord-1234" }))).toBe(true);
    expect(evalCondition({ subject: "var:o", op: "matches", value: "(" }, ctx({ o: "x" }))).toBe(false);
  });
  it("business hours with holidays", () => {
    const bh = { days: { "1": ["09:00", "18:00"] as [string, string] }, holidays: [] };
    expect(isBusinessOpen(bh, new Date("2026-09-28T06:00:00Z"), "Asia/Kolkata")).toBe(true); // Mon 11:30 IST
    expect(isBusinessOpen({ ...bh, holidays: ["2026-09-28"] }, new Date("2026-09-28T06:00:00Z"), "Asia/Kolkata")).toBe(false);
    expect(isBusinessOpen(bh, new Date("2026-09-28T14:00:00Z"), "Asia/Kolkata")).toBe(false);
  });
});
