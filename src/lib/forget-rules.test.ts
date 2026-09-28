import { describe, expect, it } from "vitest";
import { planForget } from "./forget-rules";

const site = Array.from({ length: 186 }, (_, i) => `https://shop.example.com/page-${i}`);

describe("planForget on a 186-page site", () => {
  it("partial read (15 pages seen) forgets nothing", () => {
    const plan = planForget({ existing: site, fullReadComplete: false, siteMap: site.slice(0, 15), gone: [] });
    expect(plan).toEqual({ remove: [], skipped: "partial_read", candidates: 0 });
  });

  it("full read with a truncated site map is capped at 20% and skipped", () => {
    const plan = planForget({ existing: site, fullReadComplete: true, siteMap: site.slice(0, 15), gone: [] });
    expect(plan.skipped).toBe("over_cap");
    expect(plan.remove).toHaveLength(0);
    expect(plan.candidates).toBe(171);
  });

  it("full read removes only 404/410 pages and pages gone from the map", () => {
    const gone = [site[3]!, site[4]!];
    const map = site.filter((u) => u !== site[10]);
    const plan = planForget({ existing: site, fullReadComplete: true, siteMap: map, gone });
    expect(plan.skipped).toBeNull();
    expect(plan.remove.sort()).toEqual([site[3], site[4], site[10]].sort());
  });

  it("exactly 20% (37 pages) is allowed, 38 is not", () => {
    const ok = planForget({ existing: site, fullReadComplete: true, siteMap: site.slice(37), gone: [] });
    expect(ok.remove).toHaveLength(37);
    const no = planForget({ existing: site, fullReadComplete: true, siteMap: site.slice(38), gone: [] });
    expect(no.skipped).toBe("over_cap");
  });

  it("ignores trailing slash / www / hash differences", () => {
    const plan = planForget({
      existing: ["https://www.shop.example.com/a/"],
      fullReadComplete: true,
      siteMap: ["https://shop.example.com/a#top"],
      gone: [],
    });
    expect(plan.remove).toHaveLength(0);
  });
});
