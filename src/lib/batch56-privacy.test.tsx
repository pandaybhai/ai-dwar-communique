import type { ComponentType, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * Batch 56 — the privacy words for AI assistants: /privacy gains "AI
 * assistants you connect" (dated), the /ai-assistants FAQ has the short
 * version, and the consent page says who processes what the app reads. No
 * certification is claimed anywhere.
 */

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
}));
vi.mock("@/hooks/use-session", () => ({ useSession: () => ({ session: null, loading: false }) }));
vi.mock("@/lib/new-site", async (orig) => ({
  ...(await orig<typeof import("./new-site")>()),
  useSitePreviewSearch: () => ({}),
  useSiteSurface: () => undefined,
  useNewSite: () => false,
}));

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const NO_CLAIMS = /ISO ?27001|SOC ?2|HIPAA|certified|certification|GDPR[- ]compliant/i;

describe("/privacy: AI assistants you connect", () => {
  it("renders the dated section with what is read, who processes it, confirmation, disconnecting and the admin switch", async () => {
    const { Route } = (await import("@/routes/privacy")) as unknown as { Route: { options: { component: ComponentType & { preload?: () => Promise<void> } } } };
    await Route.options.component.preload?.();
    const Page = Route.options.component;
    const t = text(renderToStaticMarkup(<Page />));
    expect(t).toContain("Effective date: October 30, 2026");
    expect(t).toContain("5. AI assistants you connect");
    expect(t).toContain("Added on October 30, 2026.");
    for (const words of [
      "only workspace data that member can already see in AiDwar",
      "only what the AiDwar tools return",
      "processed under that company's own terms and privacy policy, not ours",
      "Anthropic, OpenAI or Cursor",
      "always needs the member's confirmation first",
      "on the AI assistants page in AiDwar",
      "A workspace owner or admin can switch AI assistants off for the whole workspace",
      "it can't be used to read our database directly",
    ])
      expect(t, words).toContain(words);
    // Numbered once each, in order, with the old sections moved down by one.
    const headings = [...t.matchAll(/\b(\d{1,2})\. [A-Z]/g)].map((m) => Number(m[1]));
    expect(headings).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(t).toContain("12. Updates to this policy");
    expect(t).toContain("AI assistants a member connects (Section 5)");
    expect(t).not.toMatch(NO_CLAIMS);
  });
});

describe("/ai-assistants FAQ", () => {
  it("has the short version, pointing at the privacy policy", async () => {
    const { AiAssistantsPublic, FAQ } = await import("@/components/site-v2/ai-assistants-public");
    const data = FAQ.find((f) => f.q === "What happens to my data?");
    expect(data).toBeTruthy();
    expect(data!.a).toMatch(/processed by the company behind your assistant \(for example Anthropic, OpenAI or Cursor\) under that company's own terms/);
    expect(data!.a).toContain("Nothing is sent or switched on without your yes.");
    expect(data!.a).toContain("AI assistants page");
    expect(data!.a).toContain("an owner or admin can switch AI assistants off for the whole workspace");
    expect(data!.a).toContain("Privacy Policy");
    const t = text(renderToStaticMarkup(<AiAssistantsPublic />));
    expect(t).toContain("What happens to my data?");
    expect(t).toContain(data!.a);
    expect(t).not.toMatch(NO_CLAIMS);
  });
});

describe("the consent page", () => {
  it("says the app's own company processes what it reads, by the app's name", async () => {
    const { consentProcessingLine } = await import("./oauth-consent");
    expect(consentProcessingLine("Claude")).toBe("Data this app reads is processed by Claude under its own terms.");
    const { ConsentView } = await import("../routes/oauth.consent");
    const html = renderToStaticMarkup(
      <ConsentView
        step={{
          kind: "details",
          details: {
            authorizationId: "auth_12345678",
            clientName: "ChatGPT",
            clientUri: null,
            redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
            redirectDomain: "chatgpt.com",
            scopes: ["openid"],
            userEmail: "owner@meezoy.example",
          },
        }}
      />,
    );
    const t = text(html);
    expect(t).toContain("Data this app reads is processed by ChatGPT under its own terms.");
    expect(html).toContain('href="/privacy"');
  });
});
