import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CoverageLine } from "@/components/employee/knowledge-manager";
import type { KnowledgeSource } from "./employee-client";

/** Batch 13B: the website card's coverage line — products by shelf, photo-less count, Add answer for what's missing. */
const source = (reading: Partial<NonNullable<KnowledgeSource["reading"]>>): KnowledgeSource => ({
  id: "s",
  type: "website",
  name: "www.myzoori.com",
  status: "ready",
  item_count: 497,
  last_synced_at: null,
  last_error: null,
  reading: {
    unread: 0,
    plan_cap: 200,
    paid: true,
    tonight: 0,
    refresh_days: 7,
    can_read_more: false,
    changes_available_at: null,
    ...reading,
  },
});

describe("coverage line", () => {
  it("shows shelves, products without a photo, and ✓/✗ with Add answer only for what's missing", () => {
    const markup = renderToStaticMarkup(
      <CoverageLine
        source={source({
          coverage: { faq: true, shipping: true, returns: false, size_guide: true, contact: true },
          products_by_category: { rings: 120, earrings: 80, necklaces: 40, chains: 12 },
          products_without_photo: 3,
        })}
        onAddAnswer={() => undefined}
      />,
    );
    expect(markup).toContain("rings 120 · earrings 80 · necklaces 40 · chains 12");
    expect(markup).toContain("3 products without a photo");
    expect(markup).toContain("Returns ✗");
    expect(markup).toContain("FAQ ✓");
    expect(markup.match(/Add answer/g)).toHaveLength(1);
  });

  it("no Add answer for someone who can't change knowledge; nothing while reading", () => {
    const quiet = renderToStaticMarkup(<CoverageLine source={source({ coverage: { faq: false } })} />);
    expect(quiet).not.toContain("Add answer");
    const reading = renderToStaticMarkup(<CoverageLine source={{ ...source({ coverage: { faq: true } }), status: "syncing" }} />);
    expect(reading).toBe("");
  });
});
