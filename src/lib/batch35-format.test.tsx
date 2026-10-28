import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  formattingProblems,
  parseInline,
  prefixLines,
  stripWhatsAppFormatting,
  wrapSelection,
  type InlineAction,
} from "./wa-format";
import { emptyDraft, extractVariables, validateDraft } from "./templates";
import { WhatsAppText } from "@/components/whatsapp-text";
import { TemplatePreview } from "@/components/templates/template-preview";

/**
 * Batch 35 item 2 — WhatsApp formatting in templates: the toolbar wraps the
 * selection in WhatsApp's markers and never breaks a {{n}}; validation
 * catches unclosed markers and a marker inside a variable; the preview, the
 * inbox and the template picker show the formatting like WhatsApp does.
 */

const src = (path: string) => readFileSync(join(import.meta.dirname, "..", path), "utf8");

describe("the toolbar never breaks a {{n}}", () => {
  const text = "Hi {{1}}, your order {{2}} ships on {{3}}. Thanks!";
  const actions: InlineAction[] = ["bold", "italic", "strike", "mono"];

  it("every possible selection, every style: the variables survive whole and no marker lands inside one", () => {
    for (const action of actions) {
      for (let s = 0; s <= text.length; s++) {
        for (let e = s; e <= text.length; e++) {
          const out = wrapSelection(text, s, e, action);
          expect(extractVariables(out.text)).toEqual([1, 2, 3]);
          expect(out.text.match(/\{\{\s*\d+\s*\}\}/g)).toEqual(["{{1}}", "{{2}}", "{{3}}"]);
          expect(formattingProblems(out.text).filter((p) => p.includes("inside"))).toEqual([]);
        }
      }
    }
  });

  it("a selection edge inside {{1}} moves to the variable's edge", () => {
    // "Hi {{1}}" with the selection starting inside the braces.
    expect(wrapSelection("Hi {{1}} there", 4, 14, "bold").text).toBe("Hi *{{1}} there*");
    expect(wrapSelection("Hi {{1}} there", 0, 5, "italic").text).toBe("_Hi {{1}}_ there");
  });

  it("wraps, keeps edge spaces outside, and a second press takes the markers off", () => {
    const once = wrapSelection("Big sale today", 4, 9, "bold");
    expect(once.text).toBe("Big *sale* today");
    expect(wrapSelection(once.text, once.start, once.end, "bold").text).toBe("Big sale today");
    expect(wrapSelection("Big sale today", 3, 9, "strike").text).toBe("Big ~sale~ today");
    expect(wrapSelection("code", 0, 4, "mono").text).toBe("```code```");
  });

  it("lists and quotes go on every selected line, numbered in order, and come off again", () => {
    const t = "Rings\nBangles\nEarrings";
    const bullets = prefixLines(t, 0, t.length, "bullet");
    expect(bullets.text).toBe("- Rings\n- Bangles\n- Earrings");
    expect(prefixLines(bullets.text, 0, bullets.text.length, "bullet").text).toBe(t);
    expect(prefixLines(t, 0, t.length, "number").text).toBe("1. Rings\n2. Bangles\n3. Earrings");
    expect(prefixLines(t, 7, 9, "quote").text).toBe("Rings\n> Bangles\nEarrings");
  });
});

describe("checks before submit", () => {
  it("an unclosed marker or a marker inside a variable is named in plain words", () => {
    expect(formattingProblems("Hi *friend, welcome")[0]).toMatch(/bold \* that is never closed/);
    expect(formattingProblems("Hi _friend")[0]).toMatch(/italic _/);
    expect(formattingProblems("Hi ~friend")[0]).toMatch(/strikethrough ~/);
    expect(formattingProblems("See ```this")[0]).toMatch(/``` that is never closed/);
    expect(formattingProblems("Hi {{*1}} there")[0]).toMatch(/inside \{\{\*1\}\}/);
  });

  it("ordinary text stays clean: snake_case, emails, maths, bullets, closed pairs", () => {
    for (const ok of [
      "Hi {{1}}, your code is order_123_abc",
      "Write to help_desk@shop.in today",
      "Pay 2*3 instalments",
      "* Rings\n* Bangles",
      "*Big* _sale_ ~old~ ```NEW``` and *{{1}}* too",
      "5 * 3 = 15",
    ]) {
      expect(formattingProblems(ok)).toEqual([]);
    }
  });

  it("validateDraft refuses a broken body and a styled text header", () => {
    const draft = {
      ...emptyDraft(),
      name: "sale",
      category: "MARKETING" as const,
      body: "Hi *friend {{1}} there",
      bodyExamples: { 1: "Asha" },
    };
    expect(validateDraft(draft as never).some((p) => p.includes("never closed"))).toBe(true);
    const fixed = { ...draft, body: "Hi *friend* {{1}} there" };
    expect(validateDraft(fixed as never).some((p) => p.includes("never closed"))).toBe(false);
    const header = { ...fixed, headerFormat: "TEXT", headerText: "*Sale*" };
    expect(validateDraft(header as never)).toContain(
      "A text header can't use * _ ~ ` formatting — Meta doesn't allow it there.",
    );
  });
});

describe("shown like WhatsApp", () => {
  it("bold, italic, strikethrough, monospace, inline code, nesting", () => {
    const html = renderToStaticMarkup(
      <WhatsAppText text={"*Big* _sale_ ~old~ ```NEW``` `code` *_both_*"} />,
    );
    expect(html).toContain('<strong class="font-semibold">Big</strong>');
    expect(html).toContain("<em>sale</em>");
    expect(html).toContain("<s>old</s>");
    expect(html).toMatch(/<code[^>]*>NEW<\/code>/);
    expect(html).toMatch(/<code[^>]*>code<\/code>/);
    expect(html).toContain('<strong class="font-semibold"><em>both</em></strong>');
    expect(parseInline("order_123_abc")).toEqual([{ text: "order_123_abc" }]);
  });

  it("lists and quotes", () => {
    const html = renderToStaticMarkup(<WhatsAppText text={"- one\n2. two\n> said"} />);
    expect(html).toContain("•");
    expect(html).toContain("2.");
    expect(html).toContain("border-l-2");
    expect(stripWhatsAppFormatting("*Big* _sale_\n- one")).toBe("Big sale\n• one");
  });

  it("the template preview, the inbox bubble and the picker all render it", async () => {
    const preview = renderToStaticMarkup(
      <TemplatePreview
        model={{
          header: null,
          body: "Hello *Asha*",
          footer: "",
          buttons: [],
          cards: [],
          offer: null,
        }}
      />,
    );
    expect(preview).toContain('<strong class="font-semibold">Asha</strong>');

    const { Bubble } = await import("@/components/inbox/chat-thread");
    const bubble = renderToStaticMarkup(
      <Bubble
        message={
          {
            id: "m",
            conversation_id: "c",
            direction: "inbound",
            type: "text",
            body: "I want the _gold_ one",
            status: "received",
            created_at: "2026-10-28T10:00:00Z",
            media_url: null,
            metadata: null,
          } as never
        }
        organizationId="org"
        agentName="Aiden"
      />,
    );
    expect(bubble).toContain("<em>gold</em>");

    const picker = src("components/templates/template-picker-dialog.tsx");
    expect(picker).toMatch(/<WhatsAppText text=\{renderTemplate\(body, values\)\} \/>/);
    expect(picker).toMatch(/<WhatsAppText text=\{templateBodyText\(t\.components\)\} \/>/);
  });
});
