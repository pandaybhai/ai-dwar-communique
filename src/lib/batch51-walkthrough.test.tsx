import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AUDIENCES,
  ExampleChat,
  HeroExample,
  MODES,
  ProductProof,
} from "@/components/marketing/product-proof";
import { ExampleChatNew, ProductProofNew } from "@/components/site-v2/proof-v2";

/**
 * Batch 51, gap 5 — "Pick a question. See how it would be handled." on the
 * new landing (new_site) in the new design. The current landing's walkthrough
 * renders exactly as on main (the hashes below are main's markup), the new one
 * shares its state and every word, and only NewLanding uses it.
 */

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

describe("new_site off: the current landing's walkthrough is unchanged", () => {
  it("renders byte for byte as on main, for every business type, the hero and a draft", () => {
    const main: Record<string, string> = {
      retail: "5ffc8763696585a4aa0b6b002899b0a119302a26b1328d40c3c910d6c4355096",
      services: "5729e207f9e9320b50cac0a176b13fa50d5935c4c0d6699e968eac01643dfec6",
      growing: "37a7f12146b6507b35a910e59cc2f788c117695f71364e2eea22362a3c49b155",
    };
    for (const a of ["retail", "services", "growing"] as const)
      expect([
        a,
        sha(renderToStaticMarkup(<ProductProof audience={a} onAudienceChange={() => {}} />)),
      ]).toEqual([a, main[a]]);
    expect(sha(renderToStaticMarkup(<HeroExample onSeeMore={() => {}} />))).toBe(
      "cc0774b233e8d73f818ca10155480f47711bd8ae146eaa75fca4128339512daa",
    );
    expect(
      sha(renderToStaticMarkup(<ExampleChat example={AUDIENCES[0]!.examples[1]!} mode="draft" />)),
    ).toBe("26fc60c1d30a974d9b56bee2e1cb20285e3781ec66d6a5e9f3de8f1eae04e0e2");
  });

  it("the classic landing still uses ProductProof; only the new landing uses the new look", () => {
    const classic = readFileSync("src/routes/index.tsx", "utf8");
    expect(classic).toContain(
      "<ProductProof audience={audience} onAudienceChange={setAudience} />",
    );
    expect(classic).not.toContain("ProductProofNew");
    const landing = readFileSync("src/components/site-v2/new-landing.tsx", "utf8");
    expect(landing).toContain(
      "<ProductProofNew audience={audience} onAudienceChange={setAudience} />",
    );
    // The classic file never pulls in the new design's pieces.
    expect(readFileSync("src/components/marketing/product-proof.tsx", "utf8")).not.toMatch(
      /from "@\/components\/(design-v2|site-v2)/,
    );
  });
});

describe("new_site on: the same walkthrough in the new design", () => {
  it("same words: heading, intro, tabs, blurb, questions, modes and controls", () => {
    for (const a of AUDIENCES) {
      const classic = text(
        renderToStaticMarkup(<ProductProof audience={a.id} onAudienceChange={() => {}} />),
      );
      const next = text(
        renderToStaticMarkup(<ProductProofNew audience={a.id} onAudienceChange={() => {}} />),
      );
      // Server render: the chat's bubbles appear after mount in both; everything else is word for word.
      expect(next).toBe(classic.replace(" AD ", " "));
      for (const e of a.examples) expect(next).toContain(`“${e.question}”`);
    }
    for (const m of MODES)
      expect(
        renderToStaticMarkup(<ProductProofNew audience="retail" onAudienceChange={() => {}} />),
      ).toContain(m.label);
  });

  it("the new look: porcelain wall, WhatsApp bubbles, Aiden's orb, tokens only", () => {
    const html = renderToStaticMarkup(
      <ExampleChatNew example={AUDIENCES[0]!.examples[0]!} mode="replying" />,
    );
    expect(html).toContain("nd-wall");
    expect(html).toContain("nd-orb-core");
    expect(html).toContain("AI is replying");
    expect(html).not.toMatch(/teal|from-primary|bg-gradient/);
    const code = readFileSync("src/components/site-v2/proof-v2.tsx", "utf8");
    expect(code).not.toMatch(/transition-all|#[0-9a-f]{3,6}\b|teal-/i);
    expect(code).toContain("focus-visible:outline-2");
    expect(code).toContain("useProductProof(audience)");
    expect(code).toContain("useShownSteps(example, mode)");
    // The orb follows the mode, as the classic header's status line does.
    expect(
      renderToStaticMarkup(<ExampleChatNew example={AUDIENCES[0]!.examples[0]!} mode="off" />),
    ).toContain("nd-orb-off");
    expect(
      renderToStaticMarkup(<ExampleChatNew example={AUDIENCES[0]!.examples[0]!} mode="draft" />),
    ).toContain("AI is drafting for approval");
  });
});
