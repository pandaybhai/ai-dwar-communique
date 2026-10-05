import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Batch 10A, UI: with cards switched off for a workspace, no card UI appears
 * anywhere (inbox button, campaign / flow picker); with cards on, the inbox
 * button shows, and outside the 24-hour window it is disabled with the reason.
 */

const h = vi.hoisted(() => ({ cards: false, perms: new Set<string>(["inbox.reply"]) }));
vi.mock("@/hooks/use-feature-flag", () => ({
  useFeatureFlag: (key: string) => ({ enabled: key === "cards" ? h.cards : false, loading: false }),
}));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ can: (k: string) => h.perms.has(k), loading: false }),
}));

import { SendCardButton, CARD_WINDOW_CLOSED } from "@/components/inbox/send-card-button";
import { CardAttachmentPicker } from "@/components/cards/card-attachment-picker";
import { CardPreview } from "@/components/cards/card-preview";

beforeEach(() => {
  h.cards = false;
  h.perms = new Set(["inbox.reply"]);
});

const inbox = (windowOpen: boolean) =>
  renderToStaticMarkup(<SendCardButton organizationId="org" conversationId="cv1" windowOpen={windowOpen} />);
const picker = () =>
  renderToStaticMarkup(
    <CardAttachmentPicker idPrefix="campaign" value={{ kind: "customer_offer", vars: { headline: "Sale" } }} onChange={() => {}} organizationId="org" explanation="x" />,
  );

describe("cards off: no card UI anywhere", () => {
  it("inbox: no Send card button, inside or outside the window", () => {
    expect(inbox(true)).toBe("");
    expect(inbox(false)).toBe("");
  });
  it("campaign / flow card picker renders nothing", () => {
    expect(picker()).toBe("");
  });
});

describe("cards on", () => {
  beforeEach(() => {
    h.cards = true;
  });
  it("inbox inside the window: the Send card button", () => {
    expect(inbox(true)).toContain('aria-label="Send card"');
  });
  it("inbox outside the window: disabled, saying why", () => {
    const html = inbox(false);
    expect(html).toContain("disabled");
    expect(html).toContain(CARD_WINDOW_CLOSED.replace(/'/g, "&#x27;"));
  });
  it("no permission to reply: no button", () => {
    h.perms = new Set();
    expect(inbox(true)).toBe("");
  });
  it("campaign picker: explanation and a live preview of the chosen card", () => {
    const html = picker();
    expect(html).toContain("Add a picture card (optional)");
    expect(html).toContain('aria-label="Offer card preview"');
    expect(html).toContain("Sale");
  });
  it("preview shows a Product card's photo only for an https link", () => {
    expect(renderToStaticMarkup(<CardPreview kind="customer_product" vars={{ name: "Ring", image_url: "https://x.in/r.jpg" }} />)).toContain('src="https://x.in/r.jpg"');
    expect(renderToStaticMarkup(<CardPreview kind="customer_product" vars={{ name: "Ring", image_url: "http://x.in/r.jpg" }} />)).not.toContain("<img");
  });
});
