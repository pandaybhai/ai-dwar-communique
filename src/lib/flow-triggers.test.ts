import { describe, expect, it } from "vitest";
import { keywordMatches } from "./flow-triggers.server";

describe("keyword trigger matching", () => {
  it("matches contains, exact and starts_with, case- and space-insensitive", () => {
    const kw = { keywords: ["Menu", "price"] };
    expect(keywordMatches({ ...kw, match: "contains" }, "Show me the MENU please")).toBe(true);
    expect(keywordMatches({ ...kw, match: "exact" }, "  menu ")).toBe(true);
    expect(keywordMatches({ ...kw, match: "exact" }, "menu please")).toBe(false);
    expect(keywordMatches({ ...kw, match: "starts_with" }, "Menu card")).toBe(true);
    expect(keywordMatches({ ...kw, match: "starts_with" }, "the menu")).toBe(false);
  });

  it("matches Hindi keywords on normalized Unicode text", () => {
    expect(keywordMatches({ keywords: ["कीमत"], match: "contains" }, "आपकी कीमत क्या है?")).toBe(true);
    expect(keywordMatches({ keywords: ["कीमत"], match: "exact" }, "कीमत")).toBe(true);
  });

  it("never matches with no keywords or empty message", () => {
    expect(keywordMatches({ keywords: [], match: "contains" }, "menu")).toBe(false);
    expect(keywordMatches({ keywords: ["menu"], match: "contains" }, "   ")).toBe(false);
  });
});
