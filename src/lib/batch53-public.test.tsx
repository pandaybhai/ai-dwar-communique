import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Batch 53 — aidwar.in/ai-assistants, the public page for merchants. It
 * renders for a logged-out visitor whatever the new_site switch says, uses
 * the same steps, prompts and safety words as the app, names products as
 * text only, and is linked from /developers, the footer and the new_site
 * landing, with its own SEO title and a sitemap entry.
 */

vi.mock("@/hooks/use-session", () => ({ useSession: () => ({ session: null, loading: false }) }));
vi.mock("@/lib/new-site", async (orig) => ({
  ...(await orig<typeof import("./new-site")>()),
  useSitePreviewSearch: () => ({}),
  useSiteSurface: () => undefined,
  useNewSite: () => false,
}));
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-router")>()),
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

const src = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");

describe("/ai-assistants", () => {
  it("renders logged out (new_site off): hero, demo, 3 steps, prompts, safety, FAQ, CTAs", async () => {
    const { AiAssistantsPublic, FAQ } = await import("@/components/site-v2/ai-assistants-public");
    const html = renderToStaticMarkup(<AiAssistantsPublic />);
    const t = text(html);
    expect(t).toContain("Run WhatsApp marketing from Claude, ChatGPT, Codex or Cursor");
    expect(html).toContain("Example: an AI assistant drafting a WhatsApp campaign with AiDwar");
    expect(t).toContain("Connected in three steps");
    expect(t).toContain("https://aidwar.in/mcp");
    const { LIBRARY_PROMPTS } = await import("./mcp-prompts");
    for (const p of LIBRARY_PROMPTS) expect(t).toContain(p.text);
    const { MCP_SAFETY } = await import("./mcp-connect");
    for (const line of MCP_SAFETY) expect(t).toContain(line.replace(/'/g, "'"));
    expect(FAQ.map((f) => f.q)).toEqual([
      "Which AI apps work with AiDwar?",
      "Which plans do I need?",
      "Is it safe?",
      "How do I disconnect it?",
    ]);
    for (const f of FAQ) expect(t).toContain(f.q);
    expect(html).toContain('href="/signup"');
    expect(html).toContain('href="/demo"');
    expect(t).toContain("Start free");
    expect(t).toContain("Book a demo");
    // Logged out: the header offers Log in, not the dashboard.
    expect(t).toContain("Log in");
    expect(html).not.toContain("<img");
  });

  it("the plan notes come from the same place as the app's connect steps", async () => {
    const { FAQ } = await import("@/components/site-v2/ai-assistants-public");
    const plans = FAQ.find((f) => f.q === "Which plans do I need?")!.a;
    expect(plans).toMatch(/Claude allows one custom connector on its Free plan/);
    expect(plans).toMatch(/ChatGPT allows custom connectors on Business and Enterprise\/Edu/);
    expect(src("components/site-v2/ai-assistants-public.tsx")).toContain("<PromptLibrary");
    expect(src("components/site-v2/ai-assistants-public.tsx")).toContain("<ConnectSteps");
  });

  it("doesn't depend on new_site, has its SEO title and description, and is in the sitemap", () => {
    const route = src("routes/ai-assistants.tsx");
    expect(route).not.toContain("useNewSite");
    expect(route).toContain("PUBLIC_TITLE");
    expect(route).toContain('rel: "canonical", href: "https://aidwar.in/ai-assistants"');
    expect(src("routes/sitemap[.]xml.ts")).toContain('{ path: "/ai-assistants"');
  });

  it("is linked from /developers, the footer and the new_site landing's Works-with section", () => {
    expect(src("components/developers/mcp-section.tsx")).toContain('href="/ai-assistants"');
    expect(src("components/site-footer.tsx")).toContain('{ to: "/ai-assistants", label: "AI assistants" }');
    const landing = src("components/site-v2/new-landing.tsx");
    const works = landing.slice(landing.indexOf("Works with Claude"));
    expect(works.slice(0, 2000)).toContain('href="/ai-assistants"');
  });

  it("follows the Hallmark floor: tokens, no tracked capitals or middle dots, focus-visible, no transition-all", () => {
    const s = src("components/site-v2/ai-assistants-public.tsx");
    expect(s).not.toMatch(/transition-all|uppercase|tracking-wide|#[0-9a-fA-F]{6}\b| · |<Reveal/);
    expect(s).toContain("focus-visible:");
    // The one animation is the Batch 52 demo, which shows everything at once with reduced motion.
    expect(src("components/site-v2/demos.tsx")).toContain("prefersReducedMotion()");
  });
});
