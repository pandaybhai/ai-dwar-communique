import { describe, expect, it } from "vitest";
import { blockedHost } from "./flow-http.server";
import { parseWaitDate, readPath, isJsonTemplate } from "./flow-graph";

describe("flow HTTP step guards", () => {
  it("blocks private and internal addresses", () => {
    for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.0.5", "172.20.1.1", "169.254.169.254", "0.0.0.0", "[::1]", "fd00::1", "2130706433", "metadata.google.internal", "db.internal"])
      expect(blockedHost(h), h).toBe(true);
    for (const h of ["api.example.com", "8.8.8.8", "hooks.zapier.com"]) expect(blockedHost(h), h).toBe(false);
  });
  it("reads response paths and checks JSON templates", () => {
    expect(readPath({ data: { items: [{ id: 7 }] } }, "data.items.0.id")).toBe(7);
    expect(isJsonTemplate('{"phone": "{{phone}}"}')).toBe(true);
    expect(isJsonTemplate('{"phone": {{phone}}')).toBe(false);
  });
});

describe("wait until", () => {
  it("parses dd-mm-yyyy and yyyy-mm-dd in the workspace timezone", () => {
    expect(parseWaitDate("25-12-2026", "Asia/Kolkata")?.toISOString()).toBe("2026-12-25T04:30:00.000Z");
    expect(parseWaitDate("2026-12-25 18:30", "Asia/Kolkata")?.toISOString()).toBe("2026-12-25T13:00:00.000Z");
    expect(parseWaitDate("someday", "Asia/Kolkata")).toBeNull();
  });
});
