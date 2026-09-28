import { describe, expect, it } from "vitest";
import { tagExpression } from "./segments";

// Tiny PostgREST-expression evaluator for id.in / id.not.in / id.not.is.null.
function matches(expr: string, id: string): boolean {
  if (expr === "id.not.is.null") return true;
  if (expr === "id.is.null") return false;
  const m = expr.match(/^id\.(not\.)?in\.\((.*)\)$/)!;
  const inSet = m[2]!.split(",").includes(id);
  return m[1] ? !inSet : inSet;
}

describe("segment tag rule", () => {
  const contacts = { tagged: ["VIP"], other: ["Lead"], none: [] as string[] };
  const taggedIds = ["tagged"];

  it("does not have tag: returns untagged and differently tagged contacts", () => {
    const expr = tagExpression("not_has", taggedIds);
    const out = Object.keys(contacts).filter((id) => matches(expr, id));
    expect(out.sort()).toEqual(["none", "other"]);
  });

  it("does not have tag with nobody tagged returns everyone", () => {
    const expr = tagExpression("not_has", []);
    expect(Object.keys(contacts).every((id) => matches(expr, id))).toBe(true);
  });

  it("has tag returns only tagged", () => {
    const expr = tagExpression("has", taggedIds);
    expect(Object.keys(contacts).filter((id) => matches(expr, id))).toEqual(["tagged"]);
  });
});
