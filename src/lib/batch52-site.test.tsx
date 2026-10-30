import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { CONNECT_CLIENTS, EXAMPLE_PROMPTS, MCP_URL } from "./mcp-connect";

/**
 * Batch 52 — AiDwar MCP on the public site: /developers#mcp (the URL, the
 * connect steps for Claude, ChatGPT, Codex and Cursor with their docs
 * linked, prompts to try), the new_site landing's "Works with …" section
 * with its animated example, and "Connect your AI assistant" on every plan
 * of the new pricing. Product names as text only; the classic landing and
 * pricing are untouched.
 */

const src = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");

describe("/developers#mcp", () => {
  it("gives the URL, all four clients with their own docs, and five prompts", async () => {
    const { McpSection } = await import("@/components/developers/mcp-section");
    const html = renderToStaticMarkup(<McpSection />);
    expect(html).toContain('id="mcp"');
    expect(html).toContain(MCP_URL);
    expect(CONNECT_CLIENTS.map((c) => c.key)).toEqual(["claude", "chatgpt", "codex", "cursor"]);
    for (const c of CONNECT_CLIENTS) {
      expect(html).toContain(c.source.replace(/&/g, "&amp;"));
      expect(c.source).toMatch(/^https:\/\/(support\.claude\.com|help\.openai\.com|learn\.chatgpt\.com|cursor\.com)\//);
    }
    const text = html.replace(/<[^>]+>/g, "");
    expect(text).toContain("codex mcp add aidwar --url https://aidwar.in/mcp");
    expect(text).toContain("&quot;url&quot;: &quot;https://aidwar.in/mcp&quot;");
    // Batch 53: the prompts are the shared library (src/lib/mcp-prompts.ts).
    expect(EXAMPLE_PROMPTS.length).toBeGreaterThanOrEqual(5);
    expect(EXAMPLE_PROMPTS).toContain("Draft a Diwali campaign to customers tagged VIP");
    expect(EXAMPLE_PROMPTS).toContain("How did my last campaign do?");
    expect(EXAMPLE_PROMPTS).toContain("Build a welcome flow that asks new customers their size and city");
    // React escapes an apostrophe as &#x27; (Batch 54's "Move tomorrow's campaign to 7pm").
    for (const p of EXAMPLE_PROMPTS) expect(html).toContain(p.replace(/'/g, "&#x27;"));
    expect(html).not.toContain("<img");
    expect(src("components/developers/overview-page.tsx")).toContain("<McpSection />");
  });
});

describe("new_site landing and pricing", () => {
  it("the landing has the Works-with section and the animated example, labelled as one", async () => {
    const landing = src("components/site-v2/new-landing.tsx");
    expect(landing).toContain("Works with Claude, ChatGPT, Codex and Cursor.");
    expect(landing).toContain("<AssistantDemo />");
    expect(landing).toContain("An example with a sample shop.");
    expect(landing).toContain('href="/developers#mcp"');
    const { AssistantDemo } = await import("@/components/site-v2/demos");
    const html = renderToStaticMarkup(<AssistantDemo />);
    expect(html).toContain("Example: an AI assistant drafting a WhatsApp campaign with AiDwar");
    expect(html).not.toContain("<img");
  });

  it("the demo's motion is transform/opacity with a reduced-motion path; no tracked capitals or middle dots", () => {
    const demos = src("components/site-v2/demos.tsx");
    const demo = demos.slice(demos.indexOf("AI assistant (Batch 52)"));
    expect(demo).toContain("prefersReducedMotion()");
    expect(demo).toContain("nd-slide-in");
    expect(demo).not.toMatch(/transition-all|uppercase|tracking-wide| · /);
  });

  it("every plan on the new pricing lists Connect your AI assistant", () => {
    const pricing = src("components/site-v2/new-pricing.tsx");
    expect(pricing).toContain("Connect your AI assistant");
    // Inside the per-plan list, after each plan's own highlights.
    expect(pricing.indexOf("Connect your AI assistant")).toBeGreaterThan(pricing.indexOf("plan.highlights.map"));
  });

  it("the classic landing and pricing don't change", () => {
    for (const f of ["routes/index.tsx", "routes/pricing.tsx", "components/marketing/landing-copy.ts"]) {
      expect(src(f)).not.toMatch(/MCP|AI assistant/);
    }
  });
});
