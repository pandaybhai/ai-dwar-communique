import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EXAMPLE_PROMPTS, MCP_TOOL_LIST } from "./mcp-connect";
import { LIBRARY_PROMPTS } from "./mcp-prompts";
import { CONSENT_CAN, CONSENT_CANNOT } from "./oauth-consent";

vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => null }));

/**
 * Batch 54 — /developers#mcp lists every tool the server has (read only /
 * draft or preview / acts after you confirm) and the prompts round 2
 * unlocks; the consent page's promises still describe what the tools do.
 */

describe("/developers#mcp after round 2", () => {
  it("the tool list is exactly the server's tools, and each kind matches the tool's annotations", async () => {
    const { ALL_MCP_TOOLS } = await import("./mcp-server.server");
    expect(MCP_TOOL_LIST.map((t) => t.name).sort()).toEqual(ALL_MCP_TOOLS.map((t) => t.name).sort());
    const by = new Map(ALL_MCP_TOOLS.map((t) => [t.name, t]));
    for (const t of MCP_TOOL_LIST) {
      const tool = by.get(t.name)!;
      if (t.kind === "confirm") expect(tool.destructive, t.name).toBe(true);
      else expect(tool.destructive, t.name).toBe(false);
      if (t.kind === "read") expect(tool.readOnly, t.name).toBe(true);
    }
  });

  it("shows the tools in their three groups and every prompt, round 2's included", async () => {
    const { McpSection } = await import("@/components/developers/mcp-section");
    const html = renderToStaticMarkup(<McpSection />);
    expect(html).toContain('id="mcp-tools"');
    for (const label of ["Read only", "Draft or preview (sends nothing)", "Acts after you confirm"]) expect(html).toContain(label);
    for (const t of MCP_TOOL_LIST) expect(html).toContain(`>${t.name}<`);
    // Round 2's six prompts live in Batch 53's shared library, each naming round-2 tools.
    const round2 = [
      "Draft a campaign for my newest products",
      "How much did my last campaign sell?",
      "Write a new template for our winter sale and submit it",
      "Move tomorrow's campaign to 7pm",
      "Tag everyone who replied YES as VIP",
      "What is Aiden waiting on me for?",
    ];
    const { ROUND2_TOOLS } = await import("./mcp-tools-r2.server");
    const r2 = new Set(ROUND2_TOOLS.map((t) => t.name));
    for (const text of round2) {
      const p = LIBRARY_PROMPTS.find((x) => x.text === text);
      expect(p, text).toBeTruthy();
      expect(p!.tools.some((t) => r2.has(t)), text).toBe(true);
      expect(EXAMPLE_PROMPTS).toContain(text);
    }
    for (const p of EXAMPLE_PROMPTS) expect(html).toContain(p.replace(/'/g, "&#x27;"));
    expect(html).toContain("An answer to Aiden is always your own words.");
  });

  it("the consent page promises what round 2 does, and still that nothing happens without a yes", () => {
    expect(CONSENT_CAN.join(" ")).toMatch(/templates, products/);
    expect(CONSENT_CAN.join(" ")).toContain("your answers to Aiden");
    expect(CONSENT_CAN[2]).toBe("Sending, submitting, changing or switching anything on always needs your confirmation.");
    expect(CONSENT_CANNOT).toContain("can't message a customer on its own");
  });
});
