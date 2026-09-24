import { describe, expect, it, vi } from "vitest";
import { getScript } from "@/lib/scripts.server";
import { SCRIPTS } from "@/lib/scripts";

const vars = { first_name: "Priya", persona: "Aiden", business: "Zoori" };
const expected = SCRIPTS.day_one_intro.text
  .replace("{first_name}", "Priya")
  .replace("{persona}", "Aiden")
  .replace("{business}", "Zoori");

describe("getScript fallbacks", () => {
  it("missing row → exact default", async () => {
    const text = await getScript(null, "day_one_intro", vars, { load: async () => null });
    expect(text).toBe(expected);
  });

  it("slow lookup (>800 ms) → exact default", async () => {
    vi.useFakeTimers();
    const pending = getScript(null, "day_one_intro", vars, {
      load: () => new Promise((resolve) => setTimeout(() => resolve("Hello {first_name}, custom"), 5000)),
    });
    await vi.advanceTimersByTimeAsync(801);
    expect(await pending).toBe(expected);
    vi.useRealTimers();
  });

  it("unfilled {first_name} → exact default", async () => {
    const text = await getScript(null, "day_one_intro", vars, {
      load: async () => "Hi {first_name}, I'm {persona} and I know {nickname}.",
    });
    expect(text).toBe(expected);
  });

  it("lookup error and blank text → exact default", async () => {
    expect(await getScript(null, "fact_saved", {}, { load: async () => { throw new Error("db down"); } })).toBe(
      SCRIPTS.fact_saved.text,
    );
    expect(await getScript(null, "fact_saved", {}, { load: async () => "   " })).toBe(SCRIPTS.fact_saved.text);
  });

  it("saved text is used when valid", async () => {
    const text = await getScript(null, "day_one_intro", vars, { load: async () => "{first_name}, {persona} is here." });
    expect(text).toBe("Priya, Aiden is here.");
  });
});
